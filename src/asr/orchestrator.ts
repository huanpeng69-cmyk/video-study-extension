/**
 * 音频转写编排（后台侧）。
 *
 * 分工：
 * - 主世界：录制并切片（只有它能接管 `<video>` 音频）。
 * - 隔离世界转发器：中转分片，接受后台拉取。
 * - 后台：持有 API Key，逐片调用 /audio/transcriptions，并把段内时间还原为原视频时间。
 *
 * 为什么是「边录边转」而不是「录完再转」：
 * - 实时录制 20 分钟视频要 20 分钟，全部攒在内存里既慢又危险；
 * - 每收到一片就转一片，用户可以更早看到字幕，失败也只损失当前片。
 */
import {
  ASR_BEGIN,
  ASR_CANCEL,
  ASR_DRAIN,
  type AsrDrainChunk,
  type AsrDrainReply,
} from './bridge-protocol';
import { transcribeAudio, type TranscriptionSegment } from './client';
import { appError, toAppError, type AppError } from '../domain/errors';
import { vsLog } from '../lib/log';

/** 拉取间隔：兼顾响应速度与 Service Worker 存活。 */
const POLL_INTERVAL_MS = 1_500;
/** 超过这个时间既没有新分片也没有进度，判定录制卡死。 */
const IDLE_TIMEOUT_MS = 120_000;

export interface TranscribeProvider {
  baseUrl: string;
  apiKey: string;
  modelId: string;
  language?: string;
}

export interface RecordOptions {
  tabId: number;
  chunkMs?: number;
  startMs?: number;
  endMs?: number;
  provider: TranscribeProvider;
  onRecordProgress?: (info: { recordedMs: number; totalMs: number; transcribable: number }) => void;
  onTranscribeProgress?: (info: { completed: number; failed: number }) => void;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

export interface TranscribeOutcome {
  segments: TranscriptionSegment[];
  /** 失败的音频分片数（鉴权类错误会直接上抛，不在此统计）。 */
  failedChunks: number;
  recordedMs: number;
  /** 因视频到达结尾而提前结束。 */
  truncated: boolean;
}

/** 生成一次录制会话的通道标识，避免多次点击互相串台。 */
export function makeChannel(): string {
  return `asr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function sendToTab<T>(tabId: number, message: unknown): Promise<T> {
  return chrome.tabs.sendMessage(tabId, message) as Promise<T>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(appError('ABORTED', '已取消音频转写'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 录制并即时转写。
 * 分片一到达就转写，最终按时间排序返回；鉴权/额度类错误立即中断。
 */
export async function recordAndTranscribe(options: RecordOptions): Promise<TranscribeOutcome> {
  const channel = makeChannel();
  const segments: TranscriptionSegment[] = [];
  let failedChunks = 0;
  let recordedMs = 0;
  let totalMs = 0;
  let mime = '';
  let truncated = false;

  const cancelRemote = () => {
    void sendToTab(options.tabId, { type: ASR_CANCEL, payload: { channel } }).catch(() => undefined);
  };

  try {
    const started = await sendToTab<{ ok: boolean; reason?: string }>(options.tabId, {
      type: ASR_BEGIN,
      payload: { channel, chunkMs: options.chunkMs, startMs: options.startMs, endMs: options.endMs },
    }).catch((cause) => {
      throw toAppError(cause, 'PLAYER_NOT_READY', '无法在此页面启动音频录制');
    });

    if (!started?.ok) {
      throw appError('PLAYER_NOT_READY', started?.reason ?? '无法在此页面启动音频录制', {
        detail: '请确认视频页已加载；若刚安装扩展，请刷新页面。',
      });
    }

    vsLog.info('asr:record-start', { chunkMs: options.chunkMs ?? null });

    let idleMs = 0;
    let sawAnyChunk = false;

    for (;;) {
      if (options.signal?.aborted) throw appError('ABORTED', '已取消音频转写');

      const reply = await sendToTab<AsrDrainReply>(options.tabId, { type: ASR_DRAIN, payload: { channel } }).catch(
        (cause) => {
          throw toAppError(cause, 'PLAYER_NOT_READY', '音频录制通道已断开');
        },
      );

      if (!reply?.ok) {
        throw appError('SUBTITLE_READ_FAILED', reply?.reason ?? '音频录制通道已断开');
      }

      if (reply.totalMs > 0) totalMs = reply.totalMs;
      recordedMs = Math.max(recordedMs, reply.recordedMs);
      if (reply.mime) mime = reply.mime;
      options.onRecordProgress?.({ recordedMs, totalMs, transcribable: reply.chunks.length });

      for (const chunk of reply.chunks) {
        sawAnyChunk = true;
        const produced = await transcribeChunk(chunk, mime || reply.mime, options);
        if (produced === null) failedChunks += 1;
        else segments.push(...produced);
      }
      if (reply.chunks.length > 0) options.onTranscribeProgress?.({ completed: segments.length, failed: failedChunks });

      if (reply.error) {
        // 已有分片转写成功时保留结果，但同时让调用方知道录制提前结束。
        if (segments.length === 0) throw appError('SUBTITLE_READ_FAILED', `音频录制失败：${reply.error}`);
        truncated = true;
        vsLog.warn('asr:record-error-partial', { message: reply.error, segments: segments.length });
        break;
      }

      if (reply.done) {
        if (reply.mime) mime = reply.mime;
        truncated = reply.totalMs > 0 && reply.recordedMs + 3_000 < reply.totalMs;
        break;
      }

      // 卡死检测：既没有新分片也没有进度推进。
      idleMs = reply.chunks.length > 0 || recordedMs > 0 ? 0 : idleMs + POLL_INTERVAL_MS;
      if (idleMs >= IDLE_TIMEOUT_MS) {
        cancelRemote();
        throw appError('SUBTITLE_READ_FAILED', '音频录制长时间没有进展', {
          detail: '视频可能已暂停或缓冲卡住。请确认能正常播放后重试。',
        });
      }

      await sleep(POLL_INTERVAL_MS, options.signal);
    }

    if (!sawAnyChunk && segments.length === 0) {
      throw appError('SUBTITLE_READ_FAILED', '没有录到任何音频分片', {
        detail: '视频可能没有音轨、处于静音播放限制，或录制时间太短。',
      });
    }

    segments.sort((a, b) => a.startMs - b.startMs);
    vsLog.info('asr:record-done', {
      segments: segments.length,
      failedChunks,
      recordedMs,
      truncated,
    });
    return { segments, failedChunks, recordedMs, truncated };
  } catch (cause) {
    cancelRemote();
    throw cause;
  }
}

/** 转写单个分片；鉴权/额度类错误直接上抛，普通失败返回 null 由调用方计数。 */
async function transcribeChunk(
  chunk: AsrDrainChunk,
  mime: string,
  options: RecordOptions,
): Promise<TranscriptionSegment[] | null> {
  try {
    const result = await transcribeAudio({
      baseUrl: options.provider.baseUrl,
      modelId: options.provider.modelId,
      apiKey: options.provider.apiKey,
      audio: base64ToBlob(chunk.base64, mime),
      offsetMs: chunk.offsetMs,
      segmentDurationMs: chunk.durationMs,
      language: options.provider.language,
      fileName: fileNameForMime(mime, chunk.index),
      signal: options.signal,
      fetchImpl: options.fetchImpl,
    });
    return result.segments;
  } catch (cause) {
    const error = toAppError(cause, 'UNKNOWN', '该段转写失败');
    if (isFatal(error)) throw error;
    vsLog.warn('asr:chunk-failed', { index: chunk.index, code: error.code, message: error.message });
    return null;
  }
}

export function isFatal(error: AppError): boolean {
  return [
    'AUTH_FAILED',
    'QUOTA_EXCEEDED',
    'PERMISSION_DENIED',
    'PROVIDER_NOT_CONFIGURED',
    'NOT_FOUND',
    'ABORTED',
  ].includes(error.code);
}

export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/webm' });
}

export function fileNameForMime(mime: string, index: number): string {
  const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
  return `chunk-${String(index).padStart(3, '0')}.${ext}`;
}
