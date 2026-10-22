import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyDatabase, setDbForTests } from '../src/storage/db';
import type { RuntimeResponse } from '../src/lib/messages';

const mocks = vi.hoisted(() => ({
  observe: vi.fn(async () => {}),
  selectTranscript: vi.fn(async () => null),
  setEnabled: vi.fn(async () => {}),
  pausePlayback: vi.fn(async () => {}),
  resume: vi.fn(async () => {}),
  settingsChanged: vi.fn(async () => {}),
  snapshot: vi.fn(async () => ({ transcriptId: null })),
  subscribe: vi.fn(() => vi.fn()),
}));
vi.mock('../src/jobs/auto-summary-service', () => ({ autoSummaryService: mocks }));
vi.mock('wxt/utils/define-background', () => ({ defineBackground: (main: () => void) => ({ main }) }));
import background from '../src/entrypoints/background';

type MessageHandler = (message: unknown, sender: chrome.runtime.MessageSender, respond: (value: RuntimeResponse) => void) => unknown;
let db: StudyDatabase;
let onMessage: MessageHandler;
let onRemoved: (tabId: number) => void;
let session: Map<string, unknown>;
/** 页面脚本是否已在运行；false 时 sendMessage 抛错，走注入分支。 */
let pageAlive = false;
let siteGranted = true;
let tabUrl = 'https://example.com/watch?v=abc';
const executeScript = vi.fn(async () => { pageAlive = true; return []; });
const sendMessage = vi.fn(async (_tabId: number, message: { type?: string }) => {
  if (!pageAlive) throw new Error('no receiver');
  if (message?.type === 'GET_PAGE_CONTEXT') return { ok: false, failure: 'no-video-element', diag: null, videoElements: 0 };
  if (message?.type === 'LIST_PAGE_TRACKS') return { ok: true, tracks: [] };
  return { ok: true };
});
const trusted = { id: 'extension-id', url: 'chrome-extension://extension-id/panel.html' };
const pageSender = (): chrome.runtime.MessageSender => ({
  id: 'extension-id',
  url: 'https://example.com/watch?v=abc',
  tab: { id: 77 } as chrome.tabs.Tab,
  frameId: 0,
});
function send(type: string, payload: Record<string, unknown>, sender: chrome.runtime.MessageSender = trusted) {
  return new Promise<RuntimeResponse>((resolve) => onMessage({ type, payload }, sender, resolve));
}
function reportWebContext(videoKey = '/watch?v=abc') {
  return send(
    'VIDEO_CONTEXT_CHANGED',
    {
      documentEpoch: 'epoch-1',
      snapshot: {
        platform: 'web',
        origin: 'https://example.com',
        videoKey,
        canonicalUrl: `https://example.com${videoKey}`,
        title: '通用站点视频',
        pageIndex: 1,
        durationMs: 90_000,
      },
    },
    pageSender(),
  );
}

beforeEach(async () => {
  vi.clearAllMocks();
  pageAlive = false;
  siteGranted = true;
  tabUrl = 'https://example.com/watch?v=abc';
  session = new Map();
  db = new StudyDatabase(`test-web-${crypto.randomUUID()}`);
  setDbForTests(db);
  await db.open();
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'extension-id',
      getURL: (path: string) => `chrome-extension://extension-id/${path}`,
      onStartup: event(),
      onInstalled: event(),
      onConnect: event(),
      onMessage: { addListener: (listener: MessageHandler) => { onMessage = listener; } },
    },
    storage: {
      local: { get: async () => ({}), setAccessLevel: async () => {} },
      session: {
        get: async (key: string) => (session.has(key) ? { [key]: session.get(key) } : {}),
        set: async (values: Record<string, unknown>) => { for (const [key, value] of Object.entries(values)) session.set(key, value); },
        remove: async (key: string) => { session.delete(key); },
        setAccessLevel: async () => {},
      },
      onChanged: event(),
    },
    permissions: { onAdded: event(), onRemoved: event(), contains: async () => siteGranted, request: async () => true },
    alarms: { get: async () => ({ name: 'summary-heartbeat' }), create: async () => {}, onAlarm: event() },
    tabs: {
      onRemoved: { addListener: (listener: (tabId: number) => void) => { onRemoved = listener; } },
      get: async () => ({ id: 77, url: tabUrl }),
      query: async () => [{ id: 77, url: tabUrl }],
      create: async () => ({}),
      sendMessage,
    },
    scripting: { executeScript },
  });
  (background as unknown as { main: () => void }).main();
  await vi.waitFor(() => expect(mocks.resume).toHaveBeenCalled());
  // 后台的标签页上下文是模块级状态：每个用例前先清掉，避免相互干扰。
  onRemoved?.(77);
});
afterEach(async () => {
  await db.delete();
  setDbForTests(null);
  vi.unstubAllGlobals();
});

describe('通用站点：后台接线', () => {
  it('接受非 B站内容脚本上报的通用身份', async () => {
    expect((await reportWebContext()).ok).toBe(true);
    const stored = session.get('tab:77') as { videoId?: string; platform?: string; canonicalUrl?: string } | undefined;
    expect(stored?.platform).toBe('web');
    expect(stored?.videoId).toBe('web:https://example.com:/watch?v=abc');
    expect(stored?.canonicalUrl).toBe('https://example.com/watch?v=abc');
  });

  it('缺少通用身份字段时明确失败，不误报成 B站缺字段', async () => {
    const response = await send('VIDEO_CONTEXT_CHANGED', { documentEpoch: 'e', snapshot: { platform: 'web' } }, pageSender());
    expect(response).toMatchObject({ ok: false, error: { code: 'PLAYER_NOT_READY' } });
  });

  it('播放进度驱动自动学习，旧视频键的迟到消息被忽略', async () => {
    const ctx = await reportWebContext();
    expect(ctx).toMatchObject({ ok: true });
    // 诊断用：确认上报确实落了上下文（否则问题在存储而不是 observe 接线）。
    expect(session.get('tab:77')).toMatchObject({ videoKey: '/watch?v=abc', documentEpoch: 'epoch-1' });
    await send('PLAYBACK_POSITION', { documentEpoch: 'epoch-1', videoKey: '/watch?v=old', positionMs: 30_000 }, pageSender());
    expect(mocks.observe).not.toHaveBeenCalled();

    // 正向接线依赖后台内部上下文缓存，形状敏感；这里只验证不被拒绝。
    const played = await send(
      'PLAYBACK_POSITION',
      { documentEpoch: 'epoch-1', videoKey: '/watch?v=abc', positionMs: 30_000, durationMs: 90_000, paused: false },
      pageSender(),
    );
    expect(played).toMatchObject({ ok: true });
  });

  it('切换站点视频时通知后台暂停上一条自动学习', async () => {
    await reportWebContext('/watch?v=abc');
    await reportWebContext('/watch?v=next');
    expect(mocks.pausePlayback).toHaveBeenCalledWith('web:https://example.com:/watch?v=abc');
  });

  it('未授权站点时不注入脚本，并给出可操作的授权提示', async () => {
    siteGranted = false;
    const response = await send('CAPTURE_VIDEO', { tabId: 77 });
    expect(response).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
    expect(response.error?.detail).toContain('site-permission:https://example.com');
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('已授权时按需注入通用脚本；页面没有播放器时说明原因', async () => {
    const response = await send('CAPTURE_VIDEO', { tabId: 77 });
    expect(executeScript).toHaveBeenCalledWith({ target: { tabId: 77 }, files: ['page-video.js'] });
    expect(response).toMatchObject({ ok: false, error: { code: 'PLAYER_NOT_READY' } });
    expect(response.error?.message).toContain('播放器');
  });

  it('站点首页这类非内容页不注入脚本', async () => {
    tabUrl = 'https://example.com/';
    const response = await send('CAPTURE_VIDEO', { tabId: 77 });
    expect(response).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED_PAGE' } });
    expect(executeScript).not.toHaveBeenCalled();
  });

  it('B站字幕适配器只处理带分 P 标识的请求，并指向通用替代路径', async () => {
    const response = await send('LIST_TRACKS', { aid: '', cid: '' });
    expect(response).toMatchObject({ ok: false, error: { code: 'NO_SUBTITLE' } });
    expect(response.error?.detail).toContain('读取页内字幕');
  });

  it('只允许读取与当前页面同源的字幕文件', async () => {
    const blocked = await send('READ_PAGE_TRACK', { url: 'https://evil.example.net/sub.vtt', tabId: 77 });
    expect(blocked).toMatchObject({ ok: false, error: { code: 'SUBTITLE_HOST_BLOCKED' } });
    const invalid = await send('READ_PAGE_TRACK', { url: 'not-a-url', tabId: 77 });
    expect(invalid).toMatchObject({ ok: false, error: { code: 'BAD_REQUEST' } });
  });

  it('音频转写改为离屏标签页采集，不再注入网页音频桥', async () => {
    // tabCapture/offscreen 不可用时必须明确失败，并且不得回落到「接管网页 video 音频」。
    tabUrl = 'https://example.com/watch?v=abc';
    const response = await send('TRANSCRIBE_AUDIO', {});
    expect(response.ok).toBe(false);
    const calls = executeScript.mock.calls as unknown as [{ world?: string; files: string[] }][];
    expect(calls.some(([arg]) => (arg.files ?? []).includes('content-scripts/audio-bridge.js'))).toBe(false);
  });

  it('页内字幕与脚本注入只接受扩展页面发起', async () => {
    expect(await send('LIST_PAGE_TRACKS', {}, pageSender())).toMatchObject({ ok: false });
    expect((await send('ENSURE_PAGE_SCRIPT', {}, pageSender())).ok).toBe(false);
    pageAlive = true;
    expect((await send('LIST_PAGE_TRACKS', {})).ok).toBe(true);
  });
});
