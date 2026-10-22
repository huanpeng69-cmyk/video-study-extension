/**
 * 静默自动取字幕（后台执行，弹窗不需要打开）。
 *
 * 为什么放在后台：用户的目标是「播到一半再打开弹窗，直接看到已经累积的自动学习内容」。
 * 若只在弹窗里取字幕，关闭期间不读字幕 → 自动学习会话不存在 → 那段时间的学习永久缺失。
 *
 * 只做「读取页内/站方已有字幕」这一件事：
 * - **不录音、不启动本地转写**：tabCapture 需要用户手势，且会以 1 倍速出声播放整段视频，
 *   静默启动既不被浏览器允许，也会打扰用户。缺字幕时只记录判定结果，等用户决定。
 * - 不绕过任何登录或权限：取不到就如实记录原因，不伪造字幕。
 * - 同一视频只尝试一次，避免每 2 秒的位置上报都触发一轮网络请求。
 */
import { buildPlayerInfoUrl, classifyTracks, fetchSubtitleBody, parseTrackResponse } from '../adapters/bilibili';
import { rankCaptionTracks } from '../domain/page-tracks';
import { hashTranscript, inferGenerationKind, parseSubtitleText, type Cue } from '../domain/transcript';
import type { VideoPlatform } from '../domain/video';
import { toAppError } from '../domain/errors';
import { vsLog } from '../lib/log';
import { getDb, saveTranscript, listTranscripts } from '../storage/db';
import type { RuntimeResponse } from '../lib/messages';

export interface SilentCaptionInput {
  tabId: number;
  videoId: string;
  platform: VideoPlatform;
  aid: string;
  cid: string;
}

/** 已尝试过的 videoId：一次页面寿命内只自动取一次，避免重复网络请求。 */
const attempted = new Set<string>();

/** 测试与切页使用：清除「已尝试」记录，允许对同一视频重新静默取字幕。 */
export function resetSilentCaptionAttempts(): void {
  attempted.clear();
}

export interface SilentCaptionOutcome {
  /** 是否已拿到并落库字幕。 */
  used: boolean;
  /** 拿不到时的原因，供界面与日志区分「确实没字幕」和「读失败」。 */
  reason?: 'no-track' | 'unreadable' | 'failed';
  cues?: number;
  revisionId?: string;
}

type TracksResult = { ok?: boolean; tracks?: unknown[]; reason?: string } | null;

/**
 * 向标签页要字幕轨道并读取正文。
 *
 * 两条通道与弹窗内一致：先页内 `<track>`／站点脚本（通用），再 B 站站方接口。
 * 读取失败与「确实没有」分开记录，不压成同一个结果。
 */
export async function silentFetchCaptions(input: SilentCaptionInput): Promise<SilentCaptionOutcome> {
  if (attempted.has(input.videoId)) return { used: false, reason: 'failed' };
  attempted.add(input.videoId);

  const existing = await listTranscripts(input.videoId).catch(() => []);
  if (existing.length > 0) {
    // 已有字幕版本：会话沿用它即可，不重复取。
    vsLog.info('auto-caption:existing', { versions: existing.length });
    return { used: true, cues: existing[0]?.cueCount ?? 0 };
  }

  const persist = async (params: {
    cues: Cue[]; language: string; trackLabel: string; generationKind: 'human' | 'ai' | 'unknown';
  }): Promise<SilentCaptionOutcome> => {
    if (params.cues.length === 0) return { used: false, reason: 'unreadable' };
    const { revision } = await saveTranscript({
      videoId: input.videoId,
      language: params.language || 'page',
      sourceKind: 'native',
      generationKind: params.generationKind,
      trackLabel: params.trackLabel.slice(0, 120),
      sourceHash: hashTranscript(params.cues),
      cues: params.cues,
    });
    vsLog.info('auto-caption:saved', { cues: params.cues.length, kind: params.generationKind });
    return { used: true, cues: params.cues.length, reason: undefined, revisionId: revision.id } as SilentCaptionOutcome;
  };

  // 通道一：页内 <track> / 站点脚本里的字幕轨道（通用层，不依赖站点接口）。
  const listed = (await chrome.tabs
    .sendMessage(input.tabId, { type: 'LIST_PAGE_TRACKS' })
    .catch(() => null)) as TracksResult;
  const pageTracks = listed?.ok && Array.isArray(listed.tracks) ? listed.tracks as {
    url?: string; label?: string; language?: string; kind?: string;
  }[] : [];
  for (const track of rankCaptionTracks(pageTracks.map((item) => ({
    url: String(item.url ?? ''),
    label: String(item.label ?? ''),
    language: String(item.language ?? ''),
    kind: String(item.kind ?? ''),
  })))) {
    if (!track.url) continue;
    const read = (await chrome.tabs
      .sendMessage(input.tabId, { type: 'READ_PAGE_TRACK', payload: { url: track.url } })
      .catch(() => null)) as { ok?: boolean; text?: string } | null;
    if (!read?.ok || typeof read.text !== 'string') continue;
    let parsed;
    try {
      parsed = parseSubtitleText(read.text, 'vtt');
    } catch {
      continue; // 单条候选解析失败不放弃其它候选。
    }
    if (parsed.cues.length === 0) continue;
    return persist({
      cues: parsed.cues,
      language: track.language,
      trackLabel: track.label || '页内字幕',
      generationKind: inferGenerationKind(track.label),
    });
  }

  // 通道二：B 站站方字幕（需要 aid/cid；非 B 站自然跳过）。
  if (input.platform === 'bilibili' && /^\d{1,20}$/.test(input.aid) && /^\d{1,20}$/.test(input.cid)) {
    try {
      const response = await fetch(buildPlayerInfoUrl(input.aid, input.cid), { credentials: 'include' });
      if (response.ok) {
        const list = parseTrackResponse(await response.json());
        const classified = classifyTracks(list);
        if (classified.kind === 'ok') {
          const track = classified.tracks[0];
          if (track) {
            const body = await fetchSubtitleBody(track.url);
            if (body.cues.length > 0) {
              return persist({
                cues: body.cues, language: track.lan, trackLabel: track.lanDoc || track.lan,
                // 与弹窗里一致：来源类型按标签推断，不臆造。
                generationKind: inferGenerationKind(track.lanDoc || track.lan),
              });
            }
          }
        } else {
          vsLog.info('auto-caption:bilibili-none', { kind: classified.kind, needLogin: list.needLogin });
          return { used: false, reason: 'no-track' };
        }
      }
    } catch (cause) {
      vsLog.warn('auto-caption:bilibili-failed', { code: toAppError(cause).code });
      return { used: false, reason: 'failed' };
    }
  }

  return { used: false, reason: 'no-track' };
}

/** 建立自动学习会话（不请求模型），让随播放的节点能立即累积。 */
export async function prepareAutoLearning(videoId: string): Promise<void> {
  const db = getDb();
  const transcripts = await listTranscripts(videoId);
  const latest = transcripts[0];
  if (!latest) return;
  const { autoSummaryService } = await import('./auto-summary-service');
  await autoSummaryService.prepare(videoId, latest.id);
}

/** 供 background 消息处理器调用：静默取字幕 → 建立会话，失败不抛。 */
export async function silentBootstrap(input: SilentCaptionInput): Promise<RuntimeResponse> {
  try {
    const outcome = await silentFetchCaptions(input);
    if (outcome.used) await prepareAutoLearning(input.videoId);
    return { ok: true, data: outcome };
  } catch (cause) {
    const error = toAppError(cause, 'UNKNOWN', '静默读取字幕失败');
    vsLog.warn('auto-caption:failed', { code: error.code });
    // 静默流程不把错误抛给页面脚本：它只是「顺便尝试」，不应影响播放。
    return { ok: true, data: { used: false, reason: 'failed' } };
  }
}
