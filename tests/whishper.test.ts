import { describe, expect, it, vi } from 'vitest';
import {
  buildWhishperJobUrl, buildWhishperUploadUrl, checkWhishper, transcribeWhishper,
  WHISHPER_DEFAULT_MODEL, WHISHPER_STATUS, whishperOrigin,
} from '../src/asr/whishper';
import { normalizeLocalWhisper, type LocalWhisperConfig } from '../src/asr/local-whisper';

const cfg = (patch: Partial<LocalWhisperConfig> = {}): LocalWhisperConfig => ({
  baseUrl: 'http://127.0.0.1:8082', language: '', backend: 'whishper', model: 'tiny', ...patch,
});

/** 按顺序返回预设响应，并记录每次调用的 URL 与 init。 */
function fakeFetch(steps: Array<() => Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  let index = 0;
  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const step = steps[index];
    index += 1;
    if (!step) throw new Error('unexpected extra fetch');
    return step();
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (body: unknown, status = 200) => () => new Response(JSON.stringify(body), {
  status, headers: { 'Content-Type': 'application/json' },
});

describe('Whishper 地址与 URL 构造', () => {
  it('只接受本机回环地址', () => {
    expect(whishperOrigin('http://127.0.0.1:8082/')).toBe('http://127.0.0.1:8082');
    expect(whishperOrigin('http://localhost:8082')).toBe('http://localhost:8082');
    for (const bad of ['http://192.168.1.9:8082', 'https://example.com', 'http://127.0.0.1:8082?x=1', 'not a url']) {
      expect(() => whishperOrigin(bad)).toThrow();
    }
  });

  it('上传 URL 必须显式带 modelSize 与 language（实测缺少会直接失败）', () => {
    const url = new URL(buildWhishperUploadUrl('http://127.0.0.1:8082', 'tiny', ''));
    expect(url.pathname).toBe('/api/transcriptions');
    expect(url.searchParams.get('modelSize')).toBe('tiny');
    expect(url.searchParams.get('language')).toBe('auto'); // 空语言必须归一成 auto
    expect(new URL(buildWhishperUploadUrl('http://127.0.0.1:8082', 'small', 'zh')).searchParams.get('language')).toBe('zh');
  });

  it('任务 URL 校验 id 形态，拒绝路径注入', () => {
    expect(buildWhishperJobUrl('http://127.0.0.1:8082', '6ad730e1c9ca9e6db36aa2b0'))
      .toBe('http://127.0.0.1:8082/api/transcriptions/6ad730e1c9ca9e6db36aa2b0');
    for (const bad of ['../etc', 'short', 'a/b', '']) {
      expect(() => buildWhishperJobUrl('http://127.0.0.1:8082', bad)).toThrow();
    }
  });

  it('Whishper 后端默认模型为 tiny，并允许切到 small', () => {
    expect(normalizeLocalWhisper(cfg({ model: '' })).model).toBe(WHISHPER_DEFAULT_MODEL);
    expect(normalizeLocalWhisper(cfg({ model: 'small' })).model).toBe('small');
  });
});

describe('Whishper 健康检查', () => {
  it('能列出任务即视为在线', async () => {
    const { impl } = fakeFetch([json([])]);
    await expect(checkWhishper(cfg(), impl)).resolves.toMatchObject({ model: 'tiny' });
  });

  it('返回非数组时说明不像 Whishper，而不是当成就绪', async () => {
    const { impl } = fakeFetch([json({ hello: 1 })]);
    await expect(checkWhishper(cfg(), impl)).rejects.toMatchObject({ code: 'LOCAL_WHISPER_ERROR' });
  });

  it('连不上时给出可操作提示，不伪造就绪', async () => {
    const impl = (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch;
    await expect(checkWhishper(cfg(), impl)).rejects.toMatchObject({ code: 'LOCAL_WHISPER_UNAVAILABLE' });
  });
});

describe('Whishper 转写：上传 → 轮询 → 映射时间轴', () => {
  it('排队后完成，segments 按偏移还原为绝对时间', async () => {
    const { impl, calls } = fakeFetch([
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }),
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.running }),
      json({
        id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.completed,
        result: { segments: [{ start: 0.4, end: 1.9, text: ' 第一句 ' }, { start: 1.9, end: 3.2, text: '第二句' }] },
      }),
    ]);
    const segments = await transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm' }),
      offsetMs: 30_000, durationMs: 30_000, fetchImpl: impl, timeoutMs: 10_000,
    });
    expect(segments).toEqual([
      { startMs: 30_400, endMs: 31_900, text: '第一句' },
      { startMs: 31_900, endMs: 33_200, text: '第二句' },
    ]);
    // 第一次必须是带参数的 POST，后续都是 GET 轮询。
    expect(calls[0]!.init?.method).toBe('POST');
    expect(calls[0]!.url).toContain('modelSize=tiny');
    expect(calls.slice(1).every((call) => call.init?.method === 'GET')).toBe(true);
  });

  it('上传即返回失败状态要立刻报错，不空转轮询', async () => {
    const { impl, calls } = fakeFetch([json({ id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.failed })]);
    await expect(transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      offsetMs: 0, durationMs: 30_000, fetchImpl: impl,
    })).rejects.toMatchObject({ code: 'LOCAL_WHISPER_ERROR' });
    expect(calls).toHaveLength(1);
  });

  it('轮询中出现 failed 要失败，不能返回半截结果', async () => {
    const { impl } = fakeFetch([
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }),
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.failed }),
    ]);
    await expect(transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      offsetMs: 0, durationMs: 30_000, fetchImpl: impl, timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: 'LOCAL_WHISPER_ERROR' });
  });

  it('时间戳越界或倒序时拒绝，不写入错误字幕', async () => {
    const { impl } = fakeFetch([
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }),
      json({
        id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.completed,
        result: { segments: [{ start: 0, end: 5, text: 'ok' }, { start: 40, end: 50, text: '越界' }] },
      }),
    ]);
    await expect(transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      offsetMs: 0, durationMs: 30_000, fetchImpl: impl, timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: 'LOCAL_WHISPER_ERROR' });
  });

  it('只有 text 没有 segments 时报错，不补造时间戳', async () => {
    const { impl } = fakeFetch([
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }),
      json({ id: '6ad730e1c9ca9e6db36aa2b0', status: WHISHPER_STATUS.completed, result: { text: '有文字没分段' } }),
    ]);
    await expect(transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      offsetMs: 0, durationMs: 30_000, fetchImpl: impl, timeoutMs: 10_000,
    })).rejects.toMatchObject({ code: 'LOCAL_WHISPER_ERROR' });
  });

  it('超过时限报超时，不无限轮询', async () => {
    let poll = 0;
    const impl = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        return new Response(JSON.stringify({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }), { status: 200 });
      }
      poll += 1;
      return new Response(JSON.stringify({ id: '6ad730e1c9ca9e6db36aa2b0', status: 0 }), { status: 200 });
    }) as unknown as typeof fetch;
    await expect(transcribeWhishper({
      config: cfg(), audio: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
      offsetMs: 0, durationMs: 30_000, fetchImpl: impl, timeoutMs: 60,
    })).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(poll).toBeLessThan(5);
  });
});
