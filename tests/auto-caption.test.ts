import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudyDatabase, listTranscripts, saveTranscript, setDbForTests } from '../src/storage/db';
import { resetSilentCaptionAttempts, silentFetchCaptions } from '../src/jobs/auto-caption';

const videoId = 'bilibili:BV1GJ411x7h7:111';
let db: StudyDatabase;

/** 用最小的 chrome.tabs 桩模拟页面脚本回报。 */
function stubTabs(handlers: { tracks?: unknown; read?: Record<string, unknown> }) {
  const sendMessage = vi.fn(async (_tabId: number, message: { type: string; payload?: { url?: string } }) => {
    if (message.type === 'LIST_PAGE_TRACKS') return handlers.tracks ?? { ok: true, tracks: [] };
    if (message.type === 'READ_PAGE_TRACK') {
      const url = message.payload?.url ?? '';
      return handlers.read?.[url] ?? { ok: false, reason: 'not-stubbed' };
    }
    return null;
  });
  vi.stubGlobal('chrome', { tabs: { sendMessage } });
  return sendMessage;
}

const vtt = [
  'WEBVTT', '',
  '1', '00:00:00.000 --> 00:00:02.000', '第一句', '',
  '2', '00:00:02.000 --> 00:00:04.000', '第二句', '',
].join('\n');

beforeEach(async () => {
  db = new StudyDatabase(`test-caption-${crypto.randomUUID()}`);
  setDbForTests(db);
  await db.open();
  resetSilentCaptionAttempts();
});
afterEach(async () => {
  await db.delete();
  setDbForTests(null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const base = { tabId: 1, videoId, platform: 'web' as const, aid: '', cid: '' };

describe('静默自动取字幕（弹窗不用打开）', () => {
  it('页内字幕可读时直接落库，并回报条数', async () => {
    stubTabs({
      tracks: { ok: true, tracks: [{ url: 'https://site.test/a.vtt', label: '中文', language: 'zh', kind: 'subtitles' }] },
      read: { 'https://site.test/a.vtt': { ok: true, text: vtt } },
    });
    const outcome = await silentFetchCaptions(base);
    expect(outcome.used).toBe(true);
    expect(outcome.cues).toBe(2);
    const stored = await listTranscripts(videoId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.cueCount).toBe(2);
  });

  it('已有字幕版本时不再重复取，直接沿用以避免重复请求', async () => {
    await saveTranscript({
      videoId, language: 'zh', sourceKind: 'srt', generationKind: 'human',
      trackLabel: '已有.srt', sourceHash: 'h1',
      cues: [{ cueId: 'c0', sequence: 0, startMs: 0, endMs: 1000, text: '已有', sourceIndex: 0 }],
    });
    const sendMessage = stubTabs({});
    const outcome = await silentFetchCaptions(base);
    expect(outcome.used).toBe(true);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('确实没有字幕时回报 no-track，且不落库、不伪造', async () => {
    stubTabs({ tracks: { ok: true, tracks: [] } });
    const outcome = await silentFetchCaptions({ ...base, videoId: 'web:https://a.test:/x' });
    expect(outcome).toEqual({ used: false, reason: 'no-track' });
    expect(await listTranscripts('web:https://a.test:/x')).toHaveLength(0);
  });

  it('有轨道但正文读不出来时与「没有字幕」区分开', async () => {
    stubTabs({
      tracks: { ok: true, tracks: [{ url: 'https://site.test/b.vtt', label: '中文', language: 'zh', kind: 'subtitles' }] },
      read: { 'https://site.test/b.vtt': { ok: false, reason: 'cross-origin' } },
    });
    const outcome = await silentFetchCaptions({ ...base, videoId: 'web:https://b.test:/y' });
    expect(outcome.used).toBe(false);
    expect(outcome.reason).toBe('no-track');
  });

  it('同一视频只自动尝试一次，避免位置上报反复触发', async () => {
    const sendMessage = stubTabs({ tracks: { ok: true, tracks: [] } });
    await silentFetchCaptions({ ...base, videoId: 'web:https://c.test:/z' });
    await silentFetchCaptions({ ...base, videoId: 'web:https://c.test:/z' });
    expect(sendMessage).toHaveBeenCalledTimes(1);
  });

  it('页面脚本不可用时安静失败，不抛给调用方', async () => {
    vi.stubGlobal('chrome', {
      tabs: { sendMessage: vi.fn(async () => { throw new Error('no receiver'); }) },
    });
    const outcome = await silentFetchCaptions({ ...base, videoId: 'web:https://d.test:/w' });
    expect(outcome.used).toBe(false);
  });
});
