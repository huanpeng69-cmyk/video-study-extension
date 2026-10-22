/**
 * 音频转写（OpenAI 兼容 POST /audio/transcriptions）。
 *
 * 设计约束：
 * - 与聊天模型分开：转写模型名单独配置，缺省则视为未启用。
 * - 音频在浏览器内切段上传，避免整段音频超限；每段带起始偏移，便于还原时间轴。
 * - 返回的 segment 时间戳是**段内相对**的，必须加上该段起点才是原视频时间。
 * - 不把转写失败伪装成成功：缺模型、鉴权失败、无内容都返回明确错误。
 */
import { appError, toAppError } from '../domain/errors';
import { normalizeEndpoint } from '../domain/endpoint';

export interface TranscriptionSegment {
  /** 相对整段音频的起点（毫秒）。 */
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptionResult {
  text: string;
  segments: TranscriptionSegment[];
  language: string | null;
}

export interface TranscribeOptions {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  /** 音频 Blob（webm/ogg/mp4 等）。 */
  audio: Blob;
  /** 该段在原视频中的起始毫秒，用于把段内时间戳还原为绝对时间。 */
  offsetMs: number;
  /** 该段音频自身时长（毫秒）。服务不返回 segments 时用它兜底。 */
  segmentDurationMs?: number;
  language?: string;
  /** 提交给服务的文件名，需带扩展名以匹配 MIME。 */
  fileName: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** 转写端点：基地址 + /audio/transcriptions（不重复拼 /v1）。 */
export function buildTranscriptionUrl(baseUrl: string): string {
  const endpoint = normalizeEndpoint(baseUrl);
  return `${endpoint.baseUrl}/audio/transcriptions`;
}

interface RawSegment {
  start?: unknown;
  end?: unknown;
  text?: unknown;
}

interface RawResponse {
  text?: unknown;
  language?: unknown;
  segments?: unknown;
}

/** 把服务返回的秒级 segment 转成带偏移的毫秒区间；缺失 segments 时退化为整段一条。 */
export function normalizeTranscription(
  payload: unknown,
  offsetMs: number,
  fallbackDurationMs: number,
): TranscriptionResult {
  const raw = (payload ?? {}) as RawResponse;
  const text = typeof raw.text === 'string' ? raw.text.trim() : '';
  const language = typeof raw.language === 'string' ? raw.language : null;
  const segments: TranscriptionSegment[] = [];

  if (Array.isArray(raw.segments)) {
    for (const item of raw.segments as RawSegment[]) {
      const startSec = typeof item?.start === 'number' && Number.isFinite(item.start) ? item.start : null;
      const endSec = typeof item?.end === 'number' && Number.isFinite(item.end) ? item.end : null;
      const segText = typeof item?.text === 'string' ? item.text.trim() : '';
      if (!segText || startSec === null) continue;
      const end = endSec !== null && endSec > startSec ? endSec : startSec;
      segments.push({
        startMs: Math.max(0, Math.round(startSec * 1000)) + offsetMs,
        endMs: Math.max(0, Math.round(end * 1000)) + offsetMs,
        text: segText,
      });
    }
  }

  if (segments.length === 0 && text) {
    // 无段落信息：整段作为一条，时间覆盖这一整段音频。
    segments.push({ startMs: offsetMs, endMs: offsetMs + Math.max(0, fallbackDurationMs), text });
  }

  if (segments.length === 0) {
    throw appError('BAD_RESPONSE', '转写返回为空', { detail: '服务未返回可用文本或段落' });
  }
  // 段落时间不得重叠到倒序。
  segments.sort((a, b) => a.startMs - b.startMs);
  return { text: text || segments.map((s) => s.text).join(' '), segments, language };
}

/** 上传一段音频并取回转写结果。 */
export async function transcribeAudio(options: TranscribeOptions): Promise<TranscriptionResult> {
  if (!options.modelId.trim()) {
    throw appError('PROVIDER_NOT_CONFIGURED', '未配置音频转写模型', {
      detail: '请在设置页填写“音频转写模型”，例如 whisper-1。',
    });
  }
  if (!options.apiKey.trim()) throw appError('PROVIDER_NOT_CONFIGURED', '缺少 API Key');

  const url = buildTranscriptionUrl(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 180_000);
  const onAbort = () => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const form = new FormData();
    form.append('file', options.audio, options.fileName);
    form.append('model', options.modelId.trim());
    // verbose_json 才能拿到 segments；不支持时服务会忽略，退化为整段一条。
    form.append('response_format', 'verbose_json');
    if (options.language?.trim()) form.append('language', options.language.trim());

    const response = await doFetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${options.apiKey.trim()}` },
      body: form,
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    });

    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapAsrError(response.status, bodyText);
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!payload) throw appError('BAD_RESPONSE', '转写响应不是 JSON');
    // 无 segments 时，用这一段的实际时长兜底（段内相对 0 → 段时长）。
    return normalizeTranscription(payload, options.offsetMs, options.segmentDurationMs ?? 0);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw options.signal?.aborted ? appError('ABORTED', '已取消转写') : appError('TIMEOUT', '转写请求超时');
    }
    throw toAppError(cause, 'NETWORK_ERROR', '转写请求失败');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

export function mapAsrError(status: number, bodyText: string): ReturnType<typeof appError> {
  const detail = bodyText
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  if (status === 401 || status === 403) return appError('AUTH_FAILED', `转写鉴权失败（HTTP ${status}）`, { detail, httpStatus: status });
  if (status === 402) return appError('QUOTA_EXCEEDED', '转写额度不足（HTTP 402）', { detail, httpStatus: status });
  if (status === 404) return appError('NOT_FOUND', '转写接口或模型不存在（HTTP 404）', { detail, httpStatus: status });
  if (status === 413) return appError('TOO_LARGE', '音频分段过大（HTTP 413）', { detail, httpStatus: status });
  if (status === 429) return appError('RATE_LIMITED', '转写请求过多（HTTP 429）', { detail, httpStatus: status });
  if (status === 400 || status === 422) return appError('BAD_REQUEST', `转写参数不被支持（HTTP ${status}）`, { detail, httpStatus: status });
  if (status >= 500) return appError('SERVER_ERROR', `转写服务错误（HTTP ${status}）`, { detail, httpStatus: status });
  return appError('UNKNOWN', `转写失败（HTTP ${status}）`, { detail, httpStatus: status });
}
