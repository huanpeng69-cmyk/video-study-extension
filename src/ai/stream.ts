/** OpenAI-compatible SSE 聊天：只产出正文增量，完整结束后才产出 done。 */
import { appError, isAppError, type AppError } from '../domain/errors';
import { normalizeEndpoint } from '../domain/endpoint';
import { mapHttpError, sanitizeErrorDetail } from './client';

export interface ChatDelta {
  /** 仅 choices[0].delta.content，不含推理内容。 */
  text: string;
  /** 已收到 [DONE]，或 stop 后正常 EOF，且正文非空。 */
  done: boolean;
  /** 终结增量携带服务端结束原因；未提供时为 null。 */
  finishReason?: string | null;
}

export interface StreamChatOptions {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  messages: { role: 'system' | 'user'; content: string }[];
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const MAX_TIMEOUT_MS = 180_000;
const MAX_FRAME_CHARS = 256 * 1024;
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const DECODE_CHUNK_BYTES = 16 * 1024;

/** 不重试、不携带 Cookie、不跟随重定向；超时覆盖 fetch 与整个响应流。 */
export async function* streamChat(options: StreamChatOptions): AsyncGenerator<ChatDelta, void, void> {
  if (options.signal?.aborted) throw appError('ABORTED', '已取消');
  const apiKey = options.apiKey.trim();
  if (!apiKey) throw appError('PROVIDER_NOT_CONFIGURED', '缺少 API Key');
  if (!options.modelId.trim()) throw appError('PROVIDER_NOT_CONFIGURED', '缺少模型 ID');
  const endpoint = normalizeEndpoint(options.baseUrl);
  const doFetch = options.fetchImpl ?? fetch;
  const detail = (text: string) => sanitizeErrorDetail(text.split(apiKey).join('[redacted]'));
  const controller = new AbortController();
  let interruption: AppError | undefined;
  let responseBody: ReadableStream<Uint8Array> | null = null;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let cleanedUp = false;
  let finishReason: string | null = null;

  const interrupt = (error: AppError) => {
    // 第一个取消原因获胜，后续超时不能把外部取消改成 TIMEOUT。
    if (interruption) return;
    interruption = error;
    controller.abort();
  };
  const onAbort = () => interrupt(appError('ABORTED', '已取消'));
  const throwIfInterrupted = () => { if (interruption) throw interruption; };
  const timeoutMs = Number.isFinite(options.timeoutMs)
    ? Math.max(0, Math.min(options.timeoutMs!, MAX_TIMEOUT_MS))
    : MAX_TIMEOUT_MS;
  const timer = setTimeout(() => interrupt(appError('TIMEOUT', '流式请求超时')), timeoutMs);
  options.signal?.addEventListener('abort', onAbort, { once: true });

  // 不依赖自定义 fetch/ReadableStream 实现响应 signal，挂起的 read 也可取消。
  const waitFor = async <T>(operation: () => Promise<T>): Promise<T> => {
    throwIfInterrupted();
    let onCancel = () => {};
    const cancelled = new Promise<never>((_, reject) => {
      onCancel = () => reject(interruption);
      controller.signal.addEventListener('abort', onCancel, { once: true });
    });
    try {
      return await Promise.race([operation(), cancelled]);
    } finally {
      controller.signal.removeEventListener('abort', onCancel);
    }
  };

  try {
    // 补上检查与注册监听之间已发生取消的情况。
    if (options.signal?.aborted) onAbort();
    const response = await waitFor(() => doFetch(endpoint.requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      body: JSON.stringify({
        model: options.modelId.trim(),
        messages: options.messages,
        max_tokens: options.maxTokens ?? 2048,
        temperature: options.temperature ?? 0.2,
        stream: true,
      }),
      credentials: 'omit',
      redirect: 'error',
      signal: controller.signal,
    }).then((result) => {
      // 即使注入的 fetch 忽略取消并迟到，也不能遗留未消费的响应体。
      if (cleanedUp) {
        if (result.body) cancelQuietly(result.body);
      } else {
        responseBody = result.body;
      }
      return result;
    }));
    throwIfInterrupted();
    if (response.body) reader = response.body.getReader();

    if (!response.ok) {
      // 不使用 response.text()：网关的错误页也必须有界读取。
      let bodyText = '';
      let bytes = 0;
      const decoder = new TextDecoder();
      while (reader && bytes < MAX_ERROR_BYTES) {
        const part = await waitFor(() => reader!.read());
        if (part.done) break;
        const value = part.value.subarray(0, MAX_ERROR_BYTES - bytes);
        bytes += value.byteLength;
        bodyText += decoder.decode(value, { stream: true });
      }
      bodyText += decoder.decode();
      throw mapHttpError(response.status, detail(bodyText));
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    if (contentType && contentType !== 'text/event-stream') {
      throw appError('BAD_RESPONSE', '服务未返回SSE，请确认接口支持流式输出');
    }
    if (!reader) throw appError('BAD_RESPONSE', '流式响应没有正文');

    const decoder = new TextDecoder('utf-8', { fatal: true });
    const decode = (bytes?: Uint8Array) => {
      try {
        // 流式 decoder 会处理跨包 UTF-8 和开头的 BOM；EOF 必须 flush。
        return bytes ? decoder.decode(bytes, { stream: true }) : decoder.decode();
      } catch {
        throw appError('BAD_RESPONSE', '流式响应的 UTF-8 数据无效或已中断');
      }
    };
    const frames = createFrameParser();
    let receivedDone = false;
    let hasContent = false;
    let outputChars = 0;
    let responseBytes = 0;
    const consume = function* (text: string, eof = false): Generator<ChatDelta> {
      for (const frame of frames(text, eof)) {
        throwIfInterrupted();
        const parsed = readSseFrame(frame);
        if (parsed.event.toLowerCase() === 'error') throw gatewayError();
        const data = parsed.data.trim();
        if (!data) continue; // 空行、注释和空 data 心跳。
        if (data === '[DONE]') {
          receivedDone = true;
          return;
        }
        const delta = readDelta(data);
        if (delta.finishReason !== null) finishReason = delta.finishReason;
        if (!delta.text) continue;
        outputChars += delta.text.length;
        if (outputChars > MAX_OUTPUT_CHARS) throw appError('TOO_LARGE', '流式正文超过安全大小上限');
        hasContent ||= /\S/u.test(delta.text);
        yield { text: delta.text, done: false };
      }
    };

    while (!receivedDone) {
      const part = await waitFor(() => reader!.read());
      if (part.done) {
        yield* consume(decode(), true);
        break;
      }
      responseBytes += part.value.byteLength;
      if (responseBytes > MAX_RESPONSE_BYTES) throw appError('TOO_LARGE', '流式响应超过安全大小上限');
      // 大 TCP 分片分段解码，避免在解析之前生成巨大的临时字符串。
      for (let offset = 0; offset < part.value.byteLength && !receivedDone; offset += DECODE_CHUNK_BYTES) {
        yield* consume(decode(part.value.subarray(offset, offset + DECODE_CHUNK_BYTES)));
      }
    }
    throwIfInterrupted();
    if (!receivedDone && finishReason !== 'stop') {
      throw appError('BAD_RESPONSE', '流式响应已中断：未收到 [DONE] 或正常结束标记');
    }
    if (!hasContent) throw appError('BAD_RESPONSE', '模型没有返回正文内容');
  } catch (cause) {
    // 保留 HTTP、解析、长度限制等业务错误，不能被清理时的 abort 覆盖。
    if (isAppError(cause)) throw cause;
    if (interruption) throw interruption;
    if (isRecord(cause) && cause.name === 'AbortError') throw appError('ABORTED', '已取消');
    if (cause instanceof TypeError) {
      throw appError('NETWORK_ERROR', '网络请求失败', { detail: detail(cause.message) });
    }
    throw appError('UNKNOWN', '流式请求失败', {
      detail: cause instanceof Error ? detail(cause.message) : undefined,
    });
  } finally {
    cleanedUp = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    controller.abort();
    if (reader) {
      cancelQuietly(reader);
      try { reader.releaseLock(); } catch { /* 清理异常不能覆盖业务错误。 */ }
    } else if (responseBody) {
      cancelQuietly(responseBody);
    }
  }
  // 先释放资源再 yield 终结项，消费者停在 done 上也不会遗留计时器/锁。
  yield { text: '', done: true, finishReason };
}

/** 只忽略清理失败；不等待可能永不完成的底层 cancel，以免阻塞取消/超时。 */
function cancelQuietly(target: { cancel(): Promise<void> }): void {
  try { void target.cancel().catch(() => {}); } catch { /* 不覆盖原始业务错误。 */ }
}

/** 按 SSE 行结束符切帧，CRLF 即使拆在两个网络包中也只算一次换行。 */
function createFrameParser(): (text: string, eof?: boolean) => Generator<string> {
  let buffer = '';
  let skipLf = false;
  let searchFrom = 0;
  return function* (text: string, eof = false): Generator<string> {
    if (text) {
      if (skipLf && text.startsWith('\n')) text = text.slice(1);
      skipLf = text.endsWith('\r');
      buffer += text.replace(/\r\n?/g, '\n');
    }
    let boundary = buffer.indexOf('\n\n', searchFrom);
    while (boundary >= 0) {
      if (boundary > MAX_FRAME_CHARS) throw appError('TOO_LARGE', 'SSE 帧超过安全大小上限');
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      yield frame;
      boundary = buffer.indexOf('\n\n');
    }
    if (buffer.length > MAX_FRAME_CHARS) throw appError('TOO_LARGE', 'SSE 帧超过安全大小上限');
    searchFrom = Math.max(0, buffer.length - 1);
    if (eof && buffer) {
      const frame = buffer;
      buffer = '';
      yield frame;
    }
  };
}

function readSseFrame(frame: string): { data: string; event: string } {
  const data: string[] = [];
  let event = '';
  for (const line of frame.replace(/^\uFEFF/u, '').split(/\r\n|\r|\n/u)) {
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    if (field === 'event') event = value;
  }
  return { data: data.join('\n'), event };
}

/** 解析一个 SSE 帧；多 data 行以换行连接，注释/空帧返回空串。 */
export function parseSseFrame(frame: string): string {
  return readSseFrame(frame).data;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function gatewayError(): AppError {
  // 网关可能在 message/error 中回显请求正文或凭据，不向 UI 传递此载荷。
  return appError('BAD_RESPONSE', '流式服务返回 error 错误帧，正文未完成');
}

function readDelta(jsonText: string): { text: string; finishReason: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(jsonText);
  } catch {
    throw appError('BAD_RESPONSE', 'SSE data 不是合法 JSON，响应可能已中断');
  }
  if (!isRecord(payload)) throw appError('BAD_RESPONSE', 'SSE data 不是 JSON 对象');
  if (payload.error != null) throw gatewayError();
  if (payload.usage != null && !isRecord(payload.usage)) throw appError('BAD_RESPONSE', 'SSE usage 结构无效');
  const choices = payload.choices;
  // OpenAI 的 include_usage 尾帧，以及仅含 usage 的兼容服务元数据帧。
  if ((choices === undefined || (Array.isArray(choices) && choices.length === 0)) && isRecord(payload.usage)) {
    return { text: '', finishReason: null };
  }
  if (!Array.isArray(choices) || !isRecord(choices[0])) throw appError('BAD_RESPONSE', 'SSE 响应没有有效 choices');
  const first = choices[0];
  const reason = first.finish_reason;
  if (reason != null && (typeof reason !== 'string' || !reason)) throw appError('BAD_RESPONSE', 'SSE finish_reason 结构无效');
  const finishReason = typeof reason === 'string' ? reason : null;
  if (finishReason === 'length') throw appError('BAD_RESPONSE', '模型输出因长度限制被截断（finish_reason=length）');
  if (finishReason === 'content_filter') throw appError('BAD_RESPONSE', '模型输出被内容过滤拦截（finish_reason=content_filter）');
  const delta = first.delta;
  if (delta == null && finishReason !== null) return { text: '', finishReason };
  if (!isRecord(delta)) throw appError('BAD_RESPONSE', 'SSE delta 结构无效');
  if (delta.content != null && typeof delta.content !== 'string') throw appError('BAD_RESPONSE', 'SSE delta.content 不是文本');
  if (delta.role !== undefined && typeof delta.role !== 'string') throw appError('BAD_RESPONSE', 'SSE delta.role 结构无效');
  return { text: typeof delta.content === 'string' ? delta.content : '', finishReason };
}

/** 仅取首个 choice 的正文；合法元数据帧返回空串，无效 JSON/结构必须抛 AppError。 */
export function extractDelta(jsonText: string): string {
  return readDelta(jsonText).text;
}
