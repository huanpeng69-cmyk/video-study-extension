/**
 * 端到端接线回归：后台必须真的处理离屏文档的采集事件。
 *
 * 历史缺陷（本轮修复）：离屏发 `type: 'event'`，后台判断 `'ASR_EVENT'`，
 * 事件被静默丢弃 —— UI 永远 0/1、一个字都不出、退出后进度也全空。
 * 这组测试直接驱动后台的 onMessage 监听器，而不是只断言常量。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyDatabase, setDbForTests } from '../src/storage/db';
import type { RuntimeResponse } from '../src/lib/messages';
import { ASR_BACKGROUND_TARGET, ASR_EVENT_TYPE } from '../src/asr/tab-protocol';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(async () => {}), selectTranscript: vi.fn(async () => null),
  setEnabled: vi.fn(async () => {}), pausePlayback: vi.fn(async () => {}),
  resume: vi.fn(async () => {}), settingsChanged: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ transcriptId: null })), subscribe: vi.fn(() => vi.fn()),
}));
vi.mock('../src/jobs/auto-summary-service', () => ({ autoSummaryService: mocks }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: () => void) => ({ main }) }));
// 转写服务不是本测试对象：只固定它「就绪」，避免依赖真实 Docker / 端口。
vi.mock('../src/asr/local-whisper', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/asr/local-whisper')>(),
  checkLocalWhisper: vi.fn(async () => ({ service: 'video-study-whisper', status: 'ready', model: 'tiny' })),
}));
import background, { resetAsrForTests } from '../src/entrypoints/background';

type MessageHandler = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: RuntimeResponse) => void) => unknown;
let db: StudyDatabase;
let onMessage: MessageHandler;
let session: Map<string, unknown>;
const trusted = { id: 'extension-id', url: 'chrome-extension://extension-id/panel.html' };

function uiSend(type: string, payload: Record<string, unknown> = {}) {
  return new Promise<RuntimeResponse>((resolve) => onMessage({ type, payload }, trusted, resolve));
}
/** 模拟离屏文档上报一个采集事件。 */
function offscreenSend(type: string, payload: Record<string, unknown>) {
  return new Promise<RuntimeResponse>((resolve) => onMessage(
    { target: ASR_BACKGROUND_TARGET, type, payload },
    { id: 'extension-id', url: 'chrome-extension://extension-id/offscreen.html' },
    resolve,
  ));
}

beforeEach(async () => {
  vi.clearAllMocks();
  session = new Map();
  db = new StudyDatabase(`test-asr-${crypto.randomUUID()}`);
  setDbForTests(db);
  await db.open();
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onStartup: event(), onInstalled: event(), onConnect: event(),
      onMessage: { addListener: (listener: MessageHandler) => { onMessage = listener; } },
      sendMessage: vi.fn(async () => ({ ok: true })),
    },
    storage: {
      local: { get: async () => ({}), set: async () => {}, setAccessLevel: async () => {} },
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (values: Record<string, unknown>) => { for (const [k, v] of Object.entries(values)) session.set(k, v); },
        remove: async (key: string) => { session.delete(key); },
        setAccessLevel: async () => {},
      },
      onChanged: event(),
    },
    tabCapture: { getMediaStreamId: vi.fn(async () => 'stream-abc') },
    permissions: { onAdded: event(), onRemoved: event(), contains: async () => true, request: async () => true },
    alarms: { get: async () => ({ name: 'summary-heartbeat' }), create: async () => {}, onAlarm: event() },
    tabs: {
      onRemoved: event(), get: async () => ({ id: 77, url: 'https://example.com/watch?v=abc' }),
      query: async () => [{ id: 77, url: 'https://example.com/watch?v=abc' }],
      create: async () => ({}), sendMessage: vi.fn(async () => ({ ok: true })),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    offscreen: { hasDocument: async () => true, createDocument: vi.fn(async () => {}), closeDocument: vi.fn(async () => {}) },
  });
  (background as unknown as { main: () => void }).main();
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalled());
});
afterEach(async () => {
  // 把当前会话正常结束，避免模块级内存态影响下一个用例
  // （后台只在「已完成/已失败」时才允许开始新会话）。
  const current = await uiSend('ASR_STATE');
  const view = current.data as { id?: string; status?: string } | null;
  if (view?.id && ['starting', 'recording', 'transcribing'].includes(view.status ?? '')) {
    await offscreenSend(ASR_EVENT_TYPE, { id: view.id, event: { kind: 'done', warnings: [] } });
  }
  await db.delete();
  setDbForTests(null);
  session.clear();
});


/** 造一个「正在录音」的会话：先上报页面上下文，再启动转写。 */
async function startSession(): Promise<string> {
  await new Promise<RuntimeResponse>((resolve) => onMessage({
    type: 'VIDEO_CONTEXT_CHANGED',
    payload: {
      documentEpoch: 'epoch-1',
      snapshot: {
        platform: 'web', origin: 'https://example.com', videoKey: '/watch?v=abc',
        canonicalUrl: 'https://example.com/watch?v=abc', title: '测试视频', pageIndex: 1, durationMs: 600_000,
      },
    },
  }, { id: 'extension-id', url: 'https://example.com/watch?v=abc', tab: { id: 77 } as chrome.tabs.Tab, frameId: 0 }, resolve));
  const started = await uiSend('TRANSCRIBE_AUDIO');
  if (!started.ok) throw new Error(`TRANSCRIBE_AUDIO failed: ${JSON.stringify(started.error)}`);
  const state = await uiSend('ASR_STATE');
  return (state.data as { id?: string } | null)?.id ?? '';
}

describe('离屏音频事件必须真正被后台接收', () => {
  it('用协议常量上报 progress → 后台采纳进度（而不是静默丢弃）', async () => {
    const id = await startSession();
    expect(id).toBeTruthy();
    const reply = await offscreenSend(ASR_EVENT_TYPE, {
      id, event: { kind: 'progress', recordedMs: 30_000, completedChunks: 0, queuedChunks: 1, recording: true },
    });
    expect(reply).toMatchObject({ ok: true });
    const after = await uiSend('ASR_STATE');
    expect(after.data).toMatchObject({ id, queuedChunks: 1 });
  });

  it("旧的错误类型 'ASR_EVENT' 不再生效，说明修复前确实收不到", async () => {
    const id = await startSession();
    const reply = await offscreenSend('ASR_EVENT', {
      id, event: { kind: 'progress', recordedMs: 30_000, completedChunks: 9, queuedChunks: 9, recording: true },
    });
    // 未被识别为采集事件 → 走普通分支，进度不会变成 9。
    expect(reply.ok === false || reply.ok === true).toBe(true);
    const after = await uiSend('ASR_STATE');
    expect((after.data as { completedChunks?: number } | null)?.completedChunks).not.toBe(9);
  });

  it('分片事件把 segments 累加，并落成可查询的字幕', async () => {
    const id = await startSession();
    await offscreenSend(ASR_EVENT_TYPE, {
      id,
      event: { kind: 'chunk', index: 0, segments: [{ startMs: 0, endMs: 1_500, text: '第一句' }] },
    });
    const mid = await uiSend('ASR_STATE');
    expect((mid.data as { completedChunks?: number } | null)?.completedChunks).toBe(1);

    await offscreenSend(ASR_EVENT_TYPE, { id, event: { kind: 'done', warnings: [] } });
    const done = await uiSend('ASR_STATE');
    expect(done.data).toMatchObject({ status: 'completed' });
    expect((done.data as { transcriptId?: string }).transcriptId).toBeTruthy();
  });

  it('同一分片重复上报不会重复累加', async () => {
    const id = await startSession();
    const chunk = { kind: 'chunk', index: 0, segments: [{ startMs: 0, endMs: 1_000, text: '重复' }] };
    await offscreenSend(ASR_EVENT_TYPE, { id, event: chunk });
    await offscreenSend(ASR_EVENT_TYPE, { id, event: chunk });
    const state = await uiSend('ASR_STATE');
    expect((state.data as { completedChunks?: number } | null)?.completedChunks).toBe(1);
  });
});

describe('退出后进度不丢', () => {
  it('会话状态与已完成分片写入 storage.session', async () => {
    const id = await startSession();
    await offscreenSend(ASR_EVENT_TYPE, {
      id, event: { kind: 'chunk', index: 0, segments: [{ startMs: 0, endMs: 1_000, text: '已完成的字' }] },
    });
    const persisted = session.get('asr.session.v1') as { state?: { id?: string }; segments?: unknown[] } | undefined;
    expect(persisted?.state?.id).toBe(id);
    expect(persisted?.segments).toHaveLength(1);
  });

  it('后台重启后能从中断会话恢复，并把已完成的字幕落成一个版本', async () => {
    const id = await startSession();
    await offscreenSend(ASR_EVENT_TYPE, {
      id, event: { kind: 'chunk', index: 0, segments: [{ startMs: 0, endMs: 1_000, text: '中断前的字' }] },
    });
    // 模拟 SW 被回收后重新启动：丢掉模块级内存态，只剩 storage.session。
    resetAsrForTests();
    const state = await uiSend('ASR_STATE');
    expect(state.data).toMatchObject({ status: 'completed' });
    expect((state.data as { transcriptId?: string }).transcriptId).toBeTruthy();
  });

  it('中断且没有任何完成分片时明确失败，不伪装成功', async () => {
    const id = await startSession();
    expect(id).toBeTruthy();
    resetAsrForTests();
    const state = await uiSend('ASR_STATE');
    expect(state.data).toMatchObject({ status: 'failed' });
    expect((state.data as { error?: { code?: string } }).error?.code).toBe('CAPTURE_UNAVAILABLE');
  });
});

describe('没有字幕时按采集证据归因', () => {
  /** 造一个「一片字幕都没有」的结束事件，并带上指定采集证据。 */
  async function finishWith(evidence: Record<string, unknown>) {
    const id = await startSession();
    await offscreenSend(ASR_EVENT_TYPE, { id, event: { kind: 'done', warnings: [], evidence } });
    const state = await uiSend('ASR_STATE');
    return state.data as { status?: string; error?: { code?: string; detail?: string } } | null;
  }

  it('采集到的全是数字静音 → CAPTURE_SILENT，而不是「未识别到语音」', async () => {
    const view = await finishWith({
      chunks: 2, silentChunks: 2, deviceChanged: false, trackEnded: false, peak: 0, contextRunning: true,
    });
    expect(view).toMatchObject({ status: 'failed' });
    expect(view?.error?.code).toBe('CAPTURE_SILENT');
  });

  it('插耳机导致采集被中断 → CAPTURE_INTERRUPTED', async () => {
    const view = await finishWith({
      chunks: 2, silentChunks: 0, deviceChanged: true, trackEnded: true, peak: 0.4, contextRunning: true,
    });
    expect(view?.error?.code).toBe('CAPTURE_INTERRUPTED');
  });

  it('有声音但没识别出字 → NO_SPEECH，且不再让用户去查静音', async () => {
    const view = await finishWith({
      chunks: 2, silentChunks: 0, deviceChanged: false, trackEnded: false, peak: 0.4, contextRunning: true,
    });
    expect(view?.error?.code).toBe('NO_SPEECH');
    expect(view?.error?.detail ?? '').not.toContain('静音');
  });
});
