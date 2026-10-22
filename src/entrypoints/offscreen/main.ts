/**
 * 音频采集文档（后台离屏文档）。
 *
 * 为什么放在这里：标签页音频采集（tabCapture）只能在扩展自己的文档里建立，
 * 且不能接管网页的 `MediaElementSource`——那样会让站点播放器静音。
 * 这里只做「采集 + 分片上传本地 Whisper」，不接触网页 DOM、不读 Cookie。
 */
import { TabAudioRecorder } from '../../asr/tab-recorder';
import {
  ASR_BACKGROUND_TARGET, ASR_EVENT_TYPE, ASR_OFFSCREEN_TARGET,
  type CaptureEvent, type CaptureStart,
} from '../../asr/tab-protocol';

let recorder: TabAudioRecorder | null = null;

function send(message: unknown): Promise<unknown> {
  return chrome.runtime.sendMessage(message).catch(() => undefined);
}

chrome.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
  const message = raw as { target?: string; type?: string; payload?: unknown } | null;
  if (message?.target !== ASR_OFFSCREEN_TARGET) return false;

  if (message.type === 'start') {
    if (recorder) {
      sendResponse({ ok: false, reason: '已有正在进行的录音' });
      return false;
    }
    const start = message.payload as CaptureStart;
    const emit = async (event: CaptureEvent): Promise<void> => {
      const reply = (await send({
        target: ASR_BACKGROUND_TARGET,
        type: ASR_EVENT_TYPE,
        payload: { id: start.id, event },
      })) as { ok?: boolean } | undefined;
      // 后台明确拒绝（例如会话已失效）时停止采集，避免继续消耗 CPU。
      if (reply && reply.ok === false && event.kind !== 'done') recorder?.stop(true, '后台已结束该转写会话');
    };
    const instance = new TabAudioRecorder(start, emit);
    recorder = instance;
    void instance.start()
      .then(() => sendResponse({ ok: true }))
      .catch((cause: unknown) => {
        recorder = null;
        sendResponse({ ok: false, reason: cause instanceof Error ? cause.message : '无法开始录音' });
      });
    return true;
  }

  if (message.type === 'sample') {
    const sample = message.payload as { positionMs: number; durationMs: number; paused: boolean; ended?: boolean; muted: boolean; volume: number; playbackRate: number } | null;
    if (sample && recorder) recorder.updateSample(sample);
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'stop') {
    recorder?.stop(false, '已按你的操作停止采集', undefined, 'requested');
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// 离屏文档被关闭时释放采集，避免标签页音频长期被占用。
window.addEventListener('pagehide', () => recorder?.stop(false, '采集文档被浏览器关闭，采集已中断', undefined, 'closed'));
