/** 本机 Whisper 唯一入口。音频不使用聊天 Base URL / Key，也不回退云端。 */
import { appError, isAppError } from '../domain/errors';
import type { TranscriptionSegment } from './client';

export const LOCAL_WHISPER_CLIENT = 'video-study-local-v1';
export const DEFAULT_LOCAL_WHISPER_URL = 'http://127.0.0.1:8765';
export const DEFAULT_WHISHPER_URL = 'http://127.0.0.1:8082';

/** 两种本机后端：内置同步服务（8765），或 Whishper 容器（8082，异步任务）。 */
export type WhisperBackend = 'local' | 'whishper';

export interface LocalWhisperConfig {
  baseUrl: string;
  /** 空字符串为自动识别，与摘要目标语言无关。 */
  language: string;
  /** 缺省按 'local' 处理，保持旧配置可直接使用。 */
  backend: WhisperBackend;
  /** 仅 Whishper 使用：tiny / small；本地后端忽略。 */
  model: string;
}

export const DEFAULT_LOCAL_WHISPER: LocalWhisperConfig = {
  baseUrl: DEFAULT_LOCAL_WHISPER_URL,
  language: '',
  backend: 'local',
  model: '',
};

export function localWhisperOrigin(raw: string): string {
  let url: URL;
  try { url = new URL(raw.trim()); } catch { throw appError('BAD_REQUEST', '本地 Whisper 地址无效'); }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/', '/v1', '/v1/'].includes(url.pathname)) {
    throw appError('BAD_REQUEST', 'Whisper 只允许本机 127.0.0.1 或 localhost 地址，不允许云端地址或鉴权参数');
  }
  return url.origin;
}

export function normalizeLocalWhisper(config: LocalWhisperConfig): LocalWhisperConfig {
  const language = config.language.trim().toLowerCase();
  if (language && !/^[a-z]{2,3}$/.test(language)) throw appError('BAD_REQUEST', '转写语言请留空或填写 zh / en 等语言代码');
  const backend: WhisperBackend = config.backend === 'whishper' ? 'whishper' : 'local';
  const model = (config.model ?? '').trim().toLowerCase();
  if (model && !/^[a-z0-9._-]{1,32}$/.test(model)) throw appError('BAD_REQUEST', 'Whisper 模型名格式无效');
  // Whishper 走自己的 `/api` 路径与异步任务，不套用本地服务的路径白名单。
  if (backend === 'whishper') {
    let url: URL;
    try { url = new URL((config.baseUrl || DEFAULT_WHISHPER_URL).trim()); } catch {
      throw appError('BAD_REQUEST', 'Whishper 地址无效');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        url.username || url.password || url.search || url.hash) {
      throw appError('BAD_REQUEST', 'Whishper 只允许本机 127.0.0.1 或 localhost 地址');
    }
    return { baseUrl: url.origin, language, backend, model: model || 'tiny' };
  }
  return { baseUrl: localWhisperOrigin(config.baseUrl), language, backend, model };
}

export interface WhisperHealth { service: 'video-study-whisper'; status: 'ready'; model: string; }

async function requestLocal(
  config: LocalWhisperConfig, path: string, init: RequestInit,
  options: { signal?: AbortSignal; timeoutMs: number; fetchImpl?: typeof fetch },
): Promise<unknown> {
  const origin = localWhisperOrigin(config.baseUrl);
  if (options.signal?.aborted) throw appError('ABORTED', '已取消本地转写');
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, options.timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await (options.fetchImpl ?? fetch)(`${origin}${path}`, {
      ...init,
      headers: { ...init.headers, 'X-VideoStudy-Client': LOCAL_WHISPER_CLIENT },
      credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      // 不回显服务端正文（可能含文件路径、音频内容或堆栈）。
      const message = response.status === 503 ? '本地 Whisper 模型尚未就绪，请检查本地服务窗口' :
        response.status === 429 ? '本地 Whisper 正在处理另一段音频，请稍后重试' :
        response.status === 413 ? '录音分片超出本地服务大小限制' :
        response.status === 403 ? '本地 Whisper 拒绝了该扩展，请核对允许的扩展 ID' :
        response.status === 422 ? '本地 Whisper 无法解码这段音频' : `本地 Whisper 执行失败（HTTP ${response.status}）`;
      throw appError('LOCAL_WHISPER_ERROR', message, { httpStatus: response.status });
    }
    const text = await response.text();
    if (text.length > 2 * 1024 * 1024) throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 返回超过大小上限');
    try { return JSON.parse(text) as unknown; } catch { throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 返回的不是 JSON'); }
  } catch (cause) {
    if (isAppError(cause)) throw cause;
    if (controller.signal.aborted) throw options.signal?.aborted
      ? appError('ABORTED', '已取消本地转写') : appError('TIMEOUT', '本地 Whisper 转写超时；未自动重试');
    throw appError('LOCAL_WHISPER_UNAVAILABLE', '无法连接本地 Whisper', {
      detail: '请先运行 scripts/start-local-whisper.ps1，并在设置中核对本地服务地址。音频没有发送到云端。',
    });
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
  }
}

export async function checkLocalWhisper(config: LocalWhisperConfig, fetchImpl?: typeof fetch): Promise<WhisperHealth> {
  const normalized = normalizeLocalWhisper(config);
  if (normalized.backend === 'whishper') {
    const { checkWhishper } = await import('./whishper');
    const ready = await checkWhishper(normalized, fetchImpl);
    return { service: 'video-study-whisper', status: 'ready', model: ready.model };
  }
  const value = await requestLocal(normalized, '/health', { method: 'GET' }, { timeoutMs: 5_000, fetchImpl });
  const health = value as Partial<WhisperHealth> | null;
  if (health?.service !== 'video-study-whisper' || health.status !== 'ready' || typeof health.model !== 'string') {
    throw appError('LOCAL_WHISPER_ERROR', '该地址不是已就绪的视频学习 Whisper 服务');
  }
  return health as WhisperHealth;
}

/**
 * 只接收真实分段时间，并把它限制在「这一片真实存在的音频」之内。
 *
 * 为什么不能直接用 `durationMs` 卡死：`durationMs` 来自录音端的墙钟估算
 * （`performance.now()` 差值，再与媒体推进取小），而 Whisper 解析的是**真实音频流**。
 * WebM/Opus 的编码缓冲与容器预填充会让音频略长于墙钟估算，于是最后一句
 * 常常出现 `start` 比 `durationMs` 大几十到几百毫秒——那是真实语音，不是越界。
 * 旧实现一律当「越界」抛错，导致整片丢失并显示「时间戳超出实际录音片段」。
 *
 * 现在的规则：
 * - 容差只放宽到 `SLACK`，且**不得超过本片在媒体时间轴上的终点**（offsetMs + durationMs），
 *   避免把后续片段的语音错记到本片；
 * - 明显越界（例如 30 秒片段给出 start=40s）仍然整片失败，绝不写入错误字幕；
 * - 时间戳倒序、非数字、负值与空文本的判定完全不变。
 */
const EDGE_SLACK_MS = 1_500;

export function normalizeLocalSegments(payload: unknown, offsetMs: number, durationMs: number): TranscriptionSegment[] {
  if (!Number.isFinite(offsetMs) || offsetMs < 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    throw appError('BAD_REQUEST', '录音片段时间无效');
  }
  const raw = payload as { segments?: unknown; text?: unknown } | null;
  if (!raw || !Array.isArray(raw.segments)) throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 缺少真实分段时间戳');
  if (raw.segments.length > 10_000) throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 返回分段过多');
  // 允许音频比墙钟估算略长，但只到「本片终点」为止。
  const limitMs = durationMs + EDGE_SLACK_MS;
  const segments: TranscriptionSegment[] = [];
  for (const item of raw.segments) {
    const segment = item as { start?: unknown; end?: unknown; text?: unknown } | null;
    if (!segment || typeof segment.start !== 'number' || !Number.isFinite(segment.start) || segment.start < 0 ||
        typeof segment.end !== 'number' || !Number.isFinite(segment.end) || segment.end <= segment.start ||
        typeof segment.text !== 'string') throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 返回无效时间戳或文本');
    const text = segment.text.trim();
    if (!text) continue;
    const start = Math.round(segment.start * 1000);
    const end = Math.min(Math.round(segment.end * 1000), limitMs);
    // 超出容差的起点一定是错片（例如 30 秒片段给出 40 秒），仍然拒绝。
    if (start >= limitMs || end <= start) throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 时间戳超出实际录音片段');
    segments.push({ startMs: offsetMs + start, endMs: offsetMs + end, text });
  }
  if (!segments.length && typeof raw.text === 'string' && raw.text.trim()) {
    throw appError('LOCAL_WHISPER_ERROR', '本地 Whisper 有文本但没有可核验的分段，未补造时间戳');
  }
  return segments.sort((a, b) => a.startMs - b.startMs);
}

export async function transcribeLocalAudio(options: {
  config: LocalWhisperConfig; audio: Blob; offsetMs: number; durationMs: number;
  signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number;
}): Promise<TranscriptionSegment[]> {
  const config = normalizeLocalWhisper(options.config);
  // Whishper 是异步任务队列，实现放在独立模块；这里只做分流，校验规则共用。
  if (config.backend === 'whishper') {
    const { transcribeWhishper } = await import('./whishper');
    return transcribeWhishper({ ...options, config });
  }
  if (!options.audio.size || options.audio.size > 8 * 1024 * 1024) throw appError('BAD_REQUEST', '录音片段为空或超过 8 MB');
  const payload = await requestLocal(config, '/v1/audio/transcriptions', {
    method: 'POST', body: options.audio,
    headers: { 'Content-Type': options.audio.type || 'audio/webm', ...(config.language ? { 'X-VideoStudy-Language': config.language } : {}) },
  }, { signal: options.signal, timeoutMs: options.timeoutMs ?? 600_000, fetchImpl: options.fetchImpl });
  return normalizeLocalSegments(payload, options.offsetMs, options.durationMs);
}
