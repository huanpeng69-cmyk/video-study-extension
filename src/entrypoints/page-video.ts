/**
 * 通用视频页脚本（按需注入，非自动注入）。
 *
 * 设计目标：**不依赖任何特定平台、网络环境或账号体系**。
 * 因此这里只使用浏览器标准能力：
 * - 识别：页面里存在 HTML5 `<video>` 即可用，播放器是哪个由可视面积决定；
 * - 身份：站点源 + URL 推导的稳定键（`deriveWebVideoIdentity`），不请求站点接口、不要求登录；
 * - 字幕：读取页面自身的 `<track>`（已解析 cue 或字幕文件文本）→ 统一转成 WebVTT；
 * - 音频转写：走既有主世界录制器（同样只依赖 `<video>` 与 Web Audio）；
 * - 播放控制与截图：标准 `video` API 与 canvas，不点击页面上的私有控件。
 *
 * 明确不做：不注入页面 UI、不读取页面业务数据、不发送 Cookie、不伪造字幕。
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { createAudioRelay } from '../asr/relay';
import { ASR_BEGIN, ASR_CANCEL, ASR_DRAIN } from '../asr/bridge-protocol';
import { trackCuesToVtt, type PageTrack, type RawTrackCue } from '../domain/page-tracks';
import { parseJson3Captions, parseTimedText } from '../domain/timedtext';
import { deriveWebVideoIdentity, sanitizeSeekMs } from '../domain/video';
import { selectPrimaryVideo } from '../domain/primary-video';
import { postFromContent } from '../lib/messages';
import { vsLog } from '../lib/log';

/** 主世界字幕探针的通信信道（与 page-caption-probe.ts 保持一致）。 */
const CAPTION_CHANNEL = 'video-study-caption-probe';

/**
 * 向主世界探针取字幕轨道。
 *
 * 为什么需要回退：YouTube 这类站点不使用 `<track>`，字幕清单只在页面主世界的
 * 全局对象里。隔离世界读不到该全局，只能请主世界代读。
 * 探针未注入或页面没有该数据时返回空数组——不编造轨道。
 */
function requestProbeTracks(timeoutMs = 1200): Promise<PageTrack[]> {
  return new Promise((resolve) => {
    const requestId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let settled = false;
    const finish = (tracks: PageTrack[]) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      window.clearTimeout(timer);
      resolve(tracks);
    };
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string; requestId?: string; tracks?: unknown } | null;
      if (data?.source !== CAPTION_CHANNEL || data.type !== 'tracks' || data.requestId !== requestId) return;
      finish(Array.isArray(data.tracks) ? (data.tracks as PageTrack[]) : []);
    };
    const timer = window.setTimeout(() => finish([]), timeoutMs);
    window.addEventListener('message', handler);
    try {
      window.postMessage({ source: CAPTION_CHANNEL, type: 'tracks', requestId }, window.location.origin);
    } catch {
      finish([]);
    }
  });
}

/** 请主世界取回某条轨道文本（跨域地址由页面身份请求，仍受 CORS 约束）。 */
function requestProbeText(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; text?: string; reason?: string }> {
  return new Promise((resolve) => {
    const requestId = `cap-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    let settled = false;
    const finish = (value: { ok: boolean; text?: string; reason?: string }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', handler);
      window.clearTimeout(timer);
      resolve(value);
    };
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { source?: string; type?: string; requestId?: string; ok?: boolean; text?: string; reason?: string } | null;
      if (data?.source !== CAPTION_CHANNEL || data.type !== 'read' || data.requestId !== requestId) return;
      finish({ ok: data.ok === true, text: data.text, reason: data.reason });
    };
    const timer = window.setTimeout(() => finish({ ok: false, reason: '字幕读取超时' }), timeoutMs);
    window.addEventListener('message', handler);
    try {
      window.postMessage({ source: CAPTION_CHANNEL, type: 'read', requestId, url }, window.location.origin);
    } catch {
      finish({ ok: false, reason: '无法向页面请求字幕' });
    }
  });
}

/** 字幕文件大小上限：超过则明确失败，不做截断猜测。 */
const MAX_TRACK_BYTES = 2 * 1024 * 1024;

interface PageRuntime {
  epoch: string;
  lastVideoKey: string;
  lastHref: string;
  lastPositionMs: number;
  /** 上一次上报的音量/静音/倍速/暂停组合，用于判断「非位置」变化。 */
  lastState?: string;
}

function makeEpoch(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 主播放器：**优先选正在播放的**，面积只作为同一状态下的排序依据。
 *
 * 为什么不能只看面积：YouTube 等站点会同时存在多个 `<video>`
 * （主播放器、推荐位预览、迷你播放器），滚动页面后主播放器面积可能反而更小。
 * 只看面积会选中一个暂停的预览 video → 上报 `paused: true` →
 * 界面显示「未在播放」，而视频其实正在播放。
 *
 * 判定逻辑本体在 `domain/primary-video.ts`（纯函数，可被单元测试直接驱动）。
 */
export function pickPrimaryVideo(root: ParentNode = document): HTMLVideoElement | null {
  const candidates = Array.from(root.querySelectorAll('video'));
  return selectPrimaryVideo(candidates);
}

/** 页面标题：优先 og:title，其次 h1，最后 document.title；截断避免超长。 */
export function pageTitle(root: Document = document): string {
  const og = root.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim();
  if (og) return og.slice(0, 300);
  const heading = root.querySelector('h1')?.textContent?.trim();
  if (heading) return heading.slice(0, 300);
  return root.title.trim().slice(0, 300);
}

export function load(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__videoStudyPageVideo) return;
  scope.__videoStudyPageVideo = true;

  const runtime: PageRuntime = { epoch: makeEpoch(), lastVideoKey: '', lastHref: location.href, lastPositionMs: -1 };
  let boundVideo: HTMLVideoElement | null = null;
  let boundCleanup: (() => void) | null = null;

  const identityNow = () => deriveWebVideoIdentity(location.href);

  const emitContext = async (force = false): Promise<{ ok: boolean; failure: string | null }> => {
    const video = pickPrimaryVideo();
    const identity = identityNow();
    if (!video) return { ok: false, failure: 'no-video-element' };
    if (!identity) return { ok: false, failure: 'unsupported-url' };
    if (!force && identity.videoKey === runtime.lastVideoKey) return { ok: true, failure: null };
    runtime.lastVideoKey = identity.videoKey;
    runtime.lastHref = location.href;
    await postFromContent({
      type: 'VIDEO_CONTEXT_CHANGED',
      payload: {
        documentEpoch: runtime.epoch,
        snapshot: {
          platform: 'web',
          origin: identity.origin,
          videoKey: identity.videoKey,
          canonicalUrl: identity.canonicalUrl,
          title: pageTitle(),
          pageIndex: 1,
          durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
        },
      },
    });
    vsLog.info('page:context', { origin: identity.origin, hasVideo: true });
    return { ok: true, failure: null };
  };

  /**
   * 上报播放状态。
   *
   * 去重必须只在「位置几乎没变、且其它状态也没变」时生效：
   * 调音量/倍速/静音时位置往往不动，如果被位置去重拦掉，
   * 后台的 TAB_STATES 就不会更新，界面永远显示旧值，看起来像「设置没生效」。
   */
  const reportPosition = async (force = false): Promise<void> => {
    const video = pickPrimaryVideo();
    if (!video) return;
    // 不要用 `lastVideoKey` 当前置条件：它是 emitContext 的产物，
    // 页面状态一变（SPA 换片、后台重启、上下文被重写）它就为空，
    // 于是位置上报被整段跳过，后台永远停在 lastPositionMs=0 / paused=true，
    // 自动学习也就永远不触发。这里按当前地址自愈一次。
    if (!runtime.lastVideoKey) {
      const identity = deriveWebVideoIdentity(location.href);
      if (!identity) return;
      runtime.lastVideoKey = identity.videoKey;
      runtime.lastHref = location.href;
    }
    if (!Number.isFinite(video.currentTime)) return;
    const positionMs = Math.round(video.currentTime * 1000);
    const snapshot = `${video.volume}|${video.muted}|${video.playbackRate}|${video.paused}|${video.ended}`;
    const stateChanged = snapshot !== runtime.lastState;
    if (!force && !stateChanged && Math.abs(positionMs - runtime.lastPositionMs) < 1000) return;
    runtime.lastPositionMs = positionMs;
    runtime.lastState = snapshot;
    await postFromContent({
      type: 'PLAYBACK_POSITION',
      payload: {
        documentEpoch: runtime.epoch,
        videoKey: runtime.lastVideoKey,
        ended: video.ended,
        positionMs,
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
        paused: video.paused,
        muted: video.muted,
        volume: video.volume,
        playbackRate: video.playbackRate,
      },
    });
  };

  /** 换播放器（SPA 换集、切源）后重新绑定事件。 */
  const bindVideo = () => {
    const video = pickPrimaryVideo();
    if (!video) return;
    if (video === boundVideo) return;
    boundCleanup?.();
    boundVideo = video;
    const onProgress = () => void reportPosition();
    const onImmediate = () => void reportPosition(true);
    video.addEventListener('timeupdate', onProgress);
    const events = ['play', 'pause', 'seeked', 'ratechange', 'volumechange', 'loadedmetadata', 'ended', 'durationchange'] as const;
    for (const event of events) video.addEventListener(event, onImmediate);
    boundCleanup = () => {
      video.removeEventListener('timeupdate', onProgress);
      for (const event of events) video.removeEventListener(event, onImmediate);
    };
  };

  const audioRelay = createAudioRelay();

  /**
   * 把取回的字幕文本归一成 WebVTT。
   * 为什么不在这里判断站点：下游统一按 VTT 校验，而 XML timedtext 是通用形态，
   * 不转换就会出现「轨道找到了但解析出 0 条」。
   */
  const toVttText = (text: string): string => {
    const trimmed = text.replace(/^\uFEFF/, '');
    if (trimmed.includes('-->')) return trimmed;
    const converted = parseJson3Captions(trimmed) ?? parseTimedText(trimmed);
    if (converted && converted.cues.length > 0) return trackCuesToVtt(converted.cues);
    return trimmed;
  };

  const readTrackText = async (url: string): Promise<{ ok: boolean; text?: string; reason?: string }> => {
    const element = Array.from(document.querySelectorAll<HTMLTrackElement>('video track')).find((el) => el.src === url);
    const parsed = element?.track;
    if (parsed?.cues && parsed.cues.length > 0) {
      const cues: RawTrackCue[] = [];
      for (const cue of Array.from(parsed.cues)) cues.push({ startTime: cue.startTime, endTime: cue.endTime, text: (cue as VTTCue).text ?? '' });
      return { ok: true, text: trackCuesToVtt(cues) };
    }
    if (!url) return { ok: false, reason: '该轨道没有可读取的地址' };
    try {
      // 以页面身份取回；跨域且无 CORS 头时会失败，此处明确报错而不是伪造。
      const response = await fetch(url, { credentials: 'same-origin' });
      if (!response.ok) return { ok: false, reason: `字幕文件请求失败（HTTP ${response.status}）` };
      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > MAX_TRACK_BYTES) return { ok: false, reason: '字幕文件超过 2 MB，已停止读取' };
      // 站点可能返回 VTT/SRT，也可能返回 XML timedtext；统一归一后再交给下游校验。
      return { ok: true, text: toVttText(new TextDecoder('utf-8').decode(buffer)) };
    } catch (cause) {
      return {
        ok: false,
        reason: `字幕文件读取失败：${cause instanceof Error ? cause.message : '未知原因'}（可能受跨域限制）`,
      };
    }
  };

  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    const data = message as { type?: string; payload?: Record<string, unknown> } | null;
    if (!data?.type) return false;

    if (data.type === ASR_BEGIN) {
      const channel = String(data.payload?.channel ?? '');
      if (!channel) {
        sendResponse({ ok: false, reason: '缺少录制通道标识' });
        return false;
      }
      sendResponse(
        audioRelay.begin(channel, {
          chunkMs: typeof data.payload?.chunkMs === 'number' ? data.payload.chunkMs : undefined,
          startMs: typeof data.payload?.startMs === 'number' ? data.payload.startMs : undefined,
          endMs: typeof data.payload?.endMs === 'number' ? data.payload.endMs : undefined,
        }),
      );
      return false;
    }
    if (data.type === ASR_DRAIN) {
      sendResponse(audioRelay.drain(String(data.payload?.channel ?? '')));
      return false;
    }
    if (data.type === ASR_CANCEL) {
      sendResponse(audioRelay.cancel(String(data.payload?.channel ?? '')));
      return false;
    }

    if (data.type === 'GET_PAGE_CONTEXT') {
      void emitContext(true).then((outcome) => {
        sendResponse({
          ok: outcome.ok,
          documentEpoch: runtime.epoch,
          failure: outcome.failure,
          diag: null,
          videoElements: document.querySelectorAll('video').length,
        });
      });
      return true;
    }

    if (data.type === 'LIST_PAGE_TRACKS') {
      void (async () => {
        const tracks: PageTrack[] = [];
        const seen = new Set<string>();
        // 第一条通道：页面自身的 <track>（通用、无需站点数据）。
        for (const video of Array.from(document.querySelectorAll('video'))) {
          for (const element of Array.from(video.querySelectorAll<HTMLTrackElement>('track'))) {
            const url = element.src || '';
            const parsed = element.track;
            const hasParsedCues = Boolean(parsed?.cues && parsed.cues.length > 0);
            if (!url && !hasParsedCues) continue;
            const label = (element.label || element.srclang || element.kind || '字幕').slice(0, 120);
            const key = `${url}|${label}`;
            if (seen.has(key)) continue;
            seen.add(key);
            tracks.push({
              // 轨道身份用文档内稳定序号，不把 URL 当访问凭据。
              id: `track-${tracks.length}`,
              url,
              label,
              language: element.srclang || '',
              kind: element.kind || 'subtitles',
              hasParsedCues,
            });
          }
        }
        // 第二条通道：站点把字幕放在页面脚本里（如 YouTube）时由主世界代读。
        if (tracks.length === 0) {
          for (const track of await requestProbeTracks()) {
            if (seen.has(track.url)) continue;
            seen.add(track.url);
            tracks.push({ ...track, id: track.id || `track-${tracks.length}` });
          }
        }
        sendResponse({ ok: true, tracks });
      })();
      return true;
    }

    if (data.type === 'READ_PAGE_TRACK') {
      const url = String(data.payload?.url ?? '');
      void (async () => {
        // 先在本世界尝试（同源 / 已有 cue）；失败再请主世界按页面身份取回。
        const local = await readTrackText(url);
        if (!local.ok && url) {
          const remote = await requestProbeText(url);
          // 主世界取回的是站点原始文本（可能是 XML timedtext），与本地通道统一归一。
          sendResponse(remote.ok && typeof remote.text === 'string'
            ? { ok: true, text: toVttText(remote.text) }
            : remote);
          return;
        }
        sendResponse(local);
      })();
      return true;
    }

    const video = pickPrimaryVideo();

    if (data.type === 'CONTROL_PLAYBACK') {
      if (!video) {
        sendResponse({ ok: false, reason: '找不到播放器' });
        return false;
      }
      const action = String(data.payload?.action ?? '');
      const value = data.payload?.value;
      /*
       * 播放类动作必须等 play() / 真正落地后再回答。
       *
       * 历史缺陷：播放动作原先用「立即 resolve 的 fire-and-forget」写法，把拒绝吞掉，
       * 并且立刻回 `{ ok: true }`。YouTube 因自动播放策略拒绝播放时，
       * 后台与界面都以为「已播放」，实际停在 0 秒：
       * 于是 lastPositionMs 永远是 0、playbackPaused 永远是 true、自动学习永不触发。
       * 现在把真实失败原因回传，界面才能给出可操作提示。
       */
      const fail = (reason: string) => { sendResponse({ ok: false, reason }); return false; };
      /** 播放结果等待上限：YouTube 播放器接管后 play() 可能永不 settle，不能无限等。 */
      const withTimeout = (respond: () => void) => {
        let replied = false;
        const once = () => { if (replied) return; replied = true; respond(); };
        window.setTimeout(once, 3_000);
        return { ok: once };
      };
      try {
        switch (action) {
          case 'play':
          case 'toggle': {
            if (action === 'toggle' && !video.paused) {
              video.pause(); void reportPosition(true); sendResponse({ ok: true }); return false;
            }
            if (!video.paused) { void reportPosition(true); sendResponse({ ok: true }); return false; }
            const reply = withTimeout(() => sendResponse({ ok: true }));
            void video.play().then(() => {
              void reportPosition(true);
              reply.ok();
            }).catch((cause: unknown) => {
              const name = cause instanceof Error ? cause.name : '';
              sendResponse({ ok: false, reason: name === 'NotAllowedError'
                ? '浏览器要求先与页面交互才能播放：请在页面里点一下播放按钮（或用页面自身的播放键）'
                : `播放被拒绝：${cause instanceof Error ? cause.message : '未知原因'}` });
            });
            return true;
          }
          case 'seek': {
            const target = sanitizeSeekMs(value, Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0);
            if (target === null) return fail('时间超出范围');
            video.currentTime = target / 1000;
            // 等真正 seeked 再回答：立刻回 ok 会让界面以为已跳转，
            // 而实际还在缓冲，用户看到的是「拖了没反应」。
            const onSeeked = () => {
              video.removeEventListener('seeked', onSeeked);
              void reportPosition(true);
              sendResponse({ ok: true });
            };
            video.addEventListener('seeked', onSeeked, { once: true });
            // 已经在目标位置时不会触发 seeked，兜底短时间内确认。
            window.setTimeout(() => {
              video.removeEventListener('seeked', onSeeked);
              void reportPosition(true);
              sendResponse({ ok: true });
            }, 800);
            return true;
          }
          case 'rate': {
            const rate = typeof value === 'number' && Number.isFinite(value) ? value : 1;
            video.playbackRate = Math.min(2, Math.max(0.5, Math.round(rate * 100) / 100));
            break;
          }
          case 'volume': {
            const volume = typeof value === 'number' && Number.isFinite(value) ? value : 1;
            video.volume = Math.min(1, Math.max(0, volume));
            if (video.volume > 0 && video.muted) video.muted = false;
            break;
          }
          case 'mute':
            video.muted = typeof value === 'boolean' ? value : !video.muted;
            break;
          default:
            sendResponse({ ok: false, reason: '不支持的操作' });
            return false;
        }
        void reportPosition(true);
        sendResponse({ ok: true });
      } catch (cause) {
        sendResponse({ ok: false, reason: cause instanceof Error ? cause.message : '播放控制失败' });
      }
      return false;
    }

    if (data.type === 'SEEK_VIDEO') {
      if (!video) {
        sendResponse({ ok: false, reason: '找不到播放器' });
        return false;
      }
      const target = sanitizeSeekMs(data.payload?.positionMs, Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0);
      if (target === null) {
        sendResponse({ ok: false, reason: '时间超出可用范围' });
        return false;
      }
      video.currentTime = target / 1000;
      void reportPosition(true);
      sendResponse({ ok: true });
      return false;
    }

    if (data.type === 'CAPTURE_FRAME') {
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
        } catch (cause) {
          sendResponse({
            ok: false,
            reason: cause instanceof Error ? `截图失败：${cause.message}` : '截图失败：该视频画面可能受保护',
          });
        }
      })();
      return true;
    }

    return false;
  });

  bindVideo();
  let contextEmitted = false;
  const timer = window.setInterval(() => {
    bindVideo();
    // SPA 站内导航：地址变了就重新识别（同一文档内不会重新注入脚本）。
    if (location.href !== runtime.lastHref) {
      runtime.lastVideoKey = '';
      runtime.lastPositionMs = -1;
      void emitContext(true);
      return;
    }
    // 播放器常晚于脚本挂载（YouTube 等懒加载站点）：未成功上报过就继续重试，
    // 否则用户会一直看到「页面里没有可用的播放器」。
    if (!contextEmitted || !runtime.lastVideoKey) {
      void emitContext(true).then((outcome) => {
        if (outcome.ok) contextEmitted = true;
      });
      return;
    }
    void reportPosition();
  }, 2000);
  window.addEventListener('pagehide', () => {
    window.clearInterval(timer);
    boundCleanup?.();
  });

  void emitContext(true);
}

export default defineUnlistedScript(load);
