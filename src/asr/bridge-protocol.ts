/**
 * 音频提取的三层协议。
 *
 * 层 1（页面内 postMessage，隔离世界 ↔ 主世界）：
 *   - 主世界负责录制：只能它对 <video> 调用 createMediaElementSource。
 *   - 隔离世界只转发开始/取消请求，不接触音频数据。
 * 层 2（chrome 消息，后台 ↔ 隔离世界转发器）：
 *   - 后台按需「拉取」已录好的分片。为什么不用主世界直接推给后台：
 *     主世界的 postMessage 不会到达 chrome.runtime.onMessage，这是 0.2.x 中断链的根因。
 *   - 拉取式还有第二个好处：每 1~2 秒一次消息事件能让 MV3 Service Worker 保持存活，
 *     长视频录制不会因 30 秒空闲被回收。
 *
 * 请求与事件类型必须分开：postMessage 会派发给同 window 的所有监听器（含发送者自己）。
 */

/** 页面内：请求开始录制。 */
export const AUDIO_START = 'VSN_AUDIO_START';
/** 页面内：请求取消录制。 */
export const AUDIO_CANCEL = 'VSN_AUDIO_CANCEL';
/** 页面内事件：一个音频分片。 */
export const AUDIO_CHUNK = 'VSN_AUDIO_CHUNK';
/** 页面内事件：录制进度。 */
export const AUDIO_PROGRESS = 'VSN_AUDIO_PROGRESS';
/** 页面内事件：录制完成。 */
export const AUDIO_DONE = 'VSN_AUDIO_DONE';
/** 页面内事件：录制失败。 */
export const AUDIO_ERROR = 'VSN_AUDIO_ERROR';

/** chrome 消息：后台要求转发器开始一次录制。 */
export const ASR_BEGIN = 'ASR_BEGIN';
/** chrome 消息：后台拉取尚未取走的分片与状态。 */
export const ASR_DRAIN = 'ASR_DRAIN';
/** chrome 消息：后台要求取消录制。 */
export const ASR_CANCEL = 'ASR_CANCEL';

export interface AudioStartMessage {
  type: typeof AUDIO_START;
  channel: string;
  chunkMs?: number;
  startMs?: number;
  endMs?: number;
}

export interface AudioCancelMessage {
  type: typeof AUDIO_CANCEL;
  channel: string;
  /** 是否来自用户在页面内的取消操作，仅用于日志。 */
  reason?: string;
}

export interface AudioChunkMessage {
  type: typeof AUDIO_CHUNK;
  channel: string;
  index: number;
  offsetMs: number;
  durationMs: number;
  /** base64 编码的音频分段。 */
  base64: string;
}

export interface AudioProgressMessage {
  type: typeof AUDIO_PROGRESS;
  channel: string;
  recordedMs: number;
  totalMs: number;
  chunks: number;
}

export interface AudioDoneMessage {
  type: typeof AUDIO_DONE;
  channel: string;
  mime: string;
  total: number;
}

export interface AudioErrorMessage {
  type: typeof AUDIO_ERROR;
  channel: string;
  message: string;
}

export type AudioBridgeMessage =
  | AudioStartMessage
  | AudioCancelMessage
  | AudioChunkMessage
  | AudioProgressMessage
  | AudioDoneMessage
  | AudioErrorMessage;

/** 后台 → 转发器的开始请求。 */
export interface AsrBeginRequest {
  type: typeof ASR_BEGIN;
  payload: { channel: string; chunkMs?: number; startMs?: number; endMs?: number };
}

/** 后台 → 转发器的拉取请求。 */
export interface AsrDrainRequest {
  type: typeof ASR_DRAIN;
  payload: { channel: string };
}

/** 后台 → 转发器的取消请求。 */
export interface AsrCancelRequest {
  type: typeof ASR_CANCEL;
  payload: { channel: string };
}

export type AsrRelayRequest = AsrBeginRequest | AsrDrainRequest | AsrCancelRequest;

export interface AsrDrainChunk {
  index: number;
  offsetMs: number;
  durationMs: number;
  base64: string;
}

/** 转发器回给后台的一批数据；chunks 一旦交回即从页面侧移除，避免重复转写。 */
export interface AsrDrainReply {
  ok: boolean;
  reason?: string;
  chunks: AsrDrainChunk[];
  recordedMs: number;
  totalMs: number;
  done: boolean;
  mime: string;
  error: string | null;
}

export function makeAudioStart(channel: string, options: { chunkMs?: number; startMs?: number; endMs?: number } = {}): AudioStartMessage {
  return { type: AUDIO_START, channel, ...options };
}

export function makeAudioCancel(channel: string, reason?: string): AudioCancelMessage {
  return { type: AUDIO_CANCEL, channel, ...(reason ? { reason } : {}) };
}

/** 只接受与当前 channel 匹配的事件。 */
export function isAudioEventFor(data: unknown, channel: string): data is AudioBridgeMessage {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { channel?: unknown }).channel === 'string' &&
    (data as { channel: string }).channel === channel &&
    typeof (data as { type?: unknown }).type === 'string'
  );
}
