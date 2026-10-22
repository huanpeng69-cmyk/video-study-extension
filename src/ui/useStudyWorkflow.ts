/**
 * 弹窗工作流（PRD F01–F11 + 播放控制与截图）。
 * 所有外部输入先校验再落地；AI 失败不影响已保存的字幕与笔记。
 *
 * 自动学习由后台真实播放进度驱动。弹窗只选择字幕、订阅 SSE 预览与展示结果。
 * 翻译、录音和手写笔记仍使用原有工作流。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { appError, describeError, toAppError } from '../domain/errors';
import { normalizeEndpoint } from '../domain/endpoint';
import {
  assertImportSize,
  cuesFromAsrSegments,
  hashTranscript,
  inferGenerationKind,
  parseSubtitleText,
  type Cue,
  type TranscriptGenerationKind,
} from '../domain/transcript';
import { buildCacheKey, cueRangeKey } from '../ai/prompts';
import { runTranslateTask, type UsageInfo } from '../jobs/runner';
import { planChunks } from '../domain/chunking';
import {
  captureFrame,
  captureVideo,
  controlPlayback,
  getVideoState,
  listTracks,
  readSubtitle,
  readTabContext,
  seekCurrentTab,
  listPageTracks,
  readPageTrack,
  startLocalTranscription,
  localTranscriptionState,
  type SummaryProgressInfo,
  type UiTabContext,
  startFullSummary,
} from '../lib/bridge';
import type { CapturedFrame, PlaybackAction, TrackSummary, VideoState } from '../lib/messages';
import {
  getCues,
  getDb,
  getNote,
  getVideo,
  latestSummary,
  listChunkResults,
  listJobs,
  listTranscripts,
  putJob,
  saveNote,
  replaceTranscriptCues,
  saveTranscript,
  saveTranslation,
  upsertVideo,
} from '../storage/db';
import type { SummaryRecord, TranscriptRevision, VideoRecord } from '../storage/types';
import { assembleByPlan, buildJobRecord, commitChunk, findReusableJob, markJobRunning, markJobState } from '../storage/jobs';
import { assertProviderReady, loadApiKey, loadSettings, type AppSettings } from '../storage/settings';
import { videoRecordId, type VideoPlatform } from '../domain/video';
import { pickDefaultTrack, rankCaptionTracks } from '../domain/page-tracks';
import { useAutoSummary } from './useAutoSummary';

export interface Notice {
  kind: 'error' | 'warn' | 'ok' | 'info';
  title: string;
  detail?: string;
  action?: string;
}

export interface TaskProgress {
  label: string;
  completed: number;
  total: number;
  state: 'idle' | 'running' | 'cancelled' | 'partial' | 'completed' | 'failed';
}

export interface UiState {
  context: UiTabContext | null;
  video: VideoRecord | null;
  track: TrackSummary | null;
  tracks: TrackSummary[];
  transcripts: TranscriptRevision[];
  transcript: TranscriptRevision | null;
  cues: Cue[];
  translations: Map<string, string>;
  summary: SummaryRecord | null;
  noteMarkdown: string;
  noteRevision: number;
  saveState: 'idle' | 'pending' | 'saved' | 'error';
  notice: Notice | null;
  task: TaskProgress;
  busy: boolean;
  settings: AppSettings | null;
  apiKeyPresent: boolean;
  /** 视频原始播放状态，用于弹窗内的收听控制。 */
  playback: VideoState;
  /** 最近一次截取的画面（插入笔记后清空）。 */
  frame: CapturedFrame | null;
  /** 识别失败但用户可自助授权时记录站点源，用于显示「允许访问此网站」。 */
  sitePermission: string | null;
}

const INITIAL_TASK: TaskProgress = { label: '', completed: 0, total: 0, state: 'idle' };

export function useStudyWorkflow() {
  const [state, setState] = useState<UiState>({
    context: null,
    video: null,
    track: null,
    tracks: [],
    transcripts: [],
    transcript: null,
    cues: [],
    translations: new Map(),
    summary: null,
    noteMarkdown: '',
    noteRevision: 0,
    saveState: 'idle',
    notice: null,
    task: INITIAL_TASK,
    busy: false,
    settings: null,
    apiKeyPresent: false,
    playback: { paused: true, muted: false, volume: 1, playbackRate: 1, positionMs: 0, durationMs: 0, ready: false },
    frame: null,
    sitePermission: null,
  });
  const noteTimer = useRef<number | null>(null);
  const pendingNote = useRef<{ markdown: string; revision: number } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  /** 卸载或重新开始时让正在跑的转写轮询立即退出，避免 busy 被永久锁住。 */
  const pollCancelledRef = useRef(false);
  /** 供挂载期异步回调读取当前视频 id，避免闭包拿到初始空值。 */
  const videoIdRef = useRef<string | undefined>(undefined);
  /** 采集进行中已落库的字幕版本 id；跨分片复用以保持自动学习绑定的版本不变。 */
  const liveTranscriptIdRef = useRef<string | null>(null);
  /** 已同步进库的字幕条数；条数没变就不再重复写库。 */
  const liveCueCountRef = useRef(0);

  const patch = useCallback((next: Partial<UiState>) => {
    setState((prev) => {
      const merged = { ...prev, ...next };
      videoIdRef.current = merged.video?.id;
      return merged;
    });
  }, []);

  const setNotice = useCallback((notice: Notice | null) => patch({ notice }), [patch]);

  const failWith = useCallback(
    (error: unknown, fallbackTitle = '操作失败') => {
      const normalized = toAppError(error);
      const described = describeError(normalized);
      setNotice({
        kind: 'error',
        title: described.title || fallbackTitle,
        detail: [normalized.message, normalized.detail].filter(Boolean).join(' · '),
        action: described.action,
      });
    },
    [setNotice],
  );

  const loadSettingsInto = useCallback(async () => {
    const settings = await loadSettings();
    const apiKey = await loadApiKey(settings);
    patch({ settings, apiKeyPresent: Boolean(apiKey) });
    return { settings, apiKey };
  }, [patch]);

  useEffect(() => {
    void loadSettingsInto().catch((error) => failWith(error, '读取设置失败'));
    const listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !changes['settings.v1']) return;
      void loadSettingsInto().catch(() => undefined);
    };
    chrome.storage.onChanged.addListener(listener);
    return () => chrome.storage.onChanged.removeListener(listener);
  }, [failWith, loadSettingsInto]);

  /** 采集当前视频：识别 → 保存元信息 → 读取已有字幕与笔记。 */
  const capture = useCallback(async () => {
    patch({ busy: true, notice: null });
    try {
      const result = await captureVideo();
      if (!result.ok || !result.data) {
        const error = result.error ?? appError('UNKNOWN', '无法识别当前页面');
        // 未授权站点时后台返回 site-permission:<origin>；这里提取出来供 UI 一键授权。
        const origin = /site-permission:(https?:\/\/[^\s;]+)/.exec(error.detail ?? '')?.[1] ?? null;
        patch({ context: null, sitePermission: origin });
        if (origin) {
          setNotice({
            kind: 'info',
            title: '需要授权该网站',
            detail: `授权后即可在 ${origin} 的任意视频页识别播放器、读取页内字幕与自动学习。`,
          });
        }
        failWith(error);
        return;
      }
      const context = result.data;
      patch({ context, sitePermission: null });
      const platform: VideoPlatform = context.platform ?? 'bilibili';
      const id = context.videoId ?? videoRecordId(context.bvid, context.cid);
      const record: VideoRecord = {
        id,
        platform,
        bvid: context.bvid,
        aid: context.aid ?? '',
        cid: context.cid,
        pageIndex: context.pageIndex,
        title: context.title || '未命名视频',
        canonicalUrl:
          context.canonicalUrl ??
          (platform === 'bilibili' ? `https://www.bilibili.com/video/${context.bvid}/?p=${context.pageIndex}` : ''),
        durationMs: context.durationMs,
        tags: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await upsertVideo(record);
      const video = (await getVideo(id)) ?? record;
      const [transcripts, note, summary] = await Promise.all([listTranscripts(id), getNote(id), latestSummary(id)]);
      patch({
        video,
        transcripts,
        noteMarkdown: note?.markdown ?? '',
        noteRevision: note?.revision ?? 0,
        saveState: 'idle',
        summary: summary ?? null,
        cues: [],
        translations: new Map(),
        transcript: null,
      });
      if (transcripts.length > 0) {
        const autoSession = await getDb().autoSummarySessions.get(id);
        const latest = transcripts.find((item) => item.id === autoSession?.transcriptId) ?? sortByCreated(transcripts)[0] ?? null;
        if (latest) {
          const cues = await getCues(latest.id);
          patch({ transcript: latest, cues, transcripts });
        }
      }
    } catch (error) {
      failWith(error, '识别视频失败');
    } finally {
      patch({ busy: false });
    }
  }, [failWith, patch]);

  /**
   * 优先使用视频中已存在的字幕：页内 `<track>` 优先，其次站方字幕轨道。
   * 只有都拿不到时才需要音频转写（成本最高）。返回是否成功拿到字幕。
   */
  const tryExistingCaptions = useCallback(async (): Promise<boolean> => {
    const video = state.video;
    const context = state.context;
    if (!video) return false;
    try {
      // 1) 页内 <track> / 站点脚本里的字幕轨道（通用，不需要登录）。
      const listed = await listPageTracks();
      const candidates = listed.ok && Array.isArray(listed.data) ? listed.data : [];
      // 排序规则集中在 domain 层：人工/官方字幕优先，其次目标语言，最后才用自动生成字幕。
      const ordered = rankCaptionTracks(candidates);
      for (const track of ordered) {
        const read = await readPageTrack(track.url);
        if (!read.ok || !read.data?.text) continue;
        let parsed;
        try {
          parsed = parseSubtitleText(read.data.text, 'vtt');
        } catch {
          continue; // 单条候选解析失败不放弃其它候选。
        }
        if (parsed.cues.length === 0) continue;
        const { revision } = await saveTranscript({
          videoId: video.id,
          language: track.language || 'page',
          sourceKind: 'native',
          generationKind: inferGenerationKind(track.label),
          trackLabel: track.label.slice(0, 120),
          sourceHash: hashTranscript(parsed.cues),
          cues: parsed.cues,
        });
        const transcripts = await listTranscripts(video.id);
        patch({ transcript: revision, cues: parsed.cues, transcripts, translations: new Map(), summary: null });
        setNotice({
          kind: parsed.warnings.length > 0 ? 'warn' : 'ok',
          title: `已使用页面自带字幕（${parsed.cues.length} 条）`,
          detail: [track.label, '未采集音频'].filter(Boolean).join(' · '),
        });
        return true;
      }
      // 2) B站站方字幕轨道（需要上下文里的 aid/cid）。
      if (context && video.platform === 'bilibili') {
        const listedNative = await listTracks(context.aid ?? '', context.cid);
        const tracks = listedNative.ok && Array.isArray(listedNative.data) ? listedNative.data : [];
        const track = tracks.find((item) => item.generationKind === 'human') ?? tracks[0];
        if (track) {
          const read = await readSubtitle(track.url);
          if (read.ok && read.data && read.data.cues.length > 0) {
            const { revision } = await saveTranscript({
              videoId: video.id,
              language: track.lan,
              sourceKind: 'native',
              generationKind: track.generationKind as TranscriptGenerationKind,
              trackLabel: track.lanDoc,
              sourceHash: hashTranscript(read.data.cues),
              cues: read.data.cues,
            });
            const transcripts = await listTranscripts(video.id);
            patch({ transcript: revision, cues: read.data.cues, transcripts, translations: new Map(), summary: null, track });
            setNotice({
              kind: 'ok',
              title: `已使用站方字幕（${read.data.cues.length} 条）`,
              detail: `${track.lanDoc} · 未采集音频`,
            });
            return true;
          }
        }
      }
    } catch {
      // 这里任何失败都只是「没拿到已有字幕」，继续走音频转写，不打断用户。
    }
    return false;
  }, [listTranscripts, patch, setNotice, state.context, state.video]);


  useEffect(() => {
    // 组件卸载（关弹窗）时让转写轮询退出：后台任务不受影响，
    // 但界面上的 busy 不该因此被永久占住。
    return () => { pollCancelledRef.current = true; };
  }, []);

  useEffect(() => {
    void capture();
    // 重开弹窗/重新挂载时，如果后台仍有进行中的转写，直接接回进度显示，
    // 而不是停在“没有任务”上让用户以为进度丢了。
    void localTranscriptionState().then((result) => {
      const view = result.ok ? result.data : null;
      if (!view || !view.id) return;
      const active = ['starting', 'recording', 'transcribing'].includes(view.status);
      if (active) {
        setState((prev) => ({ ...prev,
          task: {
            label: view.status === 'transcribing' ? '本机转写中' : '采集标签页音频',
            completed: view.completedChunks,
            total: Math.max(view.completedChunks + view.queuedChunks, 1),
            state: 'running',
          } }));
        return;
      }
      // 已完成但界面没跟上（例如转写期间关过弹窗）：把结果直接落进状态，
      // 否则字幕会一直空白，用户以为转写没成功。
      if (view.status === 'completed' && view.transcriptId) {
        void (async () => {
          try {
            const transcripts = await listTranscripts(videoIdRef.current ?? '');
            const saved = transcripts.find((item) => item.id === view.transcriptId) ?? null;
            if (!saved) return;
            const cues = await getCues(saved.id);
            setState((prev) => ({ ...prev, transcript: saved, cues, transcripts, translations: new Map() }));
          } catch { /* 读不到就保持原状，不覆盖已有内容 */ }
        })();
      }
    });
    const timer = window.setInterval(() => {
      void readTabContext().then((context) => {
        if (!context) return;
        setState((prev) => {
          const before = prev.context;
          const beforeKey = before ? (before.videoId ?? `${before.bvid}:${before.cid}`) : null;
          const nextKey = context.videoId ?? `${context.bvid}:${context.cid}`;
          if (beforeKey && beforeKey === nextKey) return prev;
          return { ...prev, context };
        });
      });
      // 播放状态用于弹窗内的收听控制，与上下文轮询分开以免互相拖慢。
      void getVideoState().then((result) => {
        if (result.ok && result.data) patch({ playback: result.data });
      });
    }, 1500);
    return () => window.clearInterval(timer);
    // 只在挂载时自动识别一次，之后由轮询更新上下文与播放状态。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 打开弹窗且尚无字幕时，自动尝试一次「视频已有字幕」。
   *
   * 为什么必须自动：上一版只在「从音频转写」按钮里调用推荐逻辑，
   * 用户打开弹窗看到的是空字幕列表，必须手动点按钮才会出现内容。
   * 这里只尝试一次、失败不提示不重试，避免打断用户或制造噪音。
   */
  const autoCaptionsRef = useRef(false);
  useEffect(() => {
    if (autoCaptionsRef.current) return;
    if (!state.video || !state.context) return;
    if (state.cues.length > 0 || state.transcripts.length > 0) return;
    if (state.busy) return;
    autoCaptionsRef.current = true;
    void (async () => {
      patch({ task: { label: '正在查找视频已有字幕', completed: 0, total: 1, state: 'running' } });
      const used = await tryExistingCaptions();
      patch({ task: { ...INITIAL_TASK } });
      if (!used) {
        setNotice({
          kind: 'info',
          title: '本页没有可直接读取的字幕',
          detail: '可点「从音频转写」由本机 Whisper 生成，或导入 SRT / VTT 文件。',
        });
      }
    })();
    // 只在视频身份变化时重试一次，不因每次状态更新而反复请求。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.video?.id, state.context?.videoId]);

  /** 逃生口：清掉卡住的 busy/task，让界面恢复可点（不动后台任务）。 */
  const resetTask = useCallback(() => {
    pollCancelledRef.current = true;
    patch({ busy: false, task: { ...INITIAL_TASK } });
  }, [patch]);

  /** 获取字幕轨道；区分“需登录”“无字幕”“读取失败”。 */
  const fetchTracks = useCallback(async () => {
    const context = state.context;
    if (!context) return;
    patch({ busy: true, notice: null });
    try {
      const result = await listTracks(context.aid ?? '', context.cid);
      if (!result.ok || !Array.isArray(result.data)) {
        failWith(result.error ?? appError('SUBTITLE_UNKNOWN', '字幕信息读取失败'));
        patch({ tracks: [] });
        return;
      }
      const tracks = result.data as TrackSummary[];
      patch({ tracks });
      if (tracks.length === 0) {
        setNotice({ kind: 'warn', title: '当前未发现可读取的字幕', detail: '可导入 SRT/VTT，或从音频转写' });
      }
    } catch (error) {
      failWith(error, '字幕轨道读取失败');
    } finally {
      patch({ busy: false });
    }
  }, [failWith, patch, setNotice, state.context]);

  /**
   * 读取页面自身的字幕轨道（通用层）。
   * 不查询任何站点接口、不要求登录；页面没有 `<track>` 时明确提示替代路径。
   */
  const readPageTracks = useCallback(async () => {
    const video = state.video;
    if (!video) return;
    patch({ busy: true, notice: null });
    try {
      const listed = await listPageTracks();
      if (!listed.ok || !Array.isArray(listed.data)) {
        failWith(listed.error ?? appError('SUBTITLE_UNKNOWN', '无法读取页内字幕轨道'));
        return;
      }
      const track = pickDefaultTrack(listed.data);
      if (!track) {
        setNotice({
          kind: 'warn',
          title: '本页没有可用字幕轨道',
          detail: '可导入 SRT/VTT 文件，或使用「从音频转写」。',
        });
        return;
      }
      const read = await readPageTrack(track.url);
      if (!read.ok || !read.data) {
        failWith(read.error ?? appError('SUBTITLE_READ_FAILED', '字幕读取失败'));
        return;
      }
      const parsed = parseSubtitleText(read.data.text, 'vtt');
      const { revision } = await saveTranscript({
        videoId: video.id,
        language: track.language || 'page',
        sourceKind: 'native',
        generationKind: inferGenerationKind(track.label),
        trackLabel: track.label.slice(0, 120),
        sourceHash: hashTranscript(parsed.cues),
        cues: parsed.cues,
      });
      const transcripts = await listTranscripts(video.id);
      patch({ transcript: revision, cues: parsed.cues, transcripts, translations: new Map(), summary: null });
      setNotice({
        kind: parsed.warnings.length > 0 ? 'warn' : 'ok',
        title: `已读取 ${parsed.cues.length} 条页内字幕`,
        detail: parsed.warnings.slice(0, 3).join('；') || track.label,
      });
    } catch (error) {
      failWith(error, '页内字幕读取失败');
    } finally {
      patch({ busy: false });
    }
  }, [failWith, patch, setNotice, state.video]);

  /** 用户确认授权后重新识别；未授权时不做任何注入。 */
  const grantSiteAccess = useCallback(
    async (origin: string) => {
      try {
        const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
        if (!granted) {
          setNotice({ kind: 'warn', title: '未授权该网站', detail: '未授权时不会在该页面识别或生成内容。' });
          return;
        }
        patch({ sitePermission: null });
        await capture();
      } catch (error) {
        failWith(error, '授权失败');
      }
    },
    [capture, failWith, patch, setNotice],
  );

  /** 读取选定轨道正文并保存为不可变版本。 */
  const loadTrack = useCallback(
    async (track: TrackSummary) => {
      const context = state.context;
      const video = state.video;
      if (!context || !video) return;
      patch({ busy: true, notice: null, track });
      try {
        const result = await readSubtitle(track.url);
        if (!result.ok || !result.data) {
          failWith(result.error ?? appError('SUBTITLE_READ_FAILED', '字幕正文读取失败'));
          return;
        }
        const parsed = result.data;
        const { revision } = await saveTranscript({
          videoId: video.id,
          language: track.lan,
          sourceKind: 'native',
          generationKind: track.generationKind as TranscriptGenerationKind,
          trackLabel: track.lanDoc,
          sourceHash: hashTranscript(parsed.cues),
          cues: parsed.cues,
        });
        const transcripts = await listTranscripts(video.id);
        patch({ transcript: revision, cues: parsed.cues, transcripts, translations: new Map(), summary: null });
        if (parsed.warnings.length > 0) {
          setNotice({
            kind: 'warn',
            title: `字幕已载入，跳过 ${parsed.rejected} 条无效内容`,
            detail: parsed.warnings.slice(0, 3).join('；'),
          });
        } else {
          setNotice({ kind: 'ok', title: `已载入 ${parsed.cues.length} 条字幕` });
        }
      } catch (error) {
        failWith(error, '字幕读取失败');
      } finally {
        patch({ busy: false });
      }
    },
    [failWith, patch, setNotice, state.context, state.video],
  );

  /**
   * 从视频音频转写为字幕。
   *
   * 代价必须讲清楚：浏览器只能实时录制，10 分钟视频就要录 10 分钟，
   * 期间视频会按 1 倍速真实播放并出声。因此这里先提示再开始，不静默长跑。
   */
  const transcribeAudio = useCallback(async () => {
    const video = state.video;

    if (!video) return;
    // 每次新调用都重置标志：否则上一轮没走完 finally（组件被卸载/重建）时，
    // 轮询会一直挂着，busy 永久为 true，整个弹窗的按钮全部变灰。
    pollCancelledRef.current = false;
    const settings = state.settings ?? (await loadSettings());
    void settings;

    // 先看后台是否已有进行中的会话：重开弹窗/新标签页时应当接回去继续显示进度，
    // 而不是静默什么都不做（旧实现直接 return，用户会以为按钮失灵）。
    const existing = await localTranscriptionState();
    const resumable = existing.ok && existing.data && existing.data.id &&
      ['starting', 'recording', 'transcribing'].includes(existing.data.status)
      ? existing.data : null;

    // 只有在没有进行中会话时，才先尝试「视频里已有的字幕」：
    // 官方/人工字幕远比语音识别准，而且不用实时录一遍。
    if (!resumable) {
      // 新一轮采集不复用上一轮的版本 id 与已同步条数，否则会把新音频写进旧版本。
      liveTranscriptIdRef.current = null;
      liveCueCountRef.current = 0;
      patch({ busy: true, task: { label: '优先查找视频已有字幕', completed: 0, total: 1, state: 'running' } });
      const usedExisting = await tryExistingCaptions();
      if (usedExisting) { patch({ busy: false, task: { ...INITIAL_TASK } }); return; }
    }
    if (resumable) {
      patch({
        busy: true,
        notice: {
          kind: 'info',
          title: '已接回进行中的音频转写',
          detail: `已完成 ${resumable.completedChunks} 个分片，继续显示进度。`,
        },
        task: { label: '采集标签页音频并本机转写（需正常播放）', completed: resumable.completedChunks, total: 100, state: 'running' },
      });
    } else {
      patch({
        busy: true,
        notice: null,
        task: { label: '采集标签页音频并本机转写（需正常播放）', completed: 0, total: 100, state: 'running' },
      });
    }

    try {
      // 已有会话时不再重复申请采集，直接进入轮询。
      const started = resumable
        ? { ok: true as const, data: { id: resumable.id, status: resumable.status } }
        : await startLocalTranscription();
      if (!started.ok) {
        failWith((started as { error?: unknown }).error ?? appError('CAPTURE_UNAVAILABLE', '无法开始本地转写'));
        patch({ busy: false, task: { ...INITIAL_TASK } });
        return;
      }
      // 转写在后台继续；弹窗只轮询进度，关闭弹窗不会丢结果。
      // 上限 3 小时，且 `pollCancelledRef` 允许卸载/重置时立刻退出，避免 busy 永久卡住。
      const sessionId = started.data?.id ?? '';
      for (let attempt = 0; attempt < 5_400; attempt += 1) {
        if (pollCancelledRef.current) return;
        await new Promise((resolve) => window.setTimeout(resolve, 2_000));
        if (pollCancelledRef.current) return;
        const stateResult = await localTranscriptionState();
        const view = stateResult.data;
        if (!view || view.id !== sessionId) continue;
        patch({
          task: {
            label: view.status === 'transcribing' ? '本机转写中' : '采集标签页音频',
            completed: view.completedChunks,
            total: Math.max(view.completedChunks + view.queuedChunks, 1),
            state: 'running',
          },
        });
        // 边采边显示：把后台已完成分片映射成字幕列表，并**落成一个真实的字幕版本**。
        //
        // 为什么必须落库而不能只更新 cues：自动学习是拿 `state.transcript.id` 订阅的
        // （见 useAutoSummary(videoId, transcriptId)），只给 cues 的话 transcript 仍是 null，
        // 订阅与建会话都不会发生 → 字幕出来了但自动学习永远不出字。
        // 每片落一次是有意的：保存是按 sourceHash 去重的版本化写入，不会产生垃圾版本，
        // 但能让自动学习在采集进行中就开始工作。
        if (view.segments && view.segments.length > 0) {
          const previewCues = cuesFromAsrSegments(view.segments);
          if (previewCues.length > 0) {
            patch({ cues: previewCues });
            // 自动学习是按 transcriptId 从库里读字幕的：
            // 只把新分片 patch 到内存，会让后面的 30 秒节点读到「只有开头几条」的旧版本，
            // 表现为前几个节点有内容、后面的节点却显示「本时间段没有可用字幕」。
            // 所以每片都要同步进同一个版本（id 不变，避免会话与已完成节点失联）。
            if (previewCues.length !== liveCueCountRef.current) {
              try {
                if (liveTranscriptIdRef.current) {
                  const updated = await replaceTranscriptCues(liveTranscriptIdRef.current, previewCues);
                  liveCueCountRef.current = previewCues.length;
                  patch({ transcript: updated });
                } else if (view.status !== 'completed') {
                  const { revision } = await saveTranscript({
                    videoId: video.id,
                    language: 'auto',
                    sourceKind: 'asr',
                    generationKind: 'ai',
                    trackLabel: `本地转写（进行中） · ${view.model}`.slice(0, 120),
                    sourceHash: hashTranscript(previewCues),
                    cues: previewCues,
                  });
                  liveTranscriptIdRef.current = revision.id;
                  liveCueCountRef.current = previewCues.length;
                  const transcripts = await listTranscripts(video.id);
                  patch({ transcript: revision, transcripts });
                }
              } catch { /* 落库失败不阻断采集；完成时还会再落一次 */ }
            }
          }
        }
        if (view.status === 'failed') {
          failWith(view.error ?? appError('LOCAL_WHISPER_ERROR', '本地转写失败'));
          break;
        }
        if (view.status !== 'completed') continue;
        if (!view.transcriptId) {
          failWith(appError('STORAGE_FAILED', '转写完成但没有保存字幕'));
          break;
        }
        const transcripts = await listTranscripts(video.id);
        const saved = transcripts.find((item) => item.id === view.transcriptId) ?? null;
        const cues = saved ? await getCues(saved.id) : [];
        patch({ transcript: saved, cues, transcripts, translations: new Map(), track: null, summary: null });
        setNotice({
          kind: view.warnings.length > 0 ? 'warn' : 'ok',
          title: `已转写 ${cues.length} 条字幕`,
          detail: view.warnings.join(' · ') || `本地模型 ${view.model}；时间轴来自音频分段`,
        });
        break;
      }
    } catch (error) {
      failWith(error, '音频转写失败');
    } finally {
      patch({ busy: false, task: { ...INITIAL_TASK } });
    }
  }, [failWith, getCues, listTranscripts, patch, setNotice, state.settings, state.video, tryExistingCaptions]);

  /** 导入 SRT/VTT 文件。 */
  const importSubtitleFile = useCallback(
    async (file: File) => {
      const video = state.video;
      if (!video) return;
      patch({ busy: true, notice: null });
      try {
        assertImportSize(file.size);
        const text = await file.text();
        const lower = file.name.toLowerCase();
        const kind = lower.endsWith('.vtt') ? 'vtt' : 'srt';
        const parsed = parseSubtitleText(text, kind);
        const { revision } = await saveTranscript({
          videoId: video.id,
          language: 'imported',
          sourceKind: kind,
          generationKind: inferGenerationKind(file.name),
          trackLabel: file.name.slice(0, 120),
          sourceHash: hashTranscript(parsed.cues),
          cues: parsed.cues,
        });
        const transcripts = await listTranscripts(video.id);
        patch({ transcript: revision, cues: parsed.cues, transcripts, translations: new Map(), track: null, summary: null });
        setNotice({
          kind: parsed.warnings.length > 0 ? 'warn' : 'ok',
          title: `已导入 ${parsed.cues.length} 条字幕`,
          detail: parsed.warnings.slice(0, 3).join('；') || undefined,
        });
      } catch (error) {
        failWith(error, '字幕导入失败');
      } finally {
        patch({ busy: false });
      }
    },
    [failWith, patch, setNotice, state.video],
  );

  const selectTranscript = useCallback(
    async (transcriptId: string) => {
      const transcripts = state.transcripts;
      const revision = transcripts.find((item) => item.id === transcriptId);
      if (!revision) return;
      try {
        const cues = await getCues(revision.id);
        patch({ transcript: revision, cues, translations: new Map(), summary: null });
      } catch (error) {
        failWith(error, '读取字幕版本失败');
      }
    },
    [failWith, patch, state.transcripts],
  );

  const ensureProvider = useCallback(async () => {
    const settings = state.settings ?? (await loadSettings());
    const apiKey = await loadApiKey(settings);
    patch({ settings, apiKeyPresent: Boolean(apiKey) });
    try {
      return assertProviderReady(settings, apiKey);
    } catch (error) {
      failWith(error, 'AI 尚未连接');
      return null;
    }
  }, [failWith, patch, state.settings]);

  /** 翻译：按段校验后保存；部分失败保留已完成结果。 */
  const translateAll = useCallback(async () => {
    const video = state.video;
    const transcript = state.transcript;
    if (!video || !transcript || state.cues.length === 0) return;
    const provider = await ensureProvider();
    if (!provider) return;
    const controller = new AbortController();
    abortRef.current = controller;
    const allPlans = planChunks(state.cues);
    const endpoint = normalizeEndpoint(provider.baseUrl);
    const configFingerprint = buildCacheKey({
      videoId: video.id,
      transcriptId: transcript.id,
      sourceHash: transcript.sourceHash,
      task: 'translate',
      targetLanguage: provider.targetLanguage,
      providerId: provider.providerId,
      normalizedEndpoint: endpoint.requestUrl,
      modelId: provider.modelId,
      range: cueRangeKey(state.cues),
      paramsFingerprint: String(provider.maxTokens),
    });
    const configSnapshot = {
      providerId: provider.providerId,
      providerName: provider.providerName,
      requestUrl: endpoint.requestUrl,
      modelId: provider.modelId,
      baseUrl: endpoint.baseUrl,
      targetLanguage: provider.targetLanguage,
      maxTokens: provider.maxTokens,
    };

    // 恢复同一输入的旧任务：只重发未完成段落，已完成段落直接复用。
    const knownJobs = await listJobs(video.id);
    const reusable = await findReusableJob(knownJobs, {
      type: 'translate',
      videoId: video.id,
      transcriptId: transcript.id,
      inputHash: transcript.sourceHash,
      configFingerprint,
    });
    const job = reusable
      ? await markJobRunning(reusable.job)
      : buildJobRecord({
          type: 'translate',
          videoId: video.id,
          transcriptId: transcript.id,
          inputHash: transcript.sourceHash,
          configSnapshot,
          configFingerprint,
          plans: allPlans,
          ownerId: 'local',
        });
    const doneKeys = new Set(job.chunkPlan.filter((chunk) => chunk.status === 'done').map((chunk) => chunk.chunkKey));
    const plans = allPlans.filter((plan) => !doneKeys.has(plan.chunkKey));
    if (!reusable) await putJob(job);

    patch({
      busy: true,
      notice: null,
      task: {
        label: doneKeys.size > 0 ? `继续翻译（已完成 ${doneKeys.size}/${allPlans.length}）` : '翻译字幕',
        completed: doneKeys.size,
        total: allPlans.length,
        state: 'running',
      },
    });
    const collected: { cueId: string; translatedText: string }[] = [];
    const existing = reusable
      ? assembleByPlan<{ cueId: string; translatedText: string }[]>(job, reusable.completed).flat()
      : [];
    collected.push(...existing);
    let usageTotal: UsageInfo = { promptTokens: null, completionTokens: null, totalTokens: null };
    try {
      const outcome = await runTranslateTask({
        videoId: video.id,
        transcriptId: transcript.id,
        title: video.title,
        provider,
        plans,
        targetLanguage: provider.targetLanguage,
        inputHash: transcript.sourceHash,
        configFingerprint,
        configSnapshot,
        cacheKeyPrefix: configFingerprint,
        // 每段结果与任务状态在同一事务提交：关闭弹窗后重开可只补未完成段落。
        onCommit: async (chunkKey, payload, usage) => {
          await commitChunk(job, chunkKey, payload, usage);
        },
        onStateChange: (taskState, completed) =>
          patch({
            task: {
              label: doneKeys.size > 0 ? '继续翻译' : '翻译字幕',
              completed: doneKeys.size + completed,
              total: allPlans.length,
              state: mapTaskState(taskState),
            },
          }),
        signal: controller.signal,
      });
      const finalResults = await listChunkResults(job.id);
      const resultMap = new Map(finalResults.filter((row) => row.status === 'done').map((row) => [row.chunkKey, row.payload]));
      const rebuilt = assembleByPlan<{ cueId: string; translatedText: string }[]>(job, resultMap).flat();
      collected.length = 0;
      collected.push(...rebuilt);
      await markJobState(job, outcome.job.state);
      usageTotal = outcome.usage;
      const map = new Map(collected.map((item) => [item.cueId, item.translatedText]));
      await saveTranslation({
        id: `tr-${video.id}-${transcript.id}-${provider.providerId}-${provider.modelId}-${provider.targetLanguage}`,
        videoId: video.id,
        transcriptId: transcript.id,
        targetLanguage: provider.targetLanguage,
        cacheKey: configFingerprint,
        items: collected,
        status: outcome.job.state === 'completed' ? 'complete' : 'partial',
        createdAt: new Date().toISOString(),
      });
      patch({ translations: map });
      const usageText = usageTotal.totalTokens === null ? '用量未知' : `用量 ${usageTotal.totalTokens} tokens`;
      if (outcome.job.state === 'completed') {
        setNotice({ kind: 'ok', title: `翻译完成（${collected.length} 条）`, detail: usageText });
      } else {
        setNotice({
          kind: 'warn',
          title: `部分翻译完成（${collected.length}/${state.cues.length} 条）`,
          detail: [usageText, outcome.unknownChunks > 0 ? '有请求未收到响应，可能已在服务端处理' : '']
            .filter(Boolean)
            .join(' · '),
        });
      }
    } catch (error) {
      failWith(error, '翻译失败');
    } finally {
      abortRef.current = null;
      patch({ busy: false });
      if (state.task.state === 'running') patch({ task: { ...INITIAL_TASK } });
    }
  }, [ensureProvider, failWith, patch, setNotice, state.cues, state.task.state, state.transcript, state.video]);

  /** 自动学习只更新总结记录，不覆盖译文、任务进度或手写笔记。 */
  const applyAutoSummary = useCallback((summary: SummaryRecord | null, videoId: string, transcriptId: string) => {
    setState((previous) => {
      if (previous.video?.id !== videoId || previous.transcript?.id !== transcriptId) return previous;
      if (previous.summary?.id === summary?.id && previous.summary?.createdAt === summary?.createdAt &&
        previous.summary?.autoStream?.completedNodes === summary?.autoStream?.completedNodes) return previous;
      return { ...previous, summary };
    });
  }, []);
  const autoSummary = useAutoSummary(state.video?.id, state.transcript?.id, applyAutoSummary);

  /** 翻译/录音的取消仍走原工作流，不误停后台自动学习。 */
  const cancelTask = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    patch({ task: { ...state.task, state: 'cancelled' } });
  }, [patch, state.task]);

  /** 笔记自动保存：只有事务成功才显示已保存。 */
  const flushNote = useCallback(async () => {
    const pending = pendingNote.current;
    const video = state.video;
    if (!pending || !video) return;
    pendingNote.current = null;
    try {
      const saved = await saveNote(video.id, pending.markdown, pending.revision);
      patch({ noteRevision: saved.revision, saveState: 'saved' });
    } catch (error) {
      const normalized = toAppError(error);
      patch({ saveState: 'error' });
      setNotice({
        kind: 'error',
        title: '笔记未保存',
        detail: normalized.message,
        action: '请复制或导出当前内容后重试',
      });
    }
  }, [patch, setNotice, state.video]);

  const flushRef = useRef(flushNote);
  flushRef.current = flushNote;

  const updateNote = useCallback(
    (markdown: string) => {
      patch({ noteMarkdown: markdown, saveState: 'pending' });
      pendingNote.current = { markdown, revision: state.noteRevision };
      if (noteTimer.current !== null) window.clearTimeout(noteTimer.current);
      noteTimer.current = window.setTimeout(() => {
        void flushRef.current();
      }, 800);
    },
    [patch, state.noteRevision],
  );

  useEffect(() => {
    const handler = () => {
      if (pendingNote.current) void flushNote();
    };
    window.addEventListener('beforeunload', handler);
    document.addEventListener('visibilitychange', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      document.removeEventListener('visibilitychange', handler);
    };
  }, [flushNote]);

  // 分 P 变化时先保存当前笔记，再加载新的记录和订阅；不把旧字幕配给新视频。
  useEffect(() => {
    if (!state.video || !state.context ||
      (state.video.bvid === state.context.bvid && state.video.cid === state.context.cid)) return;
    let cancelled = false;
    void flushRef.current().then(() => { if (!cancelled) void capture(); });
    return () => { cancelled = true; };
  }, [state.context?.bvid, state.context?.cid, state.video?.id, capture]);

  const seek = useCallback(
    async (positionMs: number) => {
      const result = await seekCurrentTab(positionMs);
      if (!result.ok) {
        setNotice({ kind: 'warn', title: '无法跳转到该时间点', detail: result.error?.message });
      }
    },
    [setNotice],
  );

  /** 播放进度跳转；播放/静音等受浏览器策略限制，不再提供控制按钮。 */
  const playback = useCallback(
    async (action: PlaybackAction, value?: number | boolean) => {
      const result = await controlPlayback(action, value);
      if (!result.ok) {
        setNotice({
          kind: 'warn',
          title: action === 'seek' ? '无法跳转到该时间点' : '播放控制未生效',
          detail: result.error?.message ?? '后台没有响应；请确认当前标签页仍是视频页，点「重新识别当前页」后重试。',
        });
        return;
      }
      const next = await getVideoState();
      if (next.ok && next.data) patch({ playback: next.data });
    },
    [patch, setNotice],
  );

  /** 截取当前视频画面：只含视频帧，不含弹幕与页面元素。 */
  const screenshot = useCallback(async () => {
    const result = await captureFrame();
    if (!result.ok || !result.data) {
      setNotice({
        kind: 'warn',
        title: '截图失败',
        detail: result.error?.message ?? '画面尚未就绪，请先播放片刻',
      });
      return;
    }
    patch({ frame: result.data });
    setNotice({ kind: 'ok', title: '已截取当前画面', detail: '可在笔记页插入或下载' });
  }, [patch, setNotice]);

  /** 把截图下载为 PNG 文件。 */
  const downloadFrame = useCallback(() => {
    const frame = state.frame;
    if (!frame || !state.video) return;
    const anchor = document.createElement('a');
    anchor.href = frame.dataUrl;
    anchor.download = `${state.video.bvid}-${Math.floor(frame.positionMs / 1000)}s.png`;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [state.frame, state.video]);

  /**
   * 整段字幕直接总结：字幕有多少就总结多少，结果写入总结并追加进笔记。
   *
   * 与自动学习的区别：这条路径不管有没有播放过，直接覆盖当前字幕版本的全部内容。
   * 失败时整段不落库、不写笔记——半份总结比明确报错更容易误导人。
   */
  const summarizeAll = useCallback(async () => {
    const video = state.video;
    const transcript = state.transcript;
    if (!video || !transcript) return;
    if (state.cues.length === 0) {
      setNotice({ kind: 'warn', title: '当前没有字幕可总结', detail: '请先获取、导入或转写字幕。' });
      return;
    }
    patch({ busy: true, notice: null, task: { label: '整段总结（字幕全部内容）', completed: 0, total: 1, state: 'running' } });
    try {
      const result = await startFullSummary(video.id, transcript.id, true);
      if (!result.ok || !result.data) {
        failWith(result.error ?? appError('UNKNOWN', '整段总结失败'));
        return;
      }
      const [summary, note, transcripts] = await Promise.all([
        latestSummary(video.id), getNote(video.id), listTranscripts(video.id),
      ]);
      patch({
        summary: summary ?? state.summary, noteMarkdown: note?.markdown ?? state.noteMarkdown,
        noteRevision: note?.revision ?? state.noteRevision, transcripts,
        saveState: 'saved',
      });
      setNotice({
        kind: 'ok',
        title: `已总结 ${transcript.cueCount} 条字幕`,
        detail: result.data.noteUpdated ? '结果已写入总结并追加到笔记末尾（未改动你手写的内容）。' : '结果已写入总结。',
      });
    } catch (error) {
      failWith(error, '整段总结失败');
    } finally {
      patch({ busy: false, task: { ...INITIAL_TASK } });
    }
  }, [failWith, patch, setNotice, state.cues.length, state.noteMarkdown, state.noteRevision, state.summary, state.transcript, state.video]);

  const cuesById = useMemo(() => new Map(state.cues.map((cue) => [cue.cueId, cue])), [state.cues]);

  return {
    state: { ...state, autoSummary: autoSummary.snapshot, autoConnectionError: autoSummary.connectionError, autoControlBusy: autoSummary.controlBusy },
    cuesById,
    actions: {
      capture,
      resetTask,
      grantSiteAccess,
      fetchTracks,
      readPageTracks,
      loadTrack,
      importSubtitleFile,
      selectTranscript,
      transcribeAudio,
      translateAll,
      summarizeAll,
      controlAutoLearning: autoSummary.control,
      cancelTask,
      updateNote,
      flushNote,
      seek,
      playback,
      screenshot,
      downloadFrame,
      clearFrame: () => patch({ frame: null }),
      setNotice,
      reloadSettings: loadSettingsInto,
    },
  };
}

function sortByCreated(transcripts: TranscriptRevision[]): TranscriptRevision[] {
  return [...transcripts].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

function mapTaskState(state: string): TaskProgress['state'] {
  switch (state) {
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'running';
  }
}

/** 把后台进度映射为资料库里的一行状态说明。 */
export function describeLibraryProgress(progress: SummaryProgressInfo): string {
  return `${progress.message} · 已保存 ${progress.completed}/${progress.total} 个节点`;
}
