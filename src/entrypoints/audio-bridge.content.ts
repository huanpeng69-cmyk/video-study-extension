/**
 * 音频录制器（主世界）。
 *
 * 职责单一：收到 AUDIO_START 就录制并把分片推给同 window 的监听者（隔离世界的转发器）。
 * 不接触 API Key、不调用任何转写接口、不直接与后台通信。
 *
 * 为什么必须在主世界：`createMediaElementSource` 绑定的是页面自己的媒体元素管线，
 * 只有页面上下文能稳定接管；跨世界共享的是 DOM 节点而非媒体对象。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { DEFAULT_CHUNK_MS, extractAudioChunks, type RecorderChunk } from '../asr/extract';
import { AUDIO_CANCEL, AUDIO_CHUNK, AUDIO_DONE, AUDIO_ERROR, AUDIO_PROGRESS, AUDIO_START, type AudioBridgeMessage } from '../asr/bridge-protocol';
import { isRecord } from '../lib/guards';
import { vsLog } from '../lib/log';

export default defineContentScript({
  // 通用层按需注入（chrome.scripting, world: 'MAIN'）；下面只声明自动注入范围。
  // B站保持原有体验，其他站点在用户授权后由后台注入同一份脚本。
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    const MARK = '__videoStudyAudioRecorder';
    const scope = window as unknown as Record<string, unknown>;
    if (scope[MARK]) return;
    scope[MARK] = true;

    /** 同一时刻只允许一个录制任务，避免两个 AudioContext 抢同一个媒体元素。 */
    let current: { channel: string; abort: AbortController } | null = null;

    const post = (message: AudioBridgeMessage) => {
      window.postMessage(message, window.location.origin);
    };

    const toBase64 = async (blob: Blob): Promise<string> => {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      // 分块拼接，避免大数组触发 String.fromCharCode 的参数上限。
      let binary = '';
      const step = 0x8000;
      for (let i = 0; i < bytes.length; i += step) {
        binary += String.fromCharCode(...bytes.subarray(i, i + step));
      }
      return btoa(binary);
    };

    const run = async (channel: string, options: { chunkMs?: number; startMs?: number; endMs?: number }) => {
      const video = document.querySelector<HTMLVideoElement>('video');
      if (!video) {
        post({ type: AUDIO_ERROR, channel, message: '页面内找不到 video 元素' });
        return;
      }
      const abort = new AbortController();
      current = { channel, abort };
      vsLog.info('audio:record-start', {
        durationSec: Number.isFinite(video.duration) ? Math.round(video.duration) : 0,
        chunkMs: options.chunkMs ?? DEFAULT_CHUNK_MS,
      });

      let index = 0;
      try {
        const { chunks, mime } = await extractAudioChunks(video, {
          chunkMs: options.chunkMs,
          startMs: options.startMs,
          endMs: options.endMs,
          signal: abort.signal,
          onProgress: (info) => post({ type: AUDIO_PROGRESS, channel, ...info }),
        });

        for (const chunk of chunks as RecorderChunk[]) {
          if (abort.signal.aborted) break;
          post({
            type: AUDIO_CHUNK,
            channel,
            index,
            offsetMs: chunk.offsetMs,
            durationMs: chunk.durationMs,
            base64: await toBase64(chunk.blob),
          });
          index += 1;
        }
        if (abort.signal.aborted) {
          post({ type: AUDIO_ERROR, channel, message: '录制已取消' });
          return;
        }
        post({ type: AUDIO_DONE, channel, mime, total: index });
        vsLog.info('audio:record-done', { chunks: index, mime });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '音频提取失败';
        const aborted = cause instanceof DOMException && cause.name === 'AbortError';
        vsLog.warn('audio:record-failed', { message, aborted });
        post({ type: AUDIO_ERROR, channel, message: aborted ? '录制已取消' : message });
      } finally {
        current = null;
      }
    };

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const data: unknown = event.data;
      if (!isRecord(data) || typeof data.channel !== 'string') return;

      if (data.type === AUDIO_CANCEL) {
        if (current && current.channel === data.channel) {
          vsLog.info('audio:cancel', { reason: typeof data.reason === 'string' ? data.reason : 'requested' });
          current.abort.abort();
        }
        return;
      }

      if (data.type !== AUDIO_START) return;
      if (current) {
        post({ type: AUDIO_ERROR, channel: data.channel, message: '已有录制任务在进行，请稍后再试' });
        return;
      }
      void run(data.channel, {
        chunkMs: typeof data.chunkMs === 'number' ? data.chunkMs : undefined,
        startMs: typeof data.startMs === 'number' ? data.startMs : undefined,
        endMs: typeof data.endMs === 'number' ? data.endMs : undefined,
      });
    });
  },
});
