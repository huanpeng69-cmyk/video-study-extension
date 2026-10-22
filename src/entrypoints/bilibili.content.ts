/**
 * 内容脚本（隔离世界）：上报视频上下文、同步播放状态、执行播放控制与抓帧。
 * 不读取 Cookie，不持有 API Key，不发送字幕。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mergeSnapshot, resolveSnapshot, type RawPageSnapshot, type SnapshotFailure, type SnapshotOutcome } from '../adapters/bilibili/snapshot';
import { isStateReplyFor, makeStateRequest } from '../adapters/bilibili/bridge-protocol';
import { parseBilibiliVideoUrl, sanitizeSeekMs } from '../domain/video';
import { vsLog } from '../lib/log';
import { postFromContent } from '../lib/messages';
import { createAudioRelay } from '../asr/relay';
import { ASR_BEGIN, ASR_CANCEL, ASR_DRAIN } from '../asr/bridge-protocol';


function videoEl(): HTMLVideoElement | null {
  return document.querySelector<HTMLVideoElement>('video');
}

function makeEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 向主世界请求 __INITIAL_STATE__ 抽取结果。
 *
 * 关键修复：只接受 type 为 STATE_REPLY 的**应答**。旧实现只比对 channel，
 * 而 postMessage 会把请求派发给同一 window 的所有监听器（包括本函数自己注册的那个），
 * 于是请求刚发出就立刻以 snapshot=undefined → null 解析，主世界应答永远收不到。
 */
function requestFromMainWorld(channel: string, timeoutMs = 1200): Promise<RawPageSnapshot | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: RawPageSnapshot | null, reason: string) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      window.clearTimeout(timer);
      vsLog.info('snapshot:mainWorld', { reason, ok: Boolean(value) });
      resolve(value);
    };
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      if (!isStateReplyFor(event.data, channel)) return;
      finish(event.data.snapshot as RawPageSnapshot | null, 'reply');
    };
    const timer = window.setTimeout(() => finish(null, 'timeout'), timeoutMs);
    window.addEventListener('message', handler);
    try {
      window.postMessage(makeStateRequest(channel), window.location.origin);
    } catch {
      finish(null, 'postMessage-failed');
    }
  });
}

function readGlobalVars(): RawPageSnapshot | null {
  const scope = window as unknown as Record<string, unknown>;
  const aid = scope.aid;
  const cid = scope.cid;
  if (typeof aid !== 'string' && typeof aid !== 'number') return null;
  if (typeof cid !== 'string' && typeof cid !== 'number') return null;
  return { aid, cid, bvid: typeof scope.bvid === 'string' ? scope.bvid : undefined };
}

function domTitle(): string {
  const el = document.querySelector<HTMLElement>('h1.video-title, h1');
  const text = el?.textContent?.trim();
  if (text) return text;
  return document.title.replace(/[_\-—|]?\s*哔哩哔哩.*$/, '').trim();
}

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_idle',
  allFrames: false,
  main(ctx) {
    const epoch = makeEpoch();
    let lastReportedPosition = -1;
    let lastVideoKey = '';
    let lastContextHref = '';

    /** 汇总三路来源，并保留失败原因以便区分“主页未就绪 / 缺字段 / 不支持”。 */
    const buildSnapshot = async () => {
      const initial = await requestFromMainWorld(`${epoch}-state`);
      const video = videoEl();
      const outcome = resolveSnapshot({
        href: location.href,
        initial,
        globalVars: readGlobalVars(),
        domTitle: domTitle(),
        videoDurationMs: video && Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
      });
      vsLog.info('snapshot:resolved', {
        ok: outcome.ok,
        failure: outcome.failure,
        ...outcome.diag,
        videoElements: document.querySelectorAll('video').length,
      });
      return outcome;
    };

    const reportPosition = async (force = false) => {
      // URL 已变而新上下文未到时不把旧 cid 的进度交给自动学习。
      if (!lastVideoKey || lastContextHref !== location.href) return;
      const video = videoEl();
      if (!video || !Number.isFinite(video.currentTime)) return;
      const ms = Math.round(video.currentTime * 1000);
      if (!force && Math.abs(ms - lastReportedPosition) < 1000) return;
      lastReportedPosition = ms;
      await postFromContent({
        type: 'PLAYBACK_POSITION',
        payload: {
          documentEpoch: epoch,
          videoKey: lastVideoKey,
          ended: video.ended,
          positionMs: ms,
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
          paused: video.paused,
          muted: video.muted,
          volume: video.volume,
          playbackRate: video.playbackRate,
        },
      });
    };

    const emitContext = async (force = false): Promise<SnapshotOutcome> => {
      const href = location.href;
      const outcome = await buildSnapshot();
      if (href !== location.href) return outcome;
      const snapshot = outcome.snapshot;
      if (!snapshot) return outcome;
      const key = `${snapshot.bvid}:${snapshot.cid}`;
      // 分 P 未变化时不重复上报，减少消息噪音。
      if (!force && key === lastVideoKey) {
        await reportPosition();
        return outcome;
      }
      lastVideoKey = key;
      lastContextHref = href;
      await postFromContent({
        type: 'VIDEO_CONTEXT_CHANGED',
        payload: { documentEpoch: epoch, snapshot },
      });
      await reportPosition(true);
      return outcome;
    };

    /** 记录最近一次失败原因，供 GET_PAGE_CONTEXT 回报给后台。 */
    let lastFailure: SnapshotFailure | null = null;
    let lastDiag: SnapshotOutcome['diag'] | null = null;

    const emitContextUntilReady = async (force: boolean, attempts = 12, intervalMs = 500): Promise<void> => {
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const outcome = await emitContext(force);
        lastFailure = outcome.failure;
        lastDiag = outcome.diag;
        if (lastVideoKey) return; // 上报成功
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
      vsLog.warn('snapshot:gave-up', { failure: lastFailure, ...(lastDiag ?? {}) });
    };

    // 站内导航 / 分 P 切换后刷新绑定。
    let lastHref = location.href;
    const navTimer = window.setInterval(() => {
      if (location.href === lastHref) return;
      lastHref = location.href;
      lastReportedPosition = -1;
      lastVideoKey = '';
      lastContextHref = '';
      void emitContextUntilReady(true);
    }, 800);
    ctx.onInvalidated(() => window.clearInterval(navTimer));

    // 播放器元素可能晚于脚本出现，因此周期探测并绑定事件。
    let boundVideo: HTMLVideoElement | null = null;
    const bindVideo = () => {
      const video = videoEl();
      if (!video || video === boundVideo) return;
      boundVideo = video;
      const notify = () => void reportPosition(true);
      const timeUpdate = () => void reportPosition();
      video.addEventListener('timeupdate', timeUpdate);
      for (const event of ['play', 'pause', 'seeked', 'ratechange', 'volumechange', 'loadedmetadata', 'ended'] as const) {
        video.addEventListener(event, notify);
      }
      ctx.onInvalidated(() => {
        video.removeEventListener('timeupdate', timeUpdate);
        for (const event of ['play', 'pause', 'seeked', 'ratechange', 'volumechange', 'loadedmetadata', 'ended'] as const) {
          video.removeEventListener(event, notify);
        }
      });
    };

    bindVideo();
    const bindTimer = window.setInterval(() => {
      bindVideo();
      // 即使弹窗关闭/视频标签在后台，仍上报真实播放进度，不凭墙钟猜测。
      void reportPosition();
    }, 2000);
    ctx.onInvalidated(() => window.clearInterval(bindTimer));

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void emitContextUntilReady(true);
    });

    const audioRelay = createAudioRelay();

    chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
      const data = message as { type?: string; payload?: Record<string, unknown> } | null;
      const video = videoEl();

      // 音频录制三段式：开始 / 拉取 / 取消。主世界无法直达后台，必须经此中转。
      if (data?.type === ASR_BEGIN) {
        const channel = String(data.payload?.channel ?? '');
        if (!channel) {
          sendResponse({ ok: false, reason: '缺少录制通道标识' });
          return false;
        }
        const result = audioRelay.begin(channel, {
          chunkMs: typeof data.payload?.chunkMs === 'number' ? data.payload.chunkMs : undefined,
          startMs: typeof data.payload?.startMs === 'number' ? data.payload.startMs : undefined,
          endMs: typeof data.payload?.endMs === 'number' ? data.payload.endMs : undefined,
        });
        sendResponse(result);
        return false;
      }

      if (data?.type === ASR_DRAIN) {
        sendResponse(audioRelay.drain(String(data.payload?.channel ?? '')));
        return false;
      }

      if (data?.type === ASR_CANCEL) {
        sendResponse(audioRelay.cancel(String(data.payload?.channel ?? '')));
        return false;
      }

      if (data?.type === 'GET_PAGE_CONTEXT') {
        // 回报结果与失败原因：后台据此区分“脚本未注入 / 播放器未就绪 / 缺字段”，
        // 不再把所有情况压成同一句“请确认视频页已加载完成”。
        void emitContext(true).then((outcome) => {
          sendResponse({
            ok: outcome.ok,
            documentEpoch: epoch,
            failure: outcome.ok ? null : outcome.failure,
            diag: outcome.diag,
            videoElements: document.querySelectorAll('video').length,
          });
        });
        return true;
      }

      if (data?.type === 'CONTROL_PLAYBACK') {
        if (!video) {
          sendResponse({ ok: false, reason: '找不到播放器' });
          return false;
        }
        const action = String(data.payload?.action ?? '');
        const value = data.payload?.value;
        try {
          switch (action) {
            case 'play':
              void video.play().catch(() => undefined);
              break;
            case 'pause':
              video.pause();
              break;
            case 'toggle':
              if (video.paused) void video.play().catch(() => undefined);
              else video.pause();
              break;
            case 'seek': {
              const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
              const target = sanitizeSeekMs(value, durationMs);
              if (target === null) {
                sendResponse({ ok: false, reason: '时间超出范围' });
                return false;
              }
              video.currentTime = target / 1000;
              break;
            }
            case 'rate': {
              const rate = typeof value === 'number' && Number.isFinite(value) ? value : 1;
              const clamped = Math.min(2, Math.max(0.5, Math.round(rate * 100) / 100));
              video.playbackRate = clamped;
              break;
            }
            case 'volume': {
              const volume = typeof value === 'number' && Number.isFinite(value) ? value : 1;
              video.volume = Math.min(1, Math.max(0, volume));
              if (video.volume > 0 && video.muted) video.muted = false;
              break;
            }
            case 'mute': {
              video.muted = typeof value === 'boolean' ? value : !video.muted;
              break;
            }
            default:
              sendResponse({ ok: false, reason: '不支持的操作' });
              return false;
          }
          void reportPosition(true);
          sendResponse({ ok: true });
        } catch (error) {
          sendResponse({ ok: false, reason: error instanceof Error ? error.message : '播放控制失败' });
        }
        return false;
      }

      if (data?.type === 'CAPTURE_FRAME') {
        if (!video) {
          sendResponse({ ok: false, reason: '找不到播放器' });
          return false;
        }
        if (video.readyState < 2 || video.videoWidth === 0) {
          sendResponse({ ok: false, reason: '画面尚未就绪，请先播放片刻' });
          return false;
        }
        void (async () => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context2d = canvas.getContext('2d');
            if (!context2d) throw new Error('无法创建画布');
            context2d.drawImage(video, 0, 0, canvas.width, canvas.height);
            sendResponse({
              ok: true,
              data: {
                dataUrl: canvas.toDataURL('image/png'),
                positionMs: Math.round(video.currentTime * 1000),
                width: canvas.width,
                height: canvas.height,
              },
            });
          } catch (error) {
            // 受保护内容会让画布被污染，此时 toDataURL 抛错。
            sendResponse({
              ok: false,
              reason:
                error instanceof Error
                  ? `截图失败：${error.message}`
                  : '截图失败：该视频画面可能受保护',
            });
          }
        })();
        return true;
      }

      if (data?.type === 'SEEK_VIDEO') {
        if (!video) {
          sendResponse({ ok: false, reason: '找不到播放器' });
          return false;
        }
        const durationMs = Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0;
        const target = sanitizeSeekMs(data.payload?.positionMs, durationMs);
        if (target === null) {
          sendResponse({ ok: false, reason: '时间超出可用范围' });
          return false;
        }
        video.currentTime = target / 1000;
        void reportPosition(true);
        sendResponse({ ok: true });
        return false;
      }

      return false;
    });

    void emitContextUntilReady(true);
  },
});
