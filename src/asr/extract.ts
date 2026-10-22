/**
 * 浏览器内音频提取（主世界）。
 *
 * 做法：把页面 `<video>` 的音轨接到 `MediaStreamAudioDestinationNode`，
 * 用 `MediaRecorder` 实时录制并按片长切段。无需下载媒体文件，也不需要额外权限。
 *
 * 关键约束（踩过的坑，改前务必读懂）：
 * 1. `createMediaElementSource(video)` 对同一元素**只能调用一次**，且一旦调用，
 *    该元素的音频输出就永久改由 AudioContext 路由。因此这里用模块级 WeakMap 复用同一个
 *    AudioContext / source，绝不 `close()` —— 一旦 close，这个 video 会永久无声，
 *    用户必须刷新页面才能恢复。
 * 2. 必须真实播放才能录到声音：浏览器不会解码未播放的媒体。
 * 3. 是实时录制，20 分钟视频约需 20 分钟。调用方必须把这个成本讲清楚。
 * 4. 受保护 / 跨域媒体可能产出静音，此时报错而不是伪造字幕。
 */

export interface RecorderChunk {
  blob: Blob;
  /** 该段在原视频中的起始毫秒。 */
  offsetMs: number;
  /** 该段实际时长毫秒。 */
  durationMs: number;
}

export interface ExtractOptions {
  /** 单片目标时长（毫秒）。 */
  chunkMs?: number;
  /** 起始位置（毫秒）。 */
  startMs?: number;
  /** 结束位置（毫秒）；缺省为视频结尾。 */
  endMs?: number;
  signal?: AbortSignal;
  onProgress?: (info: { recordedMs: number; totalMs: number; chunks: number }) => void;
}

export const DEFAULT_CHUNK_MS = 60_000;
/** 单次转写最长录制时长：避免误点后长时间占用播放器。 */
export const MAX_TOTAL_MS = 30 * 60_000;
/** 播放停滞多久判定为卡住（毫秒）。 */
const STALL_TIMEOUT_MS = 20_000;

/** 选择最合适的容器 MIME：优先 webm/opus，其次 ogg，最后 mp4。 */
export function pickRecorderMime(): string {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  if (typeof MediaRecorder === 'undefined') return '';
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime;
  }
  return '';
}

/** 供转写接口使用、带扩展名的文件名。 */
export function fileNameForMime(mime: string, index: number): string {
  const ext = extensionForMime(mime);
  return `chunk-${String(index).padStart(3, '0')}.${ext}`;
}

export function extensionForMime(mime: string): string {
  if (mime.includes('ogg')) return 'ogg';
  if (mime.includes('mp4')) return 'mp4';
  if (mime.includes('wav')) return 'wav';
  return 'webm';
}

interface AudioRoute {
  ctx: AudioContext;
  source: MediaElementAudioSourceNode;
  destination: MediaStreamAudioDestinationNode;
}

/**
 * 每个 video 元素只建立一次路由，并在后续转写中复用。
 * 用 WeakMap 让元素被回收时自动释放引用。
 */
const ROUTES = new WeakMap<HTMLVideoElement, AudioRoute>();

function getRoute(video: HTMLVideoElement): AudioRoute {
  const existing = ROUTES.get(video);
  if (existing) {
    // AudioContext 可能因浏览器策略被挂起，恢复即可，绝不重建。
    if (existing.ctx.state === 'suspended') void existing.ctx.resume().catch(() => undefined);
    return existing;
  }
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) throw new Error('当前浏览器不支持 Web Audio，无法提取音频');
  const ctx = new Ctor();
  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(video);
  } catch (cause) {
    void ctx.close().catch(() => undefined);
    // 该元素已绑定到别的 AudioContext（页面自身脚本先调用过），无法再取出音轨。
    const message = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`无法接管该播放器的音频（${message}）。请刷新视频页后重试。`);
  }
  const destination = ctx.createMediaStreamDestination();
  source.connect(destination);
  // 同时接回扬声器，否则用户录制期间会听不到声音。
  source.connect(ctx.destination);
  const route: AudioRoute = { ctx, source, destination };
  ROUTES.set(video, route);
  return route;
}

/**
 * 从视频元素录制音频并切段。
 * 会把播放位置移动到 startMs 并开始播放；结束时恢复原静音状态、倍速与位置。
 */
export async function extractAudioChunks(
  video: HTMLVideoElement,
  options: ExtractOptions = {},
): Promise<{ chunks: RecorderChunk[]; mime: string }> {
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    throw new Error('视频时长未知，请等播放器加载完成后再试');
  }
  const durationMs = Math.round(video.duration * 1000);
  const chunkMs = Math.max(5_000, Math.round(options.chunkMs ?? DEFAULT_CHUNK_MS));
  const startMs = Math.max(0, Math.round(options.startMs ?? 0));
  const rawEnd = Math.round(options.endMs ?? durationMs);
  const cappedEnd = Math.min(durationMs, rawEnd, startMs + MAX_TOTAL_MS);
  if (cappedEnd - startMs < 1_000) throw new Error('可录制区间太短，请调整起点');

  const mime = pickRecorderMime();
  if (!mime) throw new Error('当前浏览器不支持 MediaRecorder 音频录制');

  const previousRate = video.playbackRate;
  const previousMuted = video.muted;
  const previousTime = video.currentTime;
  const route = getRoute(video);
  const chunks: RecorderChunk[] = [];

  // 只断开录音用的分支，保留扬声器连接，避免结束后视频无声。
  const releaseRecorderBranch = () => {
    try {
      route.source.disconnect(route.destination);
    } catch {
      /* 已断开 */
    }
  };

  try {
    video.playbackRate = 1; // 变速会改变音调，转写会明显变差。
    video.muted = false; // 即使页面静音，也要恢复音量才能取到音轨。
    video.currentTime = startMs / 1000;
    await video.play().catch(() => undefined);
    await sleep(350, options.signal);

    let recordedMs = 0;
    let index = 0;
    while (recordedMs < cappedEnd - startMs) {
      if (options.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      const currentChunkMs = Math.min(chunkMs, cappedEnd - startMs - recordedMs);
      const recorder = new MediaRecorder(route.destination.stream, { mimeType: mime });
      const parts: Blob[] = [];
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) parts.push(event.data);
      };
      const stopped = new Promise<void>((resolve) => {
        recorder.onstop = () => resolve();
      });

      const chunkStart = recordedMs;
      recorder.start();
      // 用真实播放进度而不是纯计时，避免缓冲时时间轴漂移。
      await waitUntil(video, startMs + chunkStart + currentChunkMs, options.signal);
      recorder.stop();
      await stopped;

      const blob = new Blob(parts, { type: mime });
      // 极短的空白段（缓冲导致）直接丢弃，不推进偏移之外的时间基准。
      if (blob.size > 1024) {
        chunks.push({ blob, offsetMs: startMs + chunkStart, durationMs: currentChunkMs });
        index += 1;
      }
      recordedMs += currentChunkMs;
      options.onProgress?.({ recordedMs, totalMs: cappedEnd - startMs, chunks: chunks.length });
    }

    if (chunks.length === 0) throw new Error('没有录到音频数据（视频可能无音轨或受保护）');
    return { chunks, mime };
  } finally {
    // 恢复现场：顺序不能反，先断开录音分支再恢复播放状态。
    releaseRecorderBranch();
    video.pause();
    video.playbackRate = previousRate;
    video.muted = previousMuted;
    if (Number.isFinite(previousTime)) video.currentTime = previousTime;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      window.clearTimeout(timer);
      reject(new DOMException('aborted', 'AbortError'));
    };
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 等视频播放到目标毫秒（或已结束 / 被取消 / 停住太久）。
 * 停滞检测是必要的：缓冲卡死时纯计时会让我们无限期等待。
 */
function waitUntil(video: HTMLVideoElement, targetMs: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    let lastPositionMs = -1;
    let idleMs = 0;
    const check = () => {
      if (signal?.aborted) {
        cleanup();
        reject(new DOMException('aborted', 'AbortError'));
        return;
      }
      const nowMs = video.currentTime * 1000;
      if (nowMs >= targetMs || video.ended) {
        cleanup();
        resolve();
        return;
      }
      if (nowMs === lastPositionMs) {
        idleMs += 200;
        if (idleMs >= STALL_TIMEOUT_MS) {
          cleanup();
          reject(new Error('视频播放停滞，无法继续录音。请确认网络正常后重试。'));
          return;
        }
      } else {
        lastPositionMs = nowMs;
        idleMs = 0;
      }
      // 被页面暂停时主动恢复，否则录制会一直等下去。
      if (video.paused && !video.ended) void video.play().catch(() => undefined);
    };
    const cleanup = () => {
      window.clearInterval(timer);
      video.removeEventListener('ended', check);
    };
    const timer = window.setInterval(check, 200);
    video.addEventListener('ended', check);
    check();
  });
}
