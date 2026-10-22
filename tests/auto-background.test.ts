import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyDatabase, setDbForTests } from '../src/storage/db';
import { AUTO_SUMMARY_PORT } from '../src/lib/auto-summary';
import type { RuntimeResponse } from '../src/lib/messages';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(async () => {}), selectTranscript: vi.fn(async () => null), setEnabled: vi.fn(async () => {}),
  pausePlayback: vi.fn(async () => {}), resume: vi.fn(async () => {}), settingsChanged: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ transcriptId: null })), subscribe: vi.fn(() => vi.fn()),
}));
vi.mock('../src/jobs/auto-summary-service', () => ({ autoSummaryService: mocks }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: () => void) => ({ main }) }));
import background from '../src/entrypoints/background';

type MessageHandler = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: RuntimeResponse) => void) => unknown;
let db: StudyDatabase;
let onMessage: MessageHandler;
let onConnect: (port: chrome.runtime.Port) => void;
let onAlarm: (alarm: chrome.alarms.Alarm) => void;
let onRemoved: (id: number) => void;
let tabId = 10;
const trusted = { id: 'extension-id', url: 'chrome-extension://extension-id/panel.html' };
function contentSender(): chrome.runtime.MessageSender {
  return { id: 'extension-id', url: 'https://www.bilibili.com/video/BV1GJ411x7h7/', tab: { id: tabId } as chrome.tabs.Tab, frameId: 0 };
}
function send(type: string, payload: Record<string, unknown>, sender: chrome.runtime.MessageSender = trusted, version?: number) {
  return new Promise<RuntimeResponse>((resolve) => onMessage({ type, payload, ...(version === undefined ? {} : { version }) }, sender, resolve));
}
async function context() {
  await send('VIDEO_CONTEXT_CHANGED', { documentEpoch: 'current-epoch', snapshot: { bvid: 'BV1GJ411x7h7', aid: '1001', cid: '111', durationMs: 65_000, pageIndex: 1 } }, contentSender());
}
beforeEach(async () => {
  tabId += 1; vi.clearAllMocks();
  db = new StudyDatabase(`test-background-auto-${crypto.randomUUID()}`); setDbForTests(db); await db.open();
  const event = () => ({ addListener: vi.fn() });
  const session: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    runtime: { id: 'extension-id', getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onStartup: event(), onInstalled: event(),
      onMessage: { addListener: (listener: MessageHandler) => { onMessage = listener; } },
      onConnect: { addListener: (listener: typeof onConnect) => { onConnect = listener; } } },
    storage: { local: { get: async () => ({}), setAccessLevel: async () => {} },
      session: { get: async () => session, set: async (next: Record<string, unknown>) => Object.assign(session, next), remove: async () => {}, setAccessLevel: async () => {} }, onChanged: event() },
    permissions: { onAdded: event(), onRemoved: event() },
    alarms: { get: async () => ({ name: 'summary-heartbeat' }), create: async () => {}, onAlarm: { addListener: (listener: typeof onAlarm) => { onAlarm = listener; } } },
    tabs: { onRemoved: { addListener: (listener: typeof onRemoved) => { onRemoved = listener; } } },
  });
  (background as unknown as { main: () => void }).main();
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
});
afterEach(async () => { await db.delete(); setDbForTests(null); vi.unstubAllGlobals(); });

describe('实际后台消息接线', () => {
  it('未带version的上下文仍识别，当前播放消息驱动自动节点', async () => {
    await context();
    const response = await send('PLAYBACK_POSITION', { documentEpoch: 'current-epoch', videoKey: 'BV1GJ411x7h7:111', positionMs: 30_000, durationMs: 65_000, paused: false }, contentSender());
    expect(response.ok).toBe(true);
    expect(mocks.observe).toHaveBeenCalledWith({ videoId: 'bilibili:BV1GJ411x7h7:111', positionMs: 30_000, durationMs: 65_000, paused: false, ended: false });
  });
  it('旧文档或旧分P播放消息不触发模型链路', async () => {
    await context();
    await send('PLAYBACK_POSITION', { documentEpoch: 'old', videoKey: 'BV1GJ411x7h7:111', positionMs: 30_000 }, contentSender());
    await send('PLAYBACK_POSITION', { documentEpoch: 'current-epoch', videoKey: 'BV1GJ411x7h7:other', positionMs: 30_000 }, contentSender());
    expect(mocks.observe).not.toHaveBeenCalled();
  });
  it('切换分P与关闭视频标签停止旧视频新节点调度', async () => {
    await context();
    await send('VIDEO_CONTEXT_CHANGED', { documentEpoch: 'current-epoch', snapshot: { bvid: 'BV1GJ411x7h7', aid: '1001', cid: '222' } }, contentSender());
    expect(mocks.pausePlayback).toHaveBeenCalledWith('bilibili:BV1GJ411x7h7:111');
    onRemoved(tabId);
    expect(mocks.pausePlayback).toHaveBeenCalledWith('bilibili:BV1GJ411x7h7:222');
  });
  it('手动整片生成已禁用', async () => {
    expect(await send('START_SUMMARY', { videoId: 'fixture' })).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });
  it('网页、内容脚本、其他扩展不能订阅或控制自动学习', async () => {
    const webpage = contentSender();
    expect(await send('AUTO_SUMMARY_CONTROL', { videoId: 'fixture', enabled: true }, webpage)).toMatchObject({ ok: false });
    expect(await send('AUTO_SUMMARY_STATE', { videoId: 'fixture' }, { ...trusted, id: 'other-extension' })).toMatchObject({ ok: false });
    const port = { name: AUTO_SUMMARY_PORT, sender: webpage } as chrome.runtime.Port;
    onConnect(port); expect(mocks.subscribe).not.toHaveBeenCalled(); expect(mocks.setEnabled).not.toHaveBeenCalled();
  });
  it('弹窗端口关闭只退订，不取消SSE', () => {
    let subscribe!: (value: unknown) => void; let disconnect!: () => void;
    const unsubscribe = vi.fn(); mocks.subscribe.mockReturnValueOnce(unsubscribe);
    const postMessage = vi.fn();
    onConnect({ name: AUTO_SUMMARY_PORT, sender: trusted, postMessage,
      onMessage: { addListener: (fn: typeof subscribe) => { subscribe = fn; } },
      onDisconnect: { addListener: (fn: typeof disconnect) => { disconnect = fn; } },
    } as unknown as chrome.runtime.Port);
    subscribe({ type: 'subscribe', videoId: 'fixture' }); disconnect();
    expect(mocks.subscribe).toHaveBeenCalledWith('fixture', expect.any(Function));
    expect(unsubscribe).toHaveBeenCalledOnce(); expect(mocks.setEnabled).not.toHaveBeenCalled();
  });
  it('显式暂停/重试会转发到后台控制', async () => {
    expect((await send('AUTO_SUMMARY_CONTROL', { videoId: 'fixture', enabled: false })).ok).toBe(true);
    expect(mocks.setEnabled).toHaveBeenCalledWith('fixture', false, false);
    await send('AUTO_SUMMARY_CONTROL', { videoId: 'fixture', enabled: true, retryFailed: true });
    expect(mocks.setEnabled).toHaveBeenCalledWith('fixture', true, true);
  });
  it('心跳只唤醒自动流式执行器，未知alarm不触发', async () => {
    mocks.resume.mockClear(); onAlarm({ name: 'other' } as chrome.alarms.Alarm);
    expect(mocks.resume).not.toHaveBeenCalled(); onAlarm({ name: 'summary-heartbeat' } as chrome.alarms.Alarm);
    await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalledOnce());
  });
});
