import { appError, type AppError } from '../domain/errors';
import type { LocalWhisperConfig } from './local-whisper';
import type { TranscriptionSegment } from './client';

export const ASR_OFFSCREEN_TARGET = 'video-study-asr-offscreen';
/**
 * 离屏文档 → 后台的事件消息类型。
 * 必须由两侧共用：曾经离屏发 `'event'`、后台判断 `'ASR_EVENT'`，
 * 结果后台永远收不到任何采集事件，进度死在 0/1。
 */
export const ASR_BACKGROUND_TARGET = 'video-study-asr-background';
export const ASR_EVENT_TYPE = 'event';
export const ASR_CAPTURE_CHUNK_MS = 30_000;
/**
 * 首个分片的切分间隔。
 *
 * 为什么单独设一个更短的值：转写是「边采边转」的，若第一片也等满 30 秒，
 * 用户在前 30 秒里只看得到进度条、一个字都没有，会判断成「不出字」。
 * 首个分片 8 秒就切一次，之后回到 30 秒，兼顾响应速度与请求开销。
 */
export const ASR_FIRST_CHUNK_MS = 8_000;
export const ASR_MAX_QUEUED = 4;
export const ASR_MAX_RECORD_MS = 2 * 60 * 60_000;
/** 采集峰值低于该值即视为数字静音（约 -54 dBFS）：用来区分「没声音」与「有声音但没识别出字」。 */
export const ASR_SILENCE_PEAK = 0.002;
/** 连续多少个位置采样都读到静音，才认定是真实静音操作；单次读取抖动不足以结束整场录音。 */
export const ASR_MUTE_CONFIRM_SAMPLES = 2;
/**
 * 播放位置多久没有推进就判定为「没在播放」。
 * 15 秒：既要能在暂停时尽快结束，又不能把缓冲/短暂卡顿当成结束。
 */
export const ASR_STALL_LIMIT_MS = 15_000;
/** 采集到的音频连续多久完全没有声音，才认为「确实没有可转写的内容」。 */
export const ASR_SILENCE_LIMIT_MS = 30_000;

export interface CaptureSample {
  positionMs: number; durationMs: number; paused: boolean; ended?: boolean;
  muted: boolean; volume: number; playbackRate: number;
}

/** 采集为什么停下来。只用于解释原因，不参与静音判定。 */
export type CaptureStopKind =
  | 'stall' | 'mute' | 'volume' | 'pause' | 'timeline' | 'track-ended'
  | 'queue-full' | 'failed' | 'requested' | 'limit' | 'closed' | 'ended';

/** 每种停止原因对应一句可执行的建议；文案与原因分开，避免把不同原因压成一句话。 */
const STOP_ADVICE: Record<CaptureStopKind, string> = {
  stall: '连续一段时间既没有采集到声音、播放位置也没有推进：暂停、缓冲或还没开始播放都会这样。请让视频真正播放起来，再点「从音频转写」。',
  mute: '这是播放器上的真实静音操作。取消静音后重新开始转写。',
  volume: '播放器音量为 0，采集不到声音。把音量调回来再重新开始。',
  pause: '视频被暂停，暂停期间没有音频。保持播放后重新开始转写。',
  timeline: '跳转或改变倍速会让音频与时间轴错位。请按 1 倍速、不跳转，重新开始转写。',
  'track-ended': '浏览器结束了标签页音频采集，常见于切换音频输出设备（插入/拔出耳机）或站点重建播放器。',
  'queue-full': '本地转写速度低于录音速度。换用更快的模型（tiny）或缩短单次转写时长后重试。',
  failed: '本地转写或音频编码失败。检查本地服务后重试，音频没有发送到云端。',
  requested: '这是你自己停止的采集。需要继续时重新点「从音频转写」。',
  limit: '已达到单次两小时录音上限，请分段转写。',
  closed: '扩展后台或采集文档被浏览器关闭，采集随之中断。重新开始转写即可。',
  ended: '视频已经播放结束，后面没有可采集的音频。',
};

export function stopAdvice(kind: CaptureStopKind | undefined): string {
  return (kind && STOP_ADVICE[kind]) || '采集在产出第一个分片前就结束了；请让视频正常播放后重新开始转写。';
}

/**
 * 「没有内容可转写」的唯一判据：**音频连续静音** 且 **播放位置也冻结**。
 *
 * 为什么必须两个条件同时成立：
 * - 只看播放位置：位置上报依赖页面 → 后台 → 离屏文档这条链路，SW 被回收、消息丢失、
 *   页面暂停上报都会让位置「冻住」，但标签页音频其实还在正常采集 → 误判成「视频没在播」。
 * - 只看音频静音：视频里本来就可能有大段无人声（演示、纯音乐、静音片段）→ 会误杀。
 */
export function shouldStopForSilence(silentForMs: number, frozenForMs: number): boolean {
  return silentForMs > ASR_SILENCE_LIMIT_MS && frozenForMs > ASR_STALL_LIMIT_MS;
}

/**
 * 采集证据：只在离屏文档里如实测量，用于事后区分失败原因。
 * 没有它，「没拿到音频数据」「采集在第一个分片前就停了」「采集到的是静音」「有声音但没识别出字」
 * 只能压成同一句「未识别到语音」。
 */
export interface CaptureEvidence {
  /** 已送进转写的分片数。 */
  chunks: number;
  /** 其中峰值低于静音阈值的分片数。 */
  silentChunks: number;
  /** 完成但没有产出任何音频数据的分片数（真正的采集故障，与静音无关）。 */
  emptyParts: number;
  /** 采集期间是否发生过音频输出设备变化（插入/拔出耳机、切换扬声器）。 */
  deviceChanged: boolean;
  /** 标签页音轨是否被浏览器结束（采集中断）。 */
  trackEnded: boolean;
  /** 整场采集的最大峰值，0~1。 */
  peak: number;
  /** 采集结束时回放图是否仍在运行。 */
  contextRunning: boolean;
  /** 结构化停止原因，用于把「为什么停」说清楚。 */
  stopKind?: CaptureStopKind;
  /** 录音器记录的停止说明原文。 */
  stopReason?: string;
}

export interface LocalAsrState {
  id: string; tabId: number; videoId: string; documentEpoch: string; frameId: number;
  status: 'starting' | 'recording' | 'transcribing' | 'completed' | 'failed';
  model: string; startedAt: number; updatedAt: number;
  recordedMs: number; completedChunks: number; queuedChunks: number;
  warnings: string[]; error?: AppError; transcriptId?: string;
  /** 采集证据，便于事后核对失败原因，也随会话一起持久化。 */
  evidence?: CaptureEvidence;
  /**
   * 已完成分片的分段（绝对时间）。
   *
   * 为什么要放进状态：转写是「边采边转」的，若只在 done 时才落成字幕，
   * 用户在整个采集过程中只能看到进度条、一个字都看不到，误以为没在工作。
   */
  segments?: TranscriptionSegment[];
}
export interface CaptureStart {
  id: string; streamId: string; config: LocalWhisperConfig; sample: CaptureSample;
}
export type CaptureEvent =
  | { kind: 'progress'; recordedMs: number; completedChunks: number; queuedChunks: number; recording: boolean }
  | { kind: 'chunk'; index: number; segments: TranscriptionSegment[]; silent?: boolean; bytes?: number; durationMs?: number }
  | { kind: 'done'; warnings: string[]; error?: AppError; evidence?: CaptureEvidence };

export function isAsrActive(state: LocalAsrState | null | undefined): boolean {
  return Boolean(state && ['starting', 'recording', 'transcribing'].includes(state.status));
}

/**
 * 静音状态只认页面播放器的真实静音操作（`video.muted`）。
 *
 * 为什么必须单独抽出来：音频输出设备切换（插入/拔出耳机）、系统音量、
 * 扩展自己的回放图，都不是「页面被静音」。把它们当成静音判据，
 * 就会出现「只是插了耳机，却提示页面已静音 / 未识别到语音」。
 */
export function isPlayerMuted(sample: CaptureSample): boolean {
  return sample.muted === true;
}

export type CaptureIssueKind = 'invalid' | 'rate' | 'muted' | 'silent-volume' | 'paused' | 'seek';

export interface CaptureIssue {
  kind: CaptureIssueKind;
  reason: string;
  /** 时间轴不可信，当前分片必须丢弃（跳转、换速等）。 */
  discard: boolean;
  /** 必须停止采集；false 只记一条警告并继续录制，等条件恢复。 */
  stop: boolean;
}

/**
 * 判断相邻两次播放状态之间是否发生了不该继续录的事件。
 *
 * 关键约定：
 * 1. 静音只由 `video.muted`（真实静音操作）触发；音量 0 只说明采集不到声音，不叫「静音」。
 * 2. 暂停/静音之前录到的音频是有效语音，`discard=false`，不能连带丢掉。
 * 3. 只有时间轴不可信（跳转、倍速）才 `discard=true`。
 */
export function captureIssue(previous: CaptureSample, next: CaptureSample, elapsedMs: number): CaptureIssue | null {
  if (!Number.isFinite(next.positionMs) || next.positionMs < 0) {
    return { kind: 'invalid', reason: '播放器时间无效', discard: true, stop: true };
  }
  if (next.playbackRate !== 1) {
    return { kind: 'rate', reason: '检测到倍速变化，请按 1 倍速重新开始转写', discard: true, stop: true };
  }
  if (isPlayerMuted(next)) {
    return { kind: 'muted', reason: '播放器已静音，已停止录音；静音前的分片已保留', discard: false, stop: true };
  }
  if (next.volume <= 0) {
    // 音量为 0 不等于「用户按了静音」，也不等于页面被静音：
    // 只如实说明当前采集不到声音，并且不丢已录分片，音量恢复后自动续上。
    return { kind: 'silent-volume', reason: '播放器音量为 0，当前采集不到声音', discard: false, stop: false };
  }
  if (next.ended) return null;
  if (next.paused) {
    // 暂停不前移到「结束整场采集」：用户可能只是先打开弹窗、随后才点播放。
    // 由录音器挂起当前分片、等恢复播放后再续录；长期暂停由静音+停滞 watchdog 兜底。
    return { kind: 'paused', reason: '视频已暂停，暂停期间不继续录制', discard: false, stop: false };
  }
  const progress = next.positionMs - previous.positionMs;
  if (progress < -300 || Math.abs(progress - elapsedMs) > 1_800) {
    return { kind: 'seek', reason: '检测到跳转或播放停滞，已停止录音；当前分片未写入', discard: true, stop: true };
  }
  return null;
}

/**
 * 一片字幕都没有时，按采集证据给出具体原因。
 *
 * 历史缺陷：这里以前无条件返回 `NO_SPEECH`，文案写着「请确认播放未暂停或静音」，
 * 于是「采集到的音频是静音」「采集在产出第一个分片前就结束」都被说成用户静音了页面。
 * 现在按证据分三档：没拿到任何音频数据 / 没产出分片（用录音器自己记录的停止原因）/ 有分片但没识别出字。
 */
export function describeNoSpeech(evidence: CaptureEvidence | undefined): AppError {
  const chunks = evidence?.chunks ?? 0;
  const silentChunks = evidence?.silentChunks ?? 0;
  if (chunks === 0) {
    if ((evidence?.emptyParts ?? 0) > 0) {
      return appError('CAPTURE_UNAVAILABLE', '浏览器没有产出音频数据', {
        detail: '标签页音频采集连一段音频都没有拿到。请确认没有其他程序独占音频设备，然后重新开始转写。',
      });
    }
    // 录音器记录了真实停止原因，直接用它，不再猜。
    const message = evidence?.stopReason?.trim() || '采集在产出第一个分片前就结束了';
    return appError('CAPTURE_INTERRUPTED', message, { detail: stopAdvice(evidence?.stopKind) });
  }
  // 停止原因本身就能解释「为什么没有字」（视频没在播、暂停、静音、音量为 0）时优先用它，
  // 否则会把「根本没出声」误报成「音频是数字静音」，用户又会被引向错误的排查方向。
  const explainsSilence = evidence?.stopKind && ['stall', 'pause', 'mute', 'volume'].includes(evidence.stopKind);
  if (silentChunks >= chunks && explainsSilence) {
    const message = evidence?.stopReason?.trim() || '采集期间没有可用的音频输入';
    return appError('CAPTURE_INTERRUPTED', message, { detail: stopAdvice(evidence?.stopKind) });
  }
  if (silentChunks >= chunks) {
    return appError('CAPTURE_SILENT', '采集到的音频是静音，没有可识别的声音', {
      detail: evidence?.deviceChanged
        ? '采集期间音频输出设备发生变化（例如插入或拔出耳机），Chrome 会重建标签页音频输出。请确认声音已从当前设备正常播放，再重新开始转写。'
        : '页面未静音，但采集到的音频是数字静音。请确认页面音量不为 0、系统输出设备正常，并且声音确实从当前设备播放。',
    });
  }
  if (evidence?.deviceChanged || evidence?.trackEnded) {
    return appError('CAPTURE_INTERRUPTED', '音频采集被中断，没有得到可用字幕', {
      detail: '切换音频输出设备（例如插入耳机）会中断标签页音频采集；已完成的分片会保留，请重新开始转写。',
    });
  }
  return appError('NO_SPEECH', '采集到了声音，但没有识别出可用语音', {
    detail: '可换用更准确的模型（例如 small）后重试；音频始终只在本机转写。',
  });
}
