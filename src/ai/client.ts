/**
 * OpenAI 兼容 Chat Completions 适配器（技术方案 4.1、4.5）。
 * 只发送文档确认的字段：model、messages、temperature、max_tokens、stream: false。
 * 不附加未经确认的 response_format / 工具调用。
 */
import { appError, toAppError, type AppError } from '../domain/errors';
import { normalizeEndpoint, type NormalizedEndpoint } from '../domain/endpoint';

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export interface ChatRequestOptions {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface ChatResult {
  content: string;
  finishReason: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null };
  requestUrl: string;
  model: string;
}

export const DEFAULT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_TOKENS = 2048;

export function buildRequestBody(options: Pick<ChatRequestOptions, 'modelId' | 'messages' | 'maxTokens' | 'temperature'>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: options.modelId,
    messages: options.messages,
    stream: false,
  };
  body.max_tokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
  if (typeof options.temperature === 'number') body.temperature = options.temperature;
  return body;
}

/** 只从 assistant content 取文本；不使用推理字段冒充正文。 */
export function extractContent(payload: unknown): { content: string; finishReason: string | null } & {
  usage: ChatResult['usage'];
  model: string;
} {
  const record = payload as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') throw appError('BAD_RESPONSE', '响应不是 JSON 对象');
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) throw appError('BAD_RESPONSE', '响应没有 choices');
  const first = choices[0] as Record<string, unknown> | null;
  const message = first?.message as Record<string, unknown> | null;
  const content = typeof message?.content === 'string' ? message.content : '';
  if (!content.trim()) {
    throw appError('BAD_RESPONSE', '模型没有返回正文内容', {
      detail: '可能只返回了推理内容，或该模型不支持当前请求参数',
    });
  }
  const usageRecord = record.usage as Record<string, unknown> | null;
  const asNumber = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
  return {
    content,
    finishReason: typeof first?.finish_reason === 'string' ? first.finish_reason : null,
    usage: {
      promptTokens: asNumber(usageRecord?.prompt_tokens),
      completionTokens: asNumber(usageRecord?.completion_tokens),
      totalTokens: asNumber(usageRecord?.total_tokens),
    },
    model: typeof record.model === 'string' ? record.model : '',
  };
}

/** 模型正文解析与 HTTP 外层解码分开，避免包装说明被误截为 JSON。 */
export { extractJsonText, parseJsonPayload } from './json-output';

export function mapHttpError(status: number, bodyText: string): AppError {
  const detail = sanitizeErrorDetail(bodyText);
  if (status === 401 || status === 403) return appError('AUTH_FAILED', `鉴权失败（HTTP ${status}）`, { detail, httpStatus: status });
  if (status === 402) return appError('QUOTA_EXCEEDED', '余额或套餐额度不足（HTTP 402）', { detail, httpStatus: status });
  if (status === 404) return appError('NOT_FOUND', '接口或模型不存在（HTTP 404）', { detail, httpStatus: status });
  if (status === 413) return appError('TOO_LARGE', '请求体过大（HTTP 413）', { detail, httpStatus: status });
  if (status === 429) return appError('RATE_LIMITED', '请求过于频繁（HTTP 429）', { detail, httpStatus: status });
  if (status === 400 || status === 422) return appError('BAD_REQUEST', `请求参数无效（HTTP ${status}）`, { detail, httpStatus: status });
  if (status >= 500) return appError('SERVER_ERROR', `服务端错误（HTTP ${status}）`, { detail, httpStatus: status });
  return appError('UNKNOWN', `请求失败（HTTP ${status}）`, { detail, httpStatus: status });
}

/** 错误体脱敏并限长：不把整段响应或凭据写入界面与日志。 */
export function sanitizeErrorDetail(bodyText: string): string {
  const withoutSecrets = bodyText
    .replace(/("?(?:api[_-]?key|authorization|token|sessdata)"?\s*[:=]\s*"?)[^"\s,}]+/gi, '$1[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [redacted]')
    .replace(/[A-Za-z0-9._\-]{32,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim();
  return withoutSecrets.slice(0, 300);
}

function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError';
}

/** 创建带超时与外部取消的 signal。 */
function combineSignal(parent: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort();
  parent?.addEventListener('abort', onAbort, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      parent?.removeEventListener('abort', onAbort);
    },
    timedOut: () => timedOut,
  };
}

export async function requestChat(options: ChatRequestOptions): Promise<ChatResult> {
  const endpoint: NormalizedEndpoint = normalizeEndpoint(options.baseUrl);
  if (!options.apiKey.trim()) throw appError('PROVIDER_NOT_CONFIGURED', '缺少 API Key');
  if (!options.modelId.trim()) throw appError('PROVIDER_NOT_CONFIGURED', '缺少模型 ID');

  const doFetch = options.fetchImpl ?? fetch;
  const { signal, cleanup, timedOut } = combineSignal(options.signal, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await doFetch(endpoint.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.apiKey.trim()}`,
      },
      body: JSON.stringify(buildRequestBody(options)),
      // 不携带站点 Cookie；不自动跟随重定向，避免把 Authorization 带到未确认目标。
      credentials: 'omit',
      redirect: 'error',
      signal,
    });
    if (!response.ok) {
      const bodyText = await response.text().catch(() => '');
      throw mapHttpError(response.status, bodyText);
    }
    const raw = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw appError('BAD_RESPONSE', '接口返回的不是 JSON', { detail: sanitizeErrorDetail(raw) });
    }
    const extracted = extractContent(payload);
    return { ...extracted, requestUrl: endpoint.requestUrl };
  } catch (cause) {
    if (isAbortError(cause)) {
      throw timedOut() ? appError('TIMEOUT', '请求超时') : appError('ABORTED', '操作已取消');
    }
    if (cause instanceof TypeError) {
      throw appError('NETWORK_ERROR', '网络请求失败', { detail: sanitizeErrorDetail(cause.message) });
    }
    throw toAppError(cause, 'UNKNOWN', '模型请求失败');
  } finally {
    cleanup();
  }
}

/** 连接测试：只发送不含用户字幕的短文本（技术方案 4.5）。 */
export async function testConnection(options: Omit<ChatRequestOptions, 'messages'>): Promise<ChatResult> {
  return requestChat({
    ...options,
    maxTokens: 64,
    messages: [
      { role: 'system', content: '你是连接测试助手。只回复 OK。' },
      { role: 'user', content: 'ping' },
    ],
  });
}
