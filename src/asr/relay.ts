/**
 * 音频转发器（隔离世界）。
 *
 * 为什么需要它：主世界的 `window.postMessage` 不会到达 `chrome.runtime.onMessage`。
 * 旧实现让主世界直接「推」给后台，结果后台永远收不到任何分片 —— 这是音频转写
 * 链路断掉的真正原因。这里由隔离世界做中转：
 *   主世界 --postMessage--> 本转发器 --后台拉取--> 后台
 *
 * 为什么用「后台拉取」而不是「转发器推送」：
 * - 后台处理分片时可能在转写请求上等几秒，推送会堆积；
 * - 拉取天然限流：后台一次只取走它准备好的量；
 * - 每 1~2 秒一次的拉取消息能唤起 MV3 Service Worker，长视频录制不会被 30 秒空闲回收。
 */
import {
  AUDIO_CHUNK,
  AUDIO_DONE,
  AUDIO_ERROR,
  AUDIO_PROGRESS,
  makeAudioCancel,
  makeAudioStart,
  type AsrDrainChunk,
  type AsrDrainReply,
} from '../asr/bridge-protocol';
import { isRecord } from '../lib/guards';
import { vsLog } from '../lib/log';

interface Session {
  channel: string;
  chunks: AsrDrainChunk[];
  recordedMs: number;
  totalMs: number;
  done: boolean;
  mime: string;
  error: string | null;
}

export interface AudioRelay {
  /** 开始一次录制；同一时刻只允许一个。 */
  begin(channel: string, options: { chunkMs?: number; startMs?: number; endMs?: number }): { ok: boolean; reason?: string };
  /** 取走已就绪的分片与状态；分片一旦取走即从页面侧移除，避免重复转写。 */
  drain(channel: string): AsrDrainReply;
  /** 取消录制：通知主世界中断并清空会话。 */
  cancel(channel: string): { ok: boolean };
}

function replyError(reason: string): AsrDrainReply {
  return { ok: false, reason, chunks: [], recordedMs: 0, totalMs: 0, done: false, mime: '', error: null };
}

export function createAudioRelay(): AudioRelay {
  let session: Session | null = null;
  /** 结束后保留一份快照，供后台收尾时读到 done / error / mime。 */
  let archived: Session | null = null;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data: unknown = event.data;
    if (!isRecord(data) || typeof data.channel !== 'string') return;
    const active = session;
    if (!active || active.channel !== data.channel) return;

    switch (data.type) {
      case AUDIO_CHUNK: {
        const { index, offsetMs, durationMs, base64 } = data;
        if (typeof index !== 'number' || typeof offsetMs !== 'number' || typeof durationMs !== 'number') return;
        if (typeof base64 !== 'string' || !base64) return;
        active.chunks.push({ index, offsetMs, durationMs, base64 });
        return;
      }
      case AUDIO_PROGRESS: {
        if (typeof data.recordedMs === 'number') active.recordedMs = data.recordedMs;
        if (typeof data.totalMs === 'number') active.totalMs = data.totalMs;
        return;
      }
      case AUDIO_DONE: {
        active.done = true;
        if (typeof data.mime === 'string') active.mime = data.mime;
        vsLog.info('asr:relay-done', { chunks: active.chunks.length, mime: active.mime });
        return;
      }
      case AUDIO_ERROR: {
        active.done = true;
        active.error = typeof data.message === 'string' ? data.message : '音频录制失败';
        vsLog.warn('asr:relay-error', { message: active.error });
        return;
      }
      default:
        return;
    }
  });

  return {
    begin(channel, options) {
      if (session) return { ok: false, reason: '已有音频录制任务在进行' };
      archived = null;
      session = { channel, chunks: [], recordedMs: 0, totalMs: 0, done: false, mime: '', error: null };
      window.postMessage(makeAudioStart(channel, options), window.location.origin);
      return { ok: true };
    },

    drain(channel) {
      const active = session;
      if (!active) {
        if (archived && archived.channel === channel) {
          return {
            ok: true,
            chunks: [],
            recordedMs: archived.recordedMs,
            totalMs: archived.totalMs,
            done: true,
            mime: archived.mime,
            error: archived.error,
          };
        }
        return replyError('没有进行中的音频录制任务');
      }
      if (active.channel !== channel) return replyError('录制通道不匹配');

      const chunks = active.chunks.splice(0, active.chunks.length);
      const reply: AsrDrainReply = {
        ok: true,
        chunks,
        recordedMs: active.recordedMs,
        totalMs: active.totalMs,
        done: active.done,
        mime: active.mime,
        error: active.error,
      };
      if (active.done) {
        archived = { ...active, chunks: [] };
        session = null;
      }
      return reply;
    },

    cancel(channel) {
      if (session && session.channel === channel) {
        window.postMessage(makeAudioCancel(channel, 'page-cancel'), window.location.origin);
        session = null;
      }
      return { ok: true };
    },
  };
}
