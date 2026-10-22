import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractDelta, parseSseFrame, streamChat, type ChatDelta, type StreamChatOptions } from '../src/ai/stream';

const encoder = new TextEncoder();
const options: StreamChatOptions = { baseUrl: 'https://example.test/v1', apiKey: 'private-test-key', modelId: 'test-model', messages: [{ role: 'user', content: 'fixture' }] };
const frame = (text: string, newline = '\n') => `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}${newline}${newline}`;
const finish = (reason = 'stop') => `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: reason }] })}\n\n`;

function response(chunks: (string | Uint8Array)[], contentType = 'text/event-stream', status = 200) {
  const body = new ReadableStream<Uint8Array>({ start(controller) {
    for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
    controller.close();
  } });
  return new Response(body, { status, headers: contentType ? { 'content-type': contentType } : {} });
}
function from(chunks: (string | Uint8Array)[], overrides: Partial<StreamChatOptions> = {}) {
  return streamChat({ ...options, fetchImpl: vi.fn(async () => response(chunks)), ...overrides });
}
async function collect(generator: AsyncGenerator<ChatDelta>) {
  const deltas: ChatDelta[] = [];
  for await (const delta of generator) deltas.push(delta);
  return deltas;
}
afterEach(() => vi.useRealTimers());

describe('SSE 帧与正文', () => {
  it('data 多行、注释、BOM、CRLF 与 data 无冒号', () => {
    expect(parseSseFrame('\uFEFF:event\r\ndata: one\r\ndata:  two\r\ndata')).toBe('one\n two\n');
    expect(parseSseFrame(': keepalive\nretry: 1000')).toBe('');
  });
  it('提取首 choice 正文，不返回 JSON 或推理字段', () => {
    expect(extractDelta(JSON.stringify({ choices: [{ delta: { content: '正文', reasoning_content: 'secret reasoning' } }, { delta: { content: 'other' } }] }))).toBe('正文');
    expect(extractDelta('{"choices":[{"delta":{"role":"assistant","reasoning_content":"not content"}}]}')).toBe('');
    expect(extractDelta('{"choices":[],"usage":{"total_tokens":12}}')).toBe('');
  });
  it.each(['broken-json', 'null', '[]', '{}', '{"choices":[{"delta":{"content":7}}]}', '{"choices":[{}]}'])('无效帧必须失败：%s', (raw) => {
    expect(() => extractDelta(raw)).toThrowError();
  });
  it('TCP 单字节拆包同时覆盖 UTF8 中文 emoji 和 CRLF 边界', async () => {
    const raw = '\uFEFF: ping\r\n\r\n' + frame('你🙂好', '\r\n') + frame('第二帧', '\r\n') + 'data: [DONE]\r\n\r\n';
    const bytes = encoder.encode(raw);
    const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
    const deltas = await collect(from(chunks));
    expect(deltas.filter((delta) => !delta.done).map((delta) => delta.text).join('')).toBe('你🙂好第二帧');
    expect(deltas.at(-1)).toMatchObject({ text: '', done: true });
    expect(deltas.filter((delta) => delta.done)).toHaveLength(1);
  });
  it('一个网络包多帧与末尾无空行 DONE 都可处理', async () => {
    const deltas = await collect(from([frame('A') + frame('B') + 'data: [DONE]']));
    expect(deltas.map((delta) => delta.text).join('')).toBe('AB');
  });
  it('多 data 行组成的 JSON 不是多个模型增量', async () => {
    const deltas = await collect(from(['data: {"choices":\ndata: [{"delta":{"content":"正文"}}]}\n\ndata: [DONE]\n\n']));
    expect(deltas[0]?.text).toBe('正文');
  });
  it('正常 stop + EOF 可完成', async () => {
    const deltas = await collect(from([frame('你好') + finish()]));
    expect(deltas.at(-1)).toEqual({ text: '', done: true, finishReason: 'stop' });
  });
  it('没有 Content-Type 的兼容响应仍按 SSE 解析', async () => {
    expect((await collect(from([], { fetchImpl: async () => response([frame('ok'), 'data: [DONE]'], '') }))).at(-1)?.done).toBe(true);
  });
  it('中途普通 EOF 不冒充成功', async () => {
    await expect(collect(from([frame('未完成正文')]))).rejects.toMatchObject({ code: 'BAD_RESPONSE', message: expect.stringContaining('中断') });
  });
  it.each(['length', 'content_filter'])('finish_reason=%s 是失败，即使有部分正文', async (reason) => {
    await expect(collect(from([frame('部分内容'), finish(reason), 'data: [DONE]']))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('空正文/仅推理或元数据不能完成', async () => {
    await expect(collect(from(['data: {"choices":[{"delta":{"reasoning_content":"x"}}]}\n\ndata: [DONE]']))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('UTF8 末尾半个字符不能静默丢弃', async () => {
    await expect(collect(from([new Uint8Array([0xe4, 0xbd])]))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('不接受普通 JSON 伪装成流式', async () => {
    await expect(collect(from([], { fetchImpl: async () => response(['{"choices":[]}'], 'application/json') })))
      .rejects.toMatchObject({ code: 'BAD_RESPONSE', message: expect.stringContaining('未返回SSE') });
  });
  it.each(['event: error\ndata: server error\n\n', 'data: {"error":{"message":"private-test-key Bearer top-secret"}}\n\n'])('网关错误帧失败且不回显凭据', async (data) => {
    const error = await collect(from([data])).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'BAD_RESPONSE' });
    expect(JSON.stringify(error)).not.toContain('top-secret');
    expect(JSON.stringify(error)).not.toContain('private-test-key');
  });
  it('没有响应 body 时给出明确失败', async () => {
    await expect(collect(from([], { fetchImpl: async () => new Response(null) }))).rejects.toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('单帧超限会中止，不无限累计', async () => {
    await expect(collect(from(['data: ' + 'x'.repeat(256 * 1024 + 1)]))).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});

describe('请求安全、错误分类与资源释放', () => {
  it('stream=true、禁止 Cookie/重定向，结束前释放响应体', async () => {
    const reply = response([frame('ok'), 'data: [DONE]\n\n']);
    const fetchImpl = vi.fn(async () => reply);
    const iterator = from([], { fetchImpl });
    expect((await iterator.next()).value).toEqual({ text: 'ok', done: false });
    expect((await iterator.next()).value).toMatchObject({ done: true });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', redirect: 'error' });
    expect(JSON.parse(init.body as string)).toMatchObject({ stream: true, model: 'test-model' });
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer private-test-key');
    expect(reply.body?.locked).toBe(false);
    expect(init.signal?.aborted).toBe(true);
  });
  it.each([[401, 'AUTH_FAILED'], [403, 'AUTH_FAILED'], [402, 'QUOTA_EXCEEDED'], [404, 'NOT_FOUND'], [400, 'BAD_REQUEST'], [413, 'TOO_LARGE'], [429, 'RATE_LIMITED'], [503, 'SERVER_ERROR']] as const)('HTTP %s 映射为 %s', async (status, code) => {
    const error = await collect(from([], { fetchImpl: async () => response(['private-test-key Bearer secret'], 'text/plain', status) })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code, httpStatus: status });
    expect(JSON.stringify(error)).not.toContain('private-test-key');
    expect(JSON.stringify(error)).not.toContain('Bearer secret');
  });
  it('请求前已取消时不发 fetch', async () => {
    const controller = new AbortController(); controller.abort();
    const fetchImpl = vi.fn();
    await expect(collect(from([], { signal: controller.signal, fetchImpl }))).rejects.toMatchObject({ code: 'ABORTED' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('中途取消能打断忽略 signal 的挂起 read，并释放锁', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame('开始'))); }, cancel });
    const controller = new AbortController();
    const iterator = from([], { signal: controller.signal, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    await iterator.next();
    const pending = iterator.next(); controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' });
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('超时与主动取消分开报告', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(collect(from([], { timeoutMs: 5, fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) })))
      .rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('提前停止消费者也会取消 reader', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(encoder.encode(frame('开始'))); }, cancel });
    const iterator = from([], { fetchImpl: async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }) });
    await iterator.next(); await iterator.return();
    expect(cancel).toHaveBeenCalledOnce(); expect(body.locked).toBe(false);
  });
  it('网络异常分类并脱敏', async () => {
    const error = await collect(from([], { fetchImpl: async () => { throw new TypeError('private-test-key network offline'); } })).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: 'NETWORK_ERROR' });
    expect(JSON.stringify(error)).not.toContain('private-test-key');
  });
});
