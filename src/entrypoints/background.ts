/**
 * Service Worker：维护标签页上下文、转发固定动作（字幕、播放控制、抓帧）。
 * 本地语音转写在扩展离屏文档中采集标签页音频，再交给本机 Whisper 服务；
 * 聊天 Key 只用于总结与翻译，绝不用于音频转写，也不发往云端。
 */
import { defineBackground } from 'wxt/utils/define-background';
import { buildPlayerInfoUrl, classifyTracks, fetchSubtitleBody, parseTrackResponse } from '../adapters/bilibili';
import { appError, toAppError, type AppError } from '../domain/errors';
import { normalizeEndpoint } from '../domain/endpoint';
import { cuesFromAsrSegments, hashTranscript, inferGenerationKind } from '../domain/transcript';
import { saveTranscript } from '../storage/db';
import { deriveWebVideoIdentity, parseBilibiliVideoUrl, videoIdOf, videoRecordId, type VideoPlatform } from '../domain/video';
import { isPlaybackForContext, isTrustedExtensionSender, PROTOCOL_VERSION, type CapturedFrame, type RuntimeResponse, type TabContext, type VideoState } from '../lib/messages';
import { safeUrl, vsLog } from '../lib/log';
import { loadSettings, restrictStorageAccess } from '../storage/settings';
import { getDb, latestSummary } from '../storage/db';
import { autoSummaryService } from '../jobs/auto-summary-service';
import { fullSummaryProgress, previewFullSummary, startFullSummary } from '../jobs/full-summary-service';
import { silentBootstrap } from '../jobs/auto-caption';
import { AUTO_SUMMARY_PORT } from '../lib/auto-summary';
import {
  ASR_OFFSCREEN_TARGET, ASR_BACKGROUND_TARGET, ASR_EVENT_TYPE, ASR_CAPTURE_CHUNK_MS,
  describeNoSpeech, type CaptureEvent, type LocalAsrState,
} from '../asr/tab-protocol';
import { checkLocalWhisper } from '../asr/local-whisper';
import type { TranscriptionSegment } from '../asr/client';

const TAB_CONTEXTS = new Map<number, TabContext>();
const TAB_STATES = new Map<number, VideoState>();
/** 当前本地转写会话（同一时间只允许一个）。 */
let localAsr: LocalAsrState | null = null;
let asrSegments: TranscriptionSegment[] = [];

/** 创建（或复用）扩展离屏文档；tabCapture 的 getUserMedia 必须在扩展文档中建立。 */
async function ensureAsrDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument().catch(() => false);
  if (existing) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: '采集用户正在观看的标签页音频，交给本机 Whisper 转写为字幕',
  });
}

/** 分片序号用于去重：离屏文档重试上报不会重复累加同一片。 */
const asrSeen = new Set<number>();

/**
 * 转写会话持久化键。
 *
 * 为什么必须持久化：`localAsr` / `asrSegments` 只是模块级内存变量，
 * Service Worker 被回收（浏览器关闭、扩展重载、空闲休眠）后全部归零，
 * 用户重开弹窗就看到进度清零、已转写的字消失。
 * 这里把会话状态与已完成的字幕段一起写进 `storage.session`，
 * 唤醒后可恢复显示与继续累加。
 */
const ASR_SESSION_KEY = 'asr.session.v1';

/**
 * 仅供测试：清掉模块级转写内存态，模拟 Service Worker 被回收。
 * 生产代码不会调用它——真实回收时整个模块本来就会重新求值。
 */
export function resetAsrForTests(): void {
  localAsr = null;
  asrSegments = [];
  asrSeen.clear();
}

interface PersistedAsr {
  state: LocalAsrState;
  segments: TranscriptionSegment[];
  seen: number[];
}

/** 写会话快照；失败不影响主流程（内存态仍可继续）。 */
async function persistAsr(): Promise<void> {
  if (!localAsr) return;
  const area = chrome.storage?.session;
  if (!area) return;
  const snapshot: PersistedAsr = { state: localAsr, segments: asrSegments, seen: [...asrSeen] };
  try {
    await area.set({ [ASR_SESSION_KEY]: snapshot });
  } catch {
    /* session 不可用时仅保留内存副本。 */
  }
}

/**
 * 从 `storage.session` 恢复会话。
 * 只恢复「仍在进行或已完成待展示」的会话；已失败超过一天的不再恢复，避免长期残留。
 */
async function restoreAsr(): Promise<void> {
  if (localAsr) return;
  const area = chrome.storage?.session;
  if (!area) return;
  try {
    const stored = await area.get(ASR_SESSION_KEY);
    const snapshot = stored[ASR_SESSION_KEY] as PersistedAsr | undefined;
    if (!snapshot?.state?.id) return;
    if (snapshot.state.status === 'failed' && Date.now() - snapshot.state.updatedAt > 24 * 60 * 60_000) {
      await area.remove(ASR_SESSION_KEY).catch(() => undefined);
      return;
    }
    // 恢复出来的「录音中/转写中」已经没有对应的离屏录音：
    // 不伪装成仍在进行，标成中断，并把中断前已完成的分片立即落成一个字幕版本。
    if (['starting', 'recording', 'transcribing'].includes(snapshot.state.status)) {
      const kept = (snapshot.segments ?? []).filter((item) => Number.isFinite(item.startMs) && item.text);
      localAsr = {
        ...snapshot.state,
        status: kept.length > 0 ? 'completed' : 'failed',
        queuedChunks: 0,
        updatedAt: Date.now(),
        warnings: [...(snapshot.state.warnings ?? []), '采集被浏览器中断，已保留中断前完成的字幕'],
        error: kept.length > 0 ? undefined : appError('CAPTURE_UNAVAILABLE', '上次音频采集被中断', {
          detail: '后台被浏览器回收会停止录音。中断前没有任何完成的分片，请重新开始。',
        }),
      };
      asrSegments = kept;
      asrSeen.clear();
      for (const index of Array.isArray(snapshot.seen) ? snapshot.seen : []) asrSeen.add(index);
      if (kept.length > 0) {
        try {
          const cues = cuesFromAsrSegments([...kept].sort((a, b) => a.startMs - b.startMs));
          const { revision } = await saveTranscript({
            videoId: snapshot.state.videoId, language: 'auto', sourceKind: 'asr', generationKind: 'ai',
            trackLabel: `本地转写（中断恢复） · ${snapshot.state.model}`.slice(0, 120),
            sourceHash: hashTranscript(cues), cues,
          });
          localAsr = { ...localAsr, transcriptId: revision.id };
          vsLog.info('asr:restored-committed', { cues: cues.length });
        } catch (cause) {
          vsLog.warn('asr:restore-commit-failed', { code: toAppError(cause).code });
        }
      }
      await persistAsr();
      return;
    }
    localAsr = { ...snapshot.state, segments: Array.isArray(snapshot.segments) ? [...snapshot.segments].sort((a, b) => a.startMs - b.startMs) : [] };
    asrSegments = Array.isArray(snapshot.segments) ? snapshot.segments : [];
    asrSeen.clear();
    for (const index of Array.isArray(snapshot.seen) ? snapshot.seen : []) asrSeen.add(index);
  } catch {
    /* 读不到就当没有会话。 */
  }
}

/**
 * 处理离屏文档的采集事件。
 * 分片一到就累加并落盘；结束时统一保存一个字幕版本，避免半途落库产生多个残缺版本。
 */
async function handleAsrEvent(id: string, event: CaptureEvent | undefined): Promise<void> {
  if (!event || !localAsr || localAsr.id !== id) return;
  if (event.kind === 'progress') {
    localAsr = { ...localAsr, status: event.recording ? 'recording' : 'transcribing',
      recordedMs: event.recordedMs, completedChunks: event.completedChunks,
      queuedChunks: event.queuedChunks, updatedAt: Date.now() };
    await persistAsr();
    return;
  }
  if (event.kind === 'chunk') {
    if (asrSeen.has(event.index)) return;
    asrSeen.add(event.index);
    asrSegments.push(...event.segments);
    localAsr = { ...localAsr, completedChunks: localAsr.completedChunks + 1, updatedAt: Date.now(),
      // 让弹窗能边采集边显示：不必等到 done 才看到文字。
      segments: [...asrSegments].sort((a, b) => a.startMs - b.startMs) };
    // 「进度在走但一个字不出」时，这行日志是唯一的判据来源。
    vsLog.info('asr:chunk', {
      index: event.index, segments: event.segments.length, silent: event.silent ?? false,
      bytes: event.bytes ?? 0, durationMs: event.durationMs ?? 0, total: asrSegments.length,
    });
    // 每片都落盘：SW 被回收后重开仍能看到已完成的字数与进度。
    await persistAsr();
    return;
  }
  // done：无论成功失败都先关闭离屏文档，释放标签页音频。
  const finished: LocalAsrState = { ...localAsr, status: event.error ? 'failed' : 'completed',
    warnings: event.warnings, error: event.error, evidence: event.evidence, updatedAt: Date.now() };
  localAsr = finished;
  await chrome.offscreen.closeDocument().catch(() => undefined);
  const videoId = finished.videoId;
  const segments = [...asrSegments].sort((a, b) => a.startMs - b.startMs);
  asrSegments = [];
  asrSeen.clear();
  if (event.error || segments.length === 0) {
    if (!event.error) {
      // 没有任何字幕时按采集证据归因：设备切换、数字静音都不能被说成「页面被静音」。
      localAsr = { ...finished, status: 'failed', error: describeNoSpeech(event.evidence) };
    }
    await persistAsr();
    vsLog.warn('asr:done-no-result', {
      code: localAsr?.error?.code ?? 'NO_SPEECH',
      chunks: event.evidence?.chunks ?? 0,
      silentChunks: event.evidence?.silentChunks ?? 0,
      deviceChanged: event.evidence?.deviceChanged ?? false,
      trackEnded: event.evidence?.trackEnded ?? false,
      peak: event.evidence?.peak ?? 0,
      contextRunning: event.evidence?.contextRunning ?? false,
      emptyParts: event.evidence?.emptyParts ?? 0,
      stopKind: event.evidence?.stopKind ?? 'none',
    });
    return;
  }
  try {
    const cues = cuesFromAsrSegments(segments);
    const { revision } = await saveTranscript({
      videoId, language: 'auto', sourceKind: 'asr', generationKind: 'ai',
      trackLabel: `本地转写 · ${finished.model}`.slice(0, 120),
      sourceHash: hashTranscript(cues), cues,
    });
    localAsr = { ...finished, status: 'completed', transcriptId: revision.id };
    vsLog.info('asr:done', { cues: cues.length, chunks: finished.completedChunks });
  } catch (cause) {
    const error = toAppError(cause, 'STORAGE_FAILED', '保存本地转写结果失败');
    localAsr = { ...finished, status: 'failed', error };
    vsLog.warn('asr:done-save-failed', { code: error.code });
  }
  // 终态也落盘：重开弹窗能看到「已完成 + transcriptId」，而不是一片空白。
  await persistAsr();
}

/** 把采集进度同步给离屏文档：暂停/跳转/换速会由录音器自行停止。 */
async function pushSample(tabId: number): Promise<void> {
  // 采集一启动就要把真实播放位置送过去：离屏文档要拿它当连续性基线。
  // 曾经只允许 recording，导致基线只能等 5 秒兜底，期间采样全被丢弃。
  if (!localAsr || !['starting', 'recording'].includes(localAsr.status) || localAsr.tabId !== tabId) return;
  const state = TAB_STATES.get(tabId);
  if (!state) return;
  await chrome.runtime.sendMessage({
    target: ASR_OFFSCREEN_TARGET, type: 'sample',
    payload: {
      positionMs: state.positionMs, durationMs: state.durationMs, paused: state.paused,
      muted: state.muted, volume: state.volume, playbackRate: state.playbackRate,
    },
  }).catch(() => undefined);
}

function contextKey(tabId: number): string {
  return `tab:${tabId}`;
}

async function rememberContext(context: TabContext): Promise<void> {
  TAB_CONTEXTS.set(context.tabId, context);
  try {
    await chrome.storage.session.set({ [contextKey(context.tabId)]: context });
  } catch {
    /* session 不可用时仅保留内存副本。 */
  }
}

async function readContext(tabId: number): Promise<TabContext | undefined> {
  const cached = TAB_CONTEXTS.get(tabId);
  if (cached) return cached;
  try {
    const stored = await chrome.storage.session.get(contextKey(tabId));
    const value = stored[contextKey(tabId)] as TabContext | undefined;
    if (value) TAB_CONTEXTS.set(tabId, value);
    return value;
  } catch {
    return undefined;
  }
}

async function activeTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id ?? null;
}

/** 通用页面脚本：按需注入，不在所有站点常驻。 */
const PAGE_SCRIPT_FILES = ['page-video.js'];
/** 主世界音频录制器：仅音频转写需要。 */
const AUDIO_BRIDGE_FILES = ['content-scripts/audio-bridge.js'];
/**
 * 主世界字幕探针：站点把字幕放在页面脚本里（如 YouTube）时用它代读。
 * 与页面脚本一起注入；失败不影响 `<track>` 通道，因此不计为致命错误。
 */
const CAPTION_PROBE_FILES = ['page-caption-probe.js'];
/** 页面脚本是否已在运行（能应答即说明已注入）。 */
async function pageScriptAlive(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 播放控制的发送目标：确保该标签页里确实有一个能接收播放控制的内容脚本。
 *
 * 为什么需要：`chrome.tabs.sendMessage` 在目标标签页没有监听者时会失败/返回空，
 * 调用方只看到「失败」，用户看到的是「按钮点了没反应」。
 * 这里先探测脚本是否在；不在就按需补注入（B站用常驻内容脚本，其他站点用按需脚本）。
 */
async function ensurePlaybackTarget(tabId: number): Promise<{ ok: true } | { ok: false; error: AppError }> {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab?.url) {
    return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页', { detail: '请刷新页面后重试。' }) };
  }
  if (await pageScriptAlive(tabId)) return { ok: true };
  if (parseBilibiliVideoUrl(tab.url)) {
    return {
      ok: false,
      error: appError('PLAYER_NOT_READY', '播放器脚本尚未就绪', {
        detail: '请等待 B站页面加载完成后重试；若刚更新过扩展，请刷新该页面。',
      }),
    };
  }
  // 非 B站页面：通用脚本是按需注入的，页面刷新 / SPA 跳转 / 扩展更新后会消失，
  // 此时直接失败会让「播放键点了没反应」且看不出原因。
  // 这里补注入一次再重试；补注入后仍不应答，才算真的无法控制。
  const ensured = await ensurePageScript(tabId, tab.url);
  if (!ensured.ok) return ensured;
  if (await pageScriptAlive(tabId)) return { ok: true };
  return {
    ok: false,
    error: appError('PLAYER_NOT_READY', '播放器脚本未能就绪', {
      detail: '已尝试重新注入识别脚本但仍无响应。请刷新该页面后重试。',
    }),
  };
}

/**
 * 确保通用页面脚本已注入。
 * 前提：URL 能推导出通用身份，且用户已授权该站点。
 * 未授权时返回可操作错误（`site-permission:<origin>`），不静默失败，也不自行扩权。
 */
async function ensurePageScript(tabId: number, url: string): Promise<{ ok: true } | { ok: false; error: AppError }> {
  if (await pageScriptAlive(tabId)) return { ok: true };
  const identity = deriveWebVideoIdentity(url);
  if (!identity) {
    return {
      ok: false,
      error: appError('UNSUPPORTED_PAGE', '当前页面不是可识别的视频页', {
        detail: '支持任何使用 HTML5 <video> 的 http(s) 页面；站点首页、搜索结果页不算。',
      }),
    };
  }
  const granted = await chrome.permissions
    .contains({ origins: [`${identity.origin}/*`] })
    .catch(() => false);
  if (!granted) {
    return {
      ok: false,
      error: appError('PERMISSION_DENIED', `尚未授权访问 ${identity.origin}`, {
        detail: `site-permission:${identity.origin}`,
      }),
    };
  }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_SCRIPT_FILES });
    // 同步注入主世界字幕探针：站点把字幕放在页面脚本里时（如 YouTube）才用得上，
    // 失败不致命，`<track>` 通道仍然可用。
    await ensureCaptionProbe(tabId);
  } catch (cause) {
    return { ok: false, error: appError('PLAYER_NOT_READY', '无法在该页面注入识别脚本', { detail: toAppError(cause).message }) };
  }
  return { ok: true };
}

/**
 * 注入主世界字幕探针（YouTube 等把字幕放在页面脚本里的站点需要）。
 * 失败不算致命：`<track>` 通道与其余功能仍可用。
 */
async function ensureCaptionProbe(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: CAPTION_PROBE_FILES });
  } catch (cause) {
    vsLog.warn('capture:caption-probe-failed', { message: toAppError(cause).message });
  }
}

/** 主世界录制器需要单独注入；B站已随扩展自动注入。 */
async function ensureAudioBridge(tabId: number): Promise<{ ok: true } | { ok: false; error: AppError }> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', files: AUDIO_BRIDGE_FILES });
    return { ok: true };
  } catch (cause) {
    return { ok: false, error: appError('PLAYER_NOT_READY', '无法在该页面启动音频录制', { detail: toAppError(cause).message }) };
  }
}

export interface ContextProbe {
  /** 内容脚本是否有应答：应答本身即证明脚本已注入并能通信。 */
  contentScriptAlive: boolean;
  failure?: string | null;
  diag?: Record<string, unknown> | null;
  videoElements?: number;
}

/** 主动要求内容脚本上报上下文，并带回失败原因用于区分提示。 */
async function requestContext(tabId: number): Promise<ContextProbe> {
  try {
    const reply = (await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_CONTEXT' })) as
      | { ok?: boolean; failure?: string | null; diag?: Record<string, unknown>; videoElements?: number }
      | undefined;
    return {
      contentScriptAlive: true,
      failure: reply?.failure ?? null,
      diag: reply?.diag ?? null,
      videoElements: reply?.videoElements,
    };
  } catch (cause) {
    // sendMessage 抛错通常意味着内容脚本未注入（权限不足 / 加载后才打开页面）。
    vsLog.warn('probe:no-receiver', { tabId, message: cause instanceof Error ? cause.message : 'unknown' });
    return { contentScriptAlive: false };
  }
}

/** 把内容脚本回报的失败原因翻译成可操作提示。 */
export function describeSnapshotFailure(failure: string | null | undefined, diag: Record<string, unknown> | null | undefined): AppError {
  const videoElements = typeof diag?.videoElements === 'number' ? diag.videoElements : undefined;
  switch (failure) {
    case 'main-world-unavailable':
      return appError('PLAYER_NOT_READY', '页面数据尚未就绪', {
        detail: '未能读取页面视频数据。请等播放器出现后点“重新识别当前页”。',
      });
    case 'missing-aid':
      return appError('PLAYER_NOT_READY', '视频页数据缺少 aid', {
        detail: '页面结构可能已变化，请重新识别；若持续失败请反馈视频链接。',
      });
    case 'missing-cid':
      return appError('PLAYER_NOT_READY', '未能确定当前分 P', {
        detail: '页面未提供分 P 的 cid，请切换到目标分 P 后重新识别。',
      });
    case 'no-video-element':
      return appError('PLAYER_NOT_READY', '页面里没有可用的播放器', {
        detail: '通用识别依赖 HTML5 <video> 元素；请先让视频开始加载，再点「重新识别当前页」。',
      });
    case 'unsupported-url':
      return appError('UNSUPPORTED_PAGE', '当前页面不是受支持的视频页');
    default:
      return appError('PLAYER_NOT_READY', '尚未检测到可用的播放器信息', {
        detail:
          videoElements === 0
            ? '页面内没有 video 元素，请确认播放器已显示后重试。'
            : '请稍候再试，或点“重新识别当前页”。',
      });
  }
}

function defaultVideoState(positionMs = 0, durationMs = 0): VideoState {
  return { paused: true, muted: false, volume: 1, playbackRate: 1, positionMs, durationMs, ready: false };
}

export default defineBackground(() => {
  void restrictStorageAccess();
  const HEARTBEAT = 'summary-heartbeat';
  const logFailure = (event: string, cause: unknown) => vsLog.warn(event, { code: toAppError(cause).code });
  const ensureHeartbeat = () => {
    void chrome.alarms.get(HEARTBEAT).then(async (existing) => {
      if (!existing) await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 1 });
    }).catch((cause) => logFailure('auto:heartbeat-create-failed', cause));
  };
  const resume = async () => {
    // 升级后不再续跑旧的整片批量请求，已完成结果与笔记全部保留。
    await getDb().jobs.filter((job) => job.type === 'summary' &&
      ['queued', 'running', 'interrupted', 'partial'].includes(job.state))
      .modify({ state: 'paused', updatedAt: new Date().toISOString() });
    await autoSummaryService.resume();
    // 失败段在后台自动重试：不需要弹窗开着，也有次数上限与熔断。
    // 放在 heartbeat 里而不是定时器里，SW 被回收后仍能靠 alarm 唤醒继续。
    await autoSummaryService.retryFailedNodes();
  };
  const resumeSafely = () => { void resume().catch((cause) => logFailure('auto:resume-failed', cause)); };
  chrome.alarms.onAlarm.addListener((alarm) => { if (alarm.name === HEARTBEAT) resumeSafely(); });
  chrome.runtime.onStartup.addListener(() => { ensureHeartbeat(); resumeSafely(); });
  chrome.runtime.onInstalled.addListener(() => { ensureHeartbeat(); resumeSafely(); });
  chrome.tabs.onRemoved.addListener((tabId) => {
    const context = TAB_CONTEXTS.get(tabId);
    const previousId = context?.videoId ?? (context ? videoRecordId(context.bvid, context.cid) : null);
    if (previousId) void autoSummaryService.pausePlayback(previousId)
      .catch((cause) => logFailure('auto:tab-close-failed', cause));
    TAB_CONTEXTS.delete(tabId);
    TAB_STATES.delete(tabId);
    void chrome.storage.session.remove(contextKey(tabId)).catch((cause) => logFailure('context:cleanup-failed', cause));
  });

  let settingsTimer: ReturnType<typeof setTimeout> | undefined;
  const onSettingsChanged = () => {
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(() => {
      void autoSummaryService.settingsChanged().catch((cause) => logFailure('auto:settings-failed', cause));
    }, 100);
  };
  chrome.storage.onChanged.addListener((changes) => {
    if (['settings.v1', 'apiKey.session.v1', 'apiKey.local.v1'].some((key) => key in changes)) onSettingsChanged();
  });
  chrome.permissions.onAdded.addListener(onSettingsChanged);
  chrome.permissions.onRemoved.addListener(onSettingsChanged);

  // SW 可能因空闲/重载被回收：启动时先把上次的转写会话读回来，避免进度清零。
  void restoreAsr().catch((cause) => logFailure('asr:restore-failed', cause));
  // 弹窗端口仅是观察者，disconnect 时绝不能取消后台 SSE。
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== AUTO_SUMMARY_PORT || !port.sender || !isTrustedExtensionSender(port.sender)) return;
    let unsubscribe: (() => void) | undefined;
    port.onMessage.addListener((raw: unknown) => {
      const message = raw as { type?: string; videoId?: unknown } | null;
      if (message?.type !== 'subscribe' || typeof message.videoId !== 'string' || !message.videoId || message.videoId.length > 300) return;
      unsubscribe?.();
      unsubscribe = autoSummaryService.subscribe(message.videoId, (event) => {
        try { port.postMessage(event); } catch { unsubscribe?.(); }
      });
      port.postMessage({ type: 'changed', videoId: message.videoId });
    });
    port.onDisconnect.addListener(() => unsubscribe?.());
  });
  ensureHeartbeat();
  resumeSafely();

  chrome.runtime.onMessage.addListener((rawMessage: unknown, sender, sendResponse) => {
    const message = rawMessage as { type?: string; version?: number; payload?: Record<string, unknown> } | null;
    if (!message?.type) return false;
    // 仅在消息声明了版本时才校验；内容脚本的早期上报可能不带版本，不能因此丢弃。
    if (typeof message.version === 'number' && message.version !== PROTOCOL_VERSION) {
      sendResponse({ ok: false, error: appError('BAD_REQUEST', '协议版本不匹配') } satisfies RuntimeResponse);
      return false;
    }

    // 离屏文档上报的采集事件：只接受本扩展离屏文档，且类型必须与协议常量一致。
    // 这里之前误写成 'ASR_EVENT'，与离屏文档发出的 'event' 不匹配，导致事件被静默丢弃。
    if (message.type === ASR_EVENT_TYPE &&
        (rawMessage as { target?: string }).target === ASR_BACKGROUND_TARGET) {
      const payload = message.payload as { id?: string; event?: CaptureEvent } | undefined;
      void handleAsrEvent(payload?.id ?? '', payload?.event).then(() => sendResponse({ ok: true }))
        .catch(() => sendResponse({ ok: false }));
      return true;
    }

    // 内容脚本一律带 sender.tab；未开放 externally_connectable，网页无法直接发消息。
    // 因此按「是否来自标签页」判定来源，不再限定单一站点。
    const isFromContentScript = typeof sender.tab?.id === 'number';

    const respond = async (): Promise<RuntimeResponse> => {
      try {
        switch (message.type) {
          case 'VIDEO_CONTEXT_CHANGED': {
            if (!isFromContentScript || typeof sender.tab?.id !== 'number') {
              return { ok: false, error: appError('BAD_REQUEST', '上下文必须来自页面内容脚本') };
            }
            const snapshot = (message.payload?.snapshot ?? {}) as Record<string, unknown>;
            const platform: VideoPlatform = snapshot.platform === 'web' ? 'web' : 'bilibili';
            const bvid = typeof snapshot.bvid === 'string' ? snapshot.bvid : '';
            const aid = String(snapshot.aid ?? '');
            const cid = String(snapshot.cid ?? '');
            const origin = typeof snapshot.origin === 'string' ? snapshot.origin : '';
            const webKey = typeof snapshot.videoKey === 'string' ? snapshot.videoKey : '';
            if (platform === 'bilibili' && (!bvid || !aid || !cid)) {
              return { ok: false, error: appError('PLAYER_NOT_READY', '播放器信息不完整') };
            }
            if (platform === 'web' && (!origin || !webKey)) {
              return { ok: false, error: appError('PLAYER_NOT_READY', '未能确定该页面的视频身份') };
            }
            const videoId = videoIdOf(platform, { bvid, cid, origin, videoKey: webKey });
            if (!videoId) return { ok: false, error: appError('PLAYER_NOT_READY', '视频身份无效') };
            const previous = await readContext(sender.tab.id);
            if (previous?.videoId && previous.videoId !== videoId) {
              await autoSummaryService.pausePlayback(previous.videoId);
            }
            await rememberContext({
              tabId: sender.tab.id,
              documentEpoch: String(message.payload?.documentEpoch ?? ''),
              // 通用站点把 URL 键放进 bvid 字段用于显示；权威身份始终是 videoId。
              bvid: platform === 'bilibili' ? bvid : webKey,
              aid: platform === 'bilibili' ? aid : '',
              cid,
              pageIndex: typeof snapshot.pageIndex === 'number' ? snapshot.pageIndex : 1,
              title: typeof snapshot.title === 'string' ? snapshot.title.slice(0, 300) : '',
              durationMs: typeof snapshot.durationMs === 'number' ? snapshot.durationMs : 0,
              positionMs: 0,
              updatedAt: Date.now(),
              platform,
              videoKey: platform === 'bilibili' ? `${bvid}:${cid}` : webKey,
              canonicalUrl: typeof snapshot.canonicalUrl === 'string' ? snapshot.canonicalUrl : undefined,
              videoId,
            });
            // 静默启动：弹窗不需要打开。取页内/站方已有字幕并建立自动学习会话，
            // 这样用户「播到一半再打开弹窗」就能直接看到已经累积的内容。
            // 不录音、不启本地转写（tabCapture 需用户手势，且会 1 倍速出声播放）。
            void silentBootstrap({
              tabId: sender.tab.id,
              videoId,
              platform,
              aid: platform === 'bilibili' ? aid : '',
              cid,
            }).catch((cause) => logFailure('auto-caption:bootstrap-failed', cause));
            return { ok: true };
          }
          case 'PLAYBACK_POSITION': {
            if (!isFromContentScript || typeof sender.tab?.id !== 'number') {
              return { ok: false, error: appError('BAD_REQUEST', '进度必须来自页面内容脚本') };
            }
            const positionMs = Number(message.payload?.positionMs);
            if (!Number.isFinite(positionMs)) return { ok: true };
            let existing = await readContext(sender.tab.id);
            // 上下文可能因为 SW 回收、页面重载、站点 SPA 换片而缺失。
            // 此时若直接丢弃，自动学习就永远停在 lastPositionMs=0 / paused=true。
            // 用上报里的身份字段补建一次上下文，让播放位置能够落地。
            if (!existing) {
              const payload = (message.payload?.snapshot ?? message.payload ?? {}) as Record<string, unknown>;
              const key = String(message.payload?.videoKey ?? '').trim();
              if (!key) return { ok: true };
              const tab = await chrome.tabs.get(sender.tab.id).catch(() => null);
              const origin = typeof payload.origin === 'string' ? payload.origin : (tab?.url ? new URL(tab.url).origin : '');
              const videoId = videoIdOf('web', { origin, videoKey: key });
              if (!videoId) return { ok: true };
              existing = {
                tabId: sender.tab.id,
                documentEpoch: String(message.payload?.documentEpoch ?? ''),
                bvid: key,
                aid: '',
                cid: '',
                pageIndex: 1,
                title: typeof payload.title === 'string' ? payload.title.slice(0, 300) : '',
                durationMs: Number.isFinite(Number(message.payload?.durationMs)) ? Number(message.payload?.durationMs) : 0,
                positionMs: 0,
                updatedAt: Date.now(),
                platform: 'web',
                videoKey: key,
                videoId,
              };
              await rememberContext(existing);
              vsLog.info('playback:context-rebuilt', { videoId });
            }
            if (!isPlaybackForContext(message.payload, existing)) return { ok: true };
            const videoId = existing.videoId ?? (existing.platform === 'web' ? null : videoRecordId(existing.bvid, existing.cid));
            if (!videoId) return { ok: true };
            const durationFromPayload = Number(message.payload?.durationMs);
            TAB_STATES.set(sender.tab.id, {
              paused: message.payload?.paused === true,
              muted: message.payload?.muted === true,
              volume: typeof message.payload?.volume === 'number' ? message.payload.volume : 1,
              playbackRate: typeof message.payload?.playbackRate === 'number' ? message.payload.playbackRate : 1,
              positionMs: Math.max(0, Math.round(positionMs)),
              durationMs: Number.isFinite(durationFromPayload) ? Math.round(durationFromPayload) : 0,
              ready: true,
            });
            TAB_CONTEXTS.set(sender.tab.id, { ...existing, positionMs: Math.max(0, Math.round(positionMs)) });
            await autoSummaryService.observe({
              videoId,
              positionMs: Math.max(0, Math.round(positionMs)),
              durationMs: Number.isFinite(durationFromPayload) ? Math.round(durationFromPayload) : existing.durationMs,
              paused: message.payload?.paused === true,
              ended: message.payload?.ended === true,
            });
            // 录音期间把真实播放状态同步给离屏文档：暂停/跳转/换速会自动停止采集。
            void pushSample(sender.tab.id);
            return { ok: true };
          }
          case 'CAPTURE_VIDEO': {
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab?.url) return { ok: false, error: appError('UNSUPPORTED_PAGE', '请先打开视频页面') };
            // B站走适配器（分 P、站方字幕轨道）；其他站点按需注入通用页面脚本。
            if (!parseBilibiliVideoUrl(tab.url)) {
              const ensured = await ensurePageScript(tabId, tab.url);
              if (!ensured.ok) return { ok: false, error: ensured.error };
            }
            let context = await readContext(tabId);
            if (!context) {
              // 主动要求内容脚本上报，并有界等待其重试完成。
              const probe = await requestContext(tabId);
              for (let attempt = 0; attempt < 10 && !context; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 250));
                context = await readContext(tabId);
              }
              if (!context) {
                // 用探针结果区分真实原因，而不是统一提示“请确认页面已加载完成”。
                if (!probe.contentScriptAlive) {
                  vsLog.error('capture:content-script-missing', { url: safeUrl(tab.url) });
                  return {
                    ok: false,
                    error: appError('PLAYER_NOT_READY', '识别脚本未在此页运行', {
                      detail: '若刚安装或更新扩展，请刷新该页面后重试。',
                    }),
                  };
                }
                const reason = describeSnapshotFailure(probe.failure, probe.diag);
                vsLog.error('capture:snapshot-failed', {
                  url: safeUrl(tab.url),
                  failure: probe.failure ?? 'unknown',
                  videoElements: probe.videoElements ?? 0,
                  ...(probe.diag ?? {}),
                });
                return { ok: false, error: reason };
              }
            }
            vsLog.info('capture:ok', {
              url: safeUrl(tab.url),
              platform: context.platform ?? 'bilibili',
              pageIndex: context.pageIndex,
            });
            return { ok: true, data: context };
          }
          case 'GET_VIDEO_STATE': {
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const context = await readContext(tabId);
            const state = TAB_STATES.get(tabId);
            // TAB_STATES 只由页面位置上报填充。为 null 时说明这个标签页还没上报过，
            // 直接回默认值会让界面永远显示「暂停 / 0:00」，看起来像播放键失效。
            // 这里只确保脚本在位，下一次位置上报（每 2 秒）就会把真实状态填进来。
            if (!state) {
              const tab = await chrome.tabs.get(tabId).catch(() => null);
              if (tab?.url) void ensurePlaybackTarget(tabId).catch(() => undefined);
              return { ok: true, data: defaultVideoState(context?.positionMs ?? 0, context?.durationMs ?? 0) };
            }
            return { ok: true, data: state };
          }
          case 'CONTROL_PLAYBACK': {
            if (isFromContentScript) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const tabId = await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            // 关键修复：内容脚本可能因为重开弹窗/页面未刷新/按需注入还没执行而缺席，
            // 此时 sendMessage 会静默失败，界面表现为「按钮点了没反应」。
            // 先确保脚本在，再发消息；仍失败则给出可执行的原因。
            const ready = await ensurePlaybackTarget(tabId);
            if (!ready.ok) return { ok: false, error: ready.error };
            const result = (await chrome.tabs
              .sendMessage(tabId, {
                type: 'CONTROL_PLAYBACK',
                payload: { action: message.payload?.action, value: message.payload?.value },
              })
              .catch(() => null)) as { ok?: boolean; reason?: string } | null;
            if (!result?.ok) return { ok: false, error: appError('BAD_REQUEST', result?.reason ?? '播放控制失败') };
            return { ok: true };
          }
          case 'CAPTURE_FRAME': {
            if (isFromContentScript) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const result = (await chrome.tabs
              .sendMessage(tabId, { type: 'CAPTURE_FRAME' })
              .catch(() => null)) as { ok?: boolean; data?: CapturedFrame; reason?: string } | null;
            if (!result?.ok || !result.data) {
              return { ok: false, error: appError('BAD_RESPONSE', result?.reason ?? '截图失败') };
            }
            return { ok: true, data: result.data };
          }
          case 'LIST_TRACKS': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const aid = String(message.payload?.aid ?? '');
            const cid = String(message.payload?.cid ?? '');
            if (!/^\d{1,20}$/.test(aid) || !/^\d{1,20}$/.test(cid)) {
              // 非 B站页面（或缺少分 P 标识）时给出替代路径，而不是一句「不支持」。
              return {
                ok: false,
                error: appError('NO_SUBTITLE', '该站点没有站方字幕接口', {
                  detail: '请改用「读取页内字幕」「导入字幕文件」或「从音频转写」。',
                }),
              };
            }
            // 关键修复：B站字幕接口对多数视频返回 need_login_subtitle=true，
            // 只有带登录态的请求才会给出 subtitle_url。此前用 credentials:'omit'
            // 明确不带 Cookie，导致 subtitles 恒为空，再被解析层丢弃，用户看到“无字幕”。
            // 这里改为 include，让浏览器按站点正常附带 Cookie；代码本身不读取 Cookie 内容。
            const response = await fetch(buildPlayerInfoUrl(aid, cid), { credentials: 'include' });
            if (!response.ok) {
              return { ok: false, error: appError('SUBTITLE_UNKNOWN', `字幕信息请求失败（HTTP ${response.status}）`) };
            }
            const payload: unknown = await response.json();
            const list = parseTrackResponse(payload);
            const classified = classifyTracks(list);
            vsLog.info('tracks:classified', {
              kind: classified.kind,
              count: classified.kind === 'ok' ? classified.tracks.length : 0,
              needLogin: list.needLogin,
            });
            if (classified.kind === 'login') return { ok: false, error: appError('LOGIN_REQUIRED', '该字幕可能需要登录后读取') };
            if (classified.kind === 'none') return { ok: false, error: appError('NO_SUBTITLE', '当前视频未发现可读取的字幕') };
            return {
              ok: true,
              data: classified.tracks.map((track) => ({
                id: track.id,
                lan: track.lan,
                lanDoc: track.lanDoc,
                url: track.url,
                generationKind: inferGenerationKind(track.lanDoc || track.lan),
              })),
            };
          }
          case 'READ_SUBTITLE': {
            if (isFromContentScript) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const url = String(message.payload?.url ?? '');
            if (!url) return { ok: false, error: appError('BAD_REQUEST', '缺少字幕地址') };
            const result = await fetchSubtitleBody(url);
            return { ok: true, data: result };
          }
          case 'SEEK_VIDEO': {
            if (isFromContentScript) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const seekTabId = await activeTabId();
            if (seekTabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const positionMs = Number(message.payload?.positionMs ?? 0);
            const result = (await chrome.tabs
              .sendMessage(seekTabId, { type: 'SEEK_VIDEO', payload: { positionMs } })
              .catch(() => null)) as { ok?: boolean; reason?: string } | null;
            if (!result?.ok) return { ok: false, error: appError('SUBTITLE_READ_FAILED', result?.reason ?? '跳转失败') };
            return { ok: true };
          }
          case 'TRANSCRIBE_AUDIO': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const asrTabId = await activeTabId();
            if (asrTabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const tab = await chrome.tabs.get(asrTabId).catch(() => null);
            if (!tab?.url) return { ok: false, error: appError('UNSUPPORTED_PAGE', '请先打开视频页面') };
            const context = await readContext(asrTabId);
            if (!context?.videoId) {
              return {
                ok: false,
                error: appError('PLAYER_NOT_READY', '尚未识别到播放器', {
                  detail: '请先在视频页点「重新识别当前页」，再进行音频转写。',
                }),
              };
            }
            if (localAsr && ['starting', 'recording', 'transcribing'].includes(localAsr.status)) {
              return { ok: false, error: appError('BAD_REQUEST', '已有正在进行的音频转写') };
            }
            const settings = await loadSettings();
            // 转写只走本机；先确认服务就绪，避免录完才发现不可用。
            const health = await checkLocalWhisper(settings.localWhisper).catch((cause) => {
              throw toAppError(cause, 'LOCAL_WHISPER_UNAVAILABLE', '本地语音转写服务不可用');
            });
            const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: asrTabId })
              .catch(() => null);
            if (!streamId) {
              return {
                ok: false,
                error: appError('CAPTURE_UNAVAILABLE', '无法获取标签页音频', {
                  detail: '请在该视频标签页点击扩展图标后再转写（浏览器要求用户手势），并确认浏览器为 Chrome/Edge 116+。',
                }),
              };
            }
            await ensureAsrDocument();
            const state: LocalAsrState = {
              id: `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
              tabId: asrTabId, videoId: context.videoId, documentEpoch: context.documentEpoch,
              frameId: 0, status: 'starting', model: health.model, startedAt: Date.now(), updatedAt: Date.now(),
              recordedMs: 0, completedChunks: 0, queuedChunks: 0, warnings: [],
            };
            localAsr = state;
            asrSegments = [];
            const sample = TAB_STATES.get(asrTabId) ?? defaultVideoState(context.positionMs, context.durationMs);
            const started = (await chrome.runtime.sendMessage({
              target: ASR_OFFSCREEN_TARGET, type: 'start',
              payload: { id: state.id, streamId, config: settings.localWhisper, sample },
            }).catch(() => null)) as { ok?: boolean; reason?: string } | null;
            if (!started?.ok) {
              const failed: LocalAsrState = { ...state, status: 'failed', updatedAt: Date.now(),
                error: appError('CAPTURE_UNAVAILABLE', started?.reason ?? '无法开始标签页录音') };
              localAsr = failed;
              await persistAsr();
              await chrome.offscreen.closeDocument().catch(() => undefined);
              return { ok: false, error: failed.error };
            }
            localAsr = { ...state, status: 'recording' };
            await persistAsr();
            vsLog.info('asr:begin', { model: health.model, chunkMs: ASR_CAPTURE_CHUNK_MS });
            return { ok: true, data: { id: state.id, status: 'recording' } };
          }
          case 'ASR_STATE': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            // SW 被回收后首次查询：先从 session 恢复，避免显示成「没有任务」。
            await restoreAsr();
            return { ok: true, data: localAsr };
          }
          case 'ASR_STOP': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            if (!localAsr) return { ok: true, data: null };
            await chrome.runtime.sendMessage({ target: ASR_OFFSCREEN_TARGET, type: 'stop' }).catch(() => undefined);
            return { ok: true };
          }
          case 'LIST_PAGE_TRACKS': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const result = (await chrome.tabs
              .sendMessage(tabId, { type: 'LIST_PAGE_TRACKS' })
              .catch(() => null)) as { ok?: boolean; tracks?: unknown[]; reason?: string } | null;
            if (!result?.ok) {
              return {
                ok: false,
                error: appError('PLAYER_NOT_READY', result?.reason ?? '页面脚本未就绪', {
                  detail: '请在视频页点「重新识别」后重试。',
                }),
              };
            }
            return { ok: true, data: Array.isArray(result.tracks) ? result.tracks : [] };
          }
          case 'READ_PAGE_TRACK': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const url = String(message.payload?.url ?? '');
            if (!url) return { ok: false, error: appError('BAD_REQUEST', '缺少字幕地址') };
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            // 只允许读取与当前页面同源的字幕文件，避免把内容脚本当成任意 URL 代理。
            try {
              const target = new URL(url);
              const page = tab?.url ? new URL(tab.url) : null;
              if (!page || target.origin !== page.origin || (target.protocol !== 'https:' && target.protocol !== 'http:')) {
                return { ok: false, error: appError('SUBTITLE_HOST_BLOCKED', '只允许读取当前网站自身的字幕文件') };
              }
            } catch {
              return { ok: false, error: appError('BAD_REQUEST', '字幕地址无效') };
            }
            const result = (await chrome.tabs
              .sendMessage(tabId, { type: 'READ_PAGE_TRACK', payload: { url } })
              .catch(() => null)) as { ok?: boolean; text?: string; reason?: string } | null;
            if (!result?.ok || typeof result.text !== 'string') {
              return { ok: false, error: appError('SUBTITLE_READ_FAILED', result?.reason ?? '字幕文件读取失败') };
            }
            return { ok: true, data: { text: result.text } };
          }
          case 'ENSURE_PAGE_SCRIPT': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const tabId = typeof message.payload?.tabId === 'number' ? message.payload.tabId : await activeTabId();
            if (tabId === null) return { ok: false, error: appError('UNSUPPORTED_PAGE', '找不到当前标签页') };
            const tab = await chrome.tabs.get(tabId).catch(() => null);
            if (!tab?.url) return { ok: false, error: appError('UNSUPPORTED_PAGE', '请先打开视频页面') };
            if (parseBilibiliVideoUrl(tab.url)) return { ok: true };
            const ensured = await ensurePageScript(tabId, tab.url);
            return ensured.ok ? { ok: true } : { ok: false, error: ensured.error };
          }
          case 'START_SUMMARY':
            return { ok: false, error: appError('BAD_REQUEST', '已改为随播放自动流式学习，不再启动整片批量生成') };
          case 'AUTO_SUMMARY_STATE': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            if (!videoId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频标识') };
            return { ok: true, data: await autoSummaryService.snapshot(videoId) };
          }
          case 'AUTO_SUMMARY_SELECT': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            const transcriptId = String(message.payload?.transcriptId ?? '');
            if (!videoId || !transcriptId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频或字幕标识') };
            await autoSummaryService.prepare(videoId, transcriptId);
            return { ok: true };
          }
          case 'AUTO_SUMMARY_CONTROL':
          case 'CANCEL_SUMMARY': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            const enabled = message.type === 'CANCEL_SUMMARY' ? false : message.payload?.enabled;
            if (!videoId || typeof enabled !== 'boolean') return { ok: false, error: appError('BAD_REQUEST', '自动学习参数无效') };
            await autoSummaryService.setEnabled(videoId, enabled, message.payload?.retryFailed === true);
            return { ok: true, data: { cancelled: !enabled } };
          }
          case 'FULL_SUMMARY_PREVIEW': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            const transcriptId = String(message.payload?.transcriptId ?? '');
            if (!videoId || !transcriptId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频或字幕标识') };
            try {
              return { ok: true, data: await previewFullSummary(videoId, transcriptId) };
            } catch (cause) { return { ok: false, error: toAppError(cause) }; }
          }
          case 'FULL_SUMMARY_START': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            const transcriptId = String(message.payload?.transcriptId ?? '');
            if (!videoId || !transcriptId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频或字幕标识') };
            try {
              const result = await startFullSummary({ videoId, transcriptId, appendToNote: message.payload?.appendToNote !== false });
              return { ok: true, data: { summaryId: result.summaryId, noteUpdated: Boolean(result.note) } };
            } catch (cause) { return { ok: false, error: toAppError(cause) }; }
          }
          case 'FULL_SUMMARY_PROGRESS': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            if (!videoId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频标识') };
            return { ok: true, data: fullSummaryProgress(videoId) };
          }
          case 'SUMMARY_PROGRESS': {
            if (!isTrustedExtensionSender(sender)) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            if (!videoId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频标识') };
            const snapshot = await autoSummaryService.snapshot(videoId);
            if (!snapshot.transcriptId) return { ok: true, data: null };
            return { ok: true, data: {
              jobId: `auto:${videoId}`, videoId, completed: snapshot.completed, total: snapshot.total,
              failedChunks: snapshot.failed, updatedAt: new Date().toISOString(), message: snapshot.message,
              stage: !snapshot.enabled ? 'cancelled' : snapshot.error ? 'failed' :
                snapshot.draft?.status === 'streaming' ? 'extracting' : snapshot.queued ? 'queued' :
                snapshot.completed === snapshot.total ? 'completed' : 'partial',
              errorCode: snapshot.error?.code,
            } };
          }
          case 'GET_SUMMARY': {
            if (isFromContentScript) return { ok: false, error: appError('BAD_REQUEST', '该动作只能来自扩展页面') };
            const videoId = String(message.payload?.videoId ?? '');
            if (!videoId) return { ok: false, error: appError('BAD_REQUEST', '缺少视频标识') };
            const summary = await latestSummary(videoId);
            return { ok: true, data: summary ?? null };
          }
          default:
            return { ok: false, error: appError('BAD_REQUEST', '不支持的消息类型') };
        }
      } catch (cause) {
        return { ok: false, error: toAppError(cause, 'UNKNOWN', '后台处理失败') };
      }
    };

    void respond().then(sendResponse);
    return true;
  });
});
