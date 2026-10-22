import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { streamChat, type StreamChatOptions } from '../src/ai/stream';
import { appError } from '../src/domain/errors';
import type { Cue } from '../src/domain/transcript';
import { createAutoSummaryService, autoSummaryId, cuesForNode, MAX_AUTO_STREAMS, readyAutoProvider } from '../src/jobs/auto-summary-service';
import { summaryNodeId } from '../src/jobs/auto-nodes';
import { createBackup, parseBackup, serializeBackup } from '../src/export/backup';
import { buildMarkdown } from '../src/export/markdown';
import { deleteVideoCascade, getCues, listLibrary, saveNote, saveTranscript, setDbForTests, StudyDatabase } from '../src/storage/db';
import { DEFAULT_SETTINGS, type ReadyProvider } from '../src/storage/settings';
import type { SummaryNodeRecord, SummaryRecord, VideoRecord } from '../src/storage/types';
import type { AutoSummaryEvent } from '../src/lib/auto-summary';

const video: VideoRecord = { id: 'bilibili:BV1GJ411x7h7:111', bvid: 'BV1GJ411x7h7', aid: '1001', cid: '111', platform: 'bilibili',
  title: '自动学习测试夹具', canonicalUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/', pageIndex: 1, durationMs: 65_000,
  tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
const cues: Cue[] = Array.from({ length: 7 }, (_, index) => ({ cueId: `c${index}`, sequence: index, sourceIndex: index,
  startMs: index * 10_000, endMs: Math.min((index + 1) * 10_000, 65_000), text: `测试字幕${index}` }));
const provider: ReadyProvider = { baseUrl: 'https://example.test/v1', apiKey: 'private-fixture-key', modelId: 'fixture-model',
  providerId: 'fixture', providerName: 'Fixture', maxTokens: 2048, targetLanguage: '简体中文' };
const encoder = new TextEncoder();
let db: StudyDatabase;
let transcriptId: string;
let service: ReturnType<typeof createAutoSummaryService>;
let services: ReturnType<typeof createAutoSummaryService>[];
let requests: StreamChatOptions[];
let streamImpl: typeof streamChat;
let providerImpl: () => Promise<ReadyProvider>;
let releaseAll: (() => void)[];
const stopKeepAlive = vi.fn();

function output(options: StreamChatOptions) {
  const input = JSON.parse(options.messages.at(-1)!.content) as { cues: { cueId: string; text: string }[] };
  return { title: '本段主题', paragraphs: input.cues.map((cue) => ({ text: cue.text, sourceCueIds: [cue.cueId] })), bullets: [] };
}
async function* normalStream(options: StreamChatOptions) {
  yield { text: JSON.stringify(output(options)), done: false };
  yield { text: '', done: true };
}
function makeService() {
  const value = createAutoSummaryService({ db: () => db, provider: () => providerImpl(),
    stream: (options) => { requests.push(options); return streamImpl(options); }, keepAlive: () => stopKeepAlive });
  services.push(value);
  return value;
}
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  releaseAll.push(release);
  return { promise, release };
}
async function addTranscript(videoId = video.id, suffix = 'a') {
  return (await saveTranscript({ videoId, language: 'zh', sourceKind: 'srt', generationKind: 'human',
    trackLabel: '测试夹具.srt', sourceHash: `${videoId}-${suffix}`, cues })).revision.id;
}
async function observe(positionMs: number, extra: Partial<Parameters<typeof service.observe>[0]> = {}) {
  await service.observe({ videoId: video.id, positionMs, durationMs: 65_000, paused: false, ...extra });
}
async function nodeFixture(index: number, changes: Partial<SummaryNodeRecord> = {}) {
  const node: SummaryNodeRecord = { id: summaryNodeId(transcriptId, index), videoId: video.id, transcriptId, index,
    startMs: index * 30_000, endMs: Math.min((index + 1) * 30_000, 65_000), status: 'streaming', attempts: 1,
    attemptId: 'previous-worker', rawText: '{"title":"旧草稿', previewText: '旧草稿', result: null, providerSnapshot: null,
    language: '简体中文', error: null, createdAt: video.createdAt, updatedAt: video.updatedAt, ...changes };
  await db.summaryNodes.put(node);
  return node;
}

beforeEach(async () => {
  db = new StudyDatabase(`test-auto-${crypto.randomUUID()}`); setDbForTests(db); await db.open();
  await db.videos.put(video); transcriptId = await addTranscript();
  requests = []; services = []; releaseAll = []; stopKeepAlive.mockClear();
  streamImpl = normalStream; providerImpl = async () => provider;
  service = makeService();
});
afterEach(async () => {
  releaseAll.forEach((release) => release());
  for (const value of services) await value.settled();
  await db.delete(); setDbForTests(null); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('字幕就绪即建立会话（不依赖先播一秒）', () => {
  it('prepare 之后快照立即存在，且启用了自动学习', async () => {
    // 旧行为：会话只在 observe() 收到播放位置时才创建，
    // 于是「有字幕但还没播」时自动学习页只有「正在连接后台…」。
    const session = await service.prepare(video.id, transcriptId);
    expect(session).toMatchObject({ videoId: video.id, transcriptId, enabled: true });
    const snap = await service.snapshot(video.id);
    expect(snap.transcriptId).toBe(transcriptId);
    expect(snap.message).not.toBe('请先获取、导入或转写字幕');
    expect(requests).toHaveLength(0); // 只建会话，不请求模型
  });

  it('建立会话不会在 0 秒抢跑节点', async () => {
    await service.prepare(video.id, transcriptId);
    await service.settled();
    expect(requests).toHaveLength(0);
    const nodes = await db.summaryNodes.where('transcriptId').equals(transcriptId).toArray();
    expect(nodes).toHaveLength(0);
    // 真正播放到 30 秒才触发。
    await observe(30_000); await service.settled();
    expect(requests).toHaveLength(1);
  });

  it('重复 prepare 幂等，不重建会话也不清空已保存节点', async () => {
    await service.prepare(video.id, transcriptId);
    await observe(30_000); await service.settled();
    const before = (await service.snapshot(video.id)).completed;
    await service.prepare(video.id, transcriptId);
    await service.prepare(video.id, transcriptId);
    const after = (await service.snapshot(video.id)).completed;
    expect(after).toBe(before);
    expect(requests).toHaveLength(1);
  });

  it('没有在扩展里保存过的视频不会凭空建会话', async () => {
    expect(await service.prepare('web:https://example.com:not-saved', transcriptId)).toBeNull();
  });
});

describe('自动节点后台执行', () => {
  it('不需要按钮或订阅者；30/60秒及尾段追加保存，旧小节不被合并重写', async () => {
    await observe(0); await service.settled(); expect(requests).toHaveLength(0);
    await observe(30_000); await service.settled();
    const first = (await service.snapshot(video.id)).summary!;
    expect(first.payload.opening.title).toContain('节点 0');
    expect(first.payload.opening.title).toContain('00:30');
    expect(first.autoStream?.completedNodes).toBe(1);
    expect(first.coverage).toBe('partial');
    await observe(60_000); await service.settled();
    const second = (await service.snapshot(video.id)).summary!;
    expect(second.id).toBe(first.id);
    expect(second.payload.opening).toEqual(first.payload.opening);
    expect(second.payload.sections[0]?.title).toContain('节点 1');
    await observe(65_000, { paused: true, ended: true }); await service.settled();
    const final = await service.snapshot(video.id);
    expect(final.completed).toBe(3); expect(final.summary?.coverage).toBe('complete'); expect(final.draft).toBeNull();
    expect(requests).toHaveLength(3); expect(stopKeepAlive).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(await db.summaryNodes.toArray())).not.toContain(provider.apiKey);
  });
  it('并发重复上报、后退、重启后台均不重发已完成节点', async () => {
    await Promise.all(Array.from({ length: 8 }, () => observe(30_000)));
    await service.settled();
    await observe(1000); await observe(31_000); await service.settled();
    const restarted = makeService(); await Promise.all([restarted.resume(), restarted.resume()]); await restarted.settled();
    await restarted.observe({ videoId: video.id, positionMs: 31_000, durationMs: 65_000, paused: false }); await restarted.settled();
    expect(requests).toHaveLength(1); expect(await db.summaryNodes.count()).toBe(1);
  });
  it('前跳只产生一个到达节点，未处理区间不伪装完整', async () => {
    await observe(60_000); await service.settled();
    expect(requests).toHaveLength(1);
    expect((await service.snapshot(video.id)).summary?.coverage).toBe('partial');
    expect((await db.summaryNodes.toArray())[0]?.index).toBe(1);
  });
  it('暂停播放不创建节点或请求', async () => {
    await observe(30_000, { paused: true }); await service.settled();
    expect(requests).toHaveLength(0); expect(await db.summaryNodes.count()).toBe(0);
    await observe(30_000); await service.settled(); expect(requests).toHaveLength(1);
  });
  it('在途请求可完成，但暂停后已排队节点不启动', async () => {
    const pending = gate();
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)), done: false }; await pending.promise; yield { text: '', done: true }; };
    await observe(30_000); await vi.waitFor(() => expect(requests).toHaveLength(1));
    await observe(60_000); await observe(60_000, { paused: true });
    pending.release(); await service.settled(); expect(requests).toHaveLength(1);
    expect((await service.snapshot(video.id)).queued).toBe(1);
    await observe(60_001); await service.settled(); expect(requests).toHaveLength(2);
  });
  it('真实 SSE 解析到草稿，弹窗断开不中止请求；重连可读草稿及最终结果', async () => {
    const end = gate(); let controller!: ReadableStreamDefaultController<Uint8Array>;
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({ start(value) { controller = value; } });
      const payload = output({ ...requests[0]!, messages: JSON.parse(init!.body as string).messages });
      const text = JSON.stringify(payload);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 50) } }] })}\r\n\r\n`));
      void end.promise.then(() => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(50) } }] })}\n\ndata: [DONE]\n\n`)); controller.close();
      });
      return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
    });
    streamImpl = (options) => streamChat({ ...options, fetchImpl });
    const events: AutoSummaryEvent[] = [];
    const disconnect = service.subscribe(video.id, (event) => events.push(event));
    await observe(30_000);
    await vi.waitFor(() => expect(events.some((event) => event.type === 'delta')).toBe(true));
    const draft = await service.snapshot(video.id);
    expect(draft.draft?.previewText).toContain('本段主题'); expect(draft.summary).toBeNull();
    disconnect(); expect(requests[0]?.signal?.aborted).toBe(false);
    const reconnectEvents: AutoSummaryEvent[] = []; const reconnect = service.subscribe(video.id, (event) => reconnectEvents.push(event));
    expect((await service.snapshot(video.id)).draft?.attemptId).toBe(draft.draft?.attemptId);
    end.release(); await service.settled(); reconnect();
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(reconnectEvents.some((event) => event.type === 'changed')).toBe(true);
    expect((await service.snapshot(video.id)).completed).toBe(1);
  });
  it('跨时间边界的完整字幕归入开始所在节点，不重复、不引用未来区间', async () => {
    const crossing = { ...cues[0]!, startMs: 29_000, endMs: 31_000 };
    expect(cuesForNode([crossing], { startMs: 0, endMs: 30_000 }, 65_000)).toEqual([crossing]);
    expect(cuesForNode([crossing], { startMs: 30_000, endMs: 60_000 }, 65_000)).toEqual([]);
    await observe(30_000); await service.settled();
    expect(JSON.parse(requests[0]!.messages.at(-1)!.content).cues.map((cue: Cue) => cue.cueId)).toEqual(['c0', 'c1', 'c2']);
  });
  it('跨边界字幕稀疏时不再误判节点为空', async () => {
    await db.cues.clear();
    await db.cues.bulkPut([
      { ...cues[0]!, cueId: 'cross', startMs: 28_000, endMs: 32_000, text: '跨边界字幕' },
    ].map((cue) => ({ ...cue, id: `tr-x:${cue.cueId}`, transcriptId })));
    await observe(30_000); await service.settled();
    const snapshot = await service.snapshot(video.id);
    expect(snapshot.empty).toBe(0);
    expect(requests).toHaveLength(1);
  });
  it('无字幕的时间段不调用模型、不编造总结', async () => {
    await db.cues.clear(); await observe(30_000); await service.settled();
    const snapshot = await service.snapshot(video.id);
    expect(snapshot.empty).toBe(1); expect(snapshot.summary).toBeNull(); expect(requests).toHaveLength(0);
  });
  it('用户暂停自动学习后，迟到结果不提交；视频继续播放也不建新节点', async () => {
    const pending = gate();
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)), done: false }; await pending.promise; yield { text: '', done: true }; };
    await observe(30_000); await vi.waitFor(() => expect(requests).toHaveLength(1));
    await service.setEnabled(video.id, false); await observe(60_000); pending.release(); await service.settled();
    expect(requests[0]?.signal?.aborted).toBe(true);
    expect((await service.snapshot(video.id)).summary).toBeNull(); expect(await db.summaryNodes.count()).toBe(1);
  });
  it('切换字幕版本取消旧请求，不把旧版本结果混入新版本', async () => {
    const pending = gate();
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)), done: false }; await pending.promise; yield { text: '', done: true }; };
    await observe(30_000); await vi.waitFor(() => expect(requests).toHaveLength(1));
    const oldId = transcriptId; const nextId = await addTranscript(video.id, 'b');
    await service.selectTranscript(video.id, nextId); pending.release(); await service.settled();
    expect(await db.summaries.get(autoSummaryId(oldId))).toBeUndefined();
    expect((await service.snapshot(video.id)).transcriptId).toBe(nextId);
    expect((await db.summaryNodes.get(summaryNodeId(oldId, 0)))?.status).toBe('queued');
    streamImpl = normalStream; await observe(30_000); await service.settled();
    expect((await service.snapshot(video.id)).summary?.transcriptId).toBe(nextId);
  });
  it('不接受属于另一个视频的字幕版本', async () => {
    await expect(service.selectTranscript(video.id, 'not-this-video')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });
  it('删除资料期间迟到的流不会复活被删除的数据', async () => {
    const pending = gate();
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)), done: false }; await pending.promise; yield { text: '', done: true }; };
    await observe(30_000); await vi.waitFor(() => expect(requests).toHaveLength(1));
    await deleteVideoCascade(video.id); pending.release(); await service.settled();
    expect(await db.videos.count()).toBe(0); expect(await db.summaryNodes.count()).toBe(0);
    expect(await db.summaries.count()).toBe(0); expect(await db.autoSummarySessions.count()).toBe(0);
  });
  it('全局有界并发，多个视频互不混用字幕', async () => {
    let inFlight = 0; let peak = 0;
    const delay = gate();
    streamImpl = async function* (options) {
      inFlight += 1; peak = Math.max(peak, inFlight);
      yield { text: JSON.stringify(output(options)), done: false }; await delay.promise;
      inFlight -= 1; yield { text: '', done: true };
    };
    for (let index = 1; index <= 4; index += 1) {
      const id = `video-${index}`; await db.videos.put({ ...video, id }); await addTranscript(id);
      await observe(30_000, { videoId: id });
    }
    await vi.waitFor(() => expect(requests.length).toBe(MAX_AUTO_STREAMS));
    delay.release(); await service.settled();
    expect(requests).toHaveLength(4); expect(peak).toBe(MAX_AUTO_STREAMS);
  });
});

describe('恢复、失败与数据兼容', () => {
  it('SW 中断仅重试未完成节点一次，多次心跳不会重复完成段', async () => {
    await observe(30_000); await service.settled();
    await nodeFixture(1); await db.autoSummarySessions.update(video.id, { lastNode: 1 });
    const restarted = makeService(); await Promise.all([restarted.resume(), restarted.resume()]); await restarted.settled();
    await restarted.resume(); await restarted.settled();
    expect(requests).toHaveLength(2);
    expect((await db.summaryNodes.get(summaryNodeId(transcriptId, 1)))?.attempts).toBe(2);
    expect((await restarted.snapshot(video.id)).summary?.payload.sections).toHaveLength(1);
  });
  it('中断恢复超过上限停止，不能无限重试', async () => {
    await observe(0); await nodeFixture(0, { attempts: 2 });
    await service.resume(); await service.settled(); await service.resume(); await service.settled();
    expect(requests).toHaveLength(0);
    expect((await db.summaryNodes.get(summaryNodeId(transcriptId, 0)))?.status).toBe('failed');
  });
  it.each(['BAD_RESPONSE', 'VALIDATION_FAILED'] as const)('%s 不进入正式结果，也不会被心跳无限重发', async (code) => {
    // 用「非引用类」的失败：BAD_RESPONSE 是 JSON 不完整；VALIDATION_FAILED 用缺 title。
    // 引用类失败会有一次原地重写（见下一个用例），这里专门钉住「结构类失败不重发」。
    streamImpl = async function* () {
      yield { text: code === 'BAD_RESPONSE' ? '{"title":"半句' : '{"paragraphs":[{"text":"x","sourceCueIds":["c0"]}],"bullets":[]}', done: false };
      if (code !== 'BAD_RESPONSE') yield { text: '', done: true };
    };
    await observe(30_000); await service.settled(); await service.resume(); await service.settled();
    expect((await service.snapshot(video.id)).summary).toBeNull();
    expect((await db.summaryNodes.toArray())[0]?.error?.code).toBe(code); expect(requests).toHaveLength(1);
  });
  it('引用缺失时用真实 cueId 重写一次，仍不补造出处', async () => {
    let round = 0;
    streamImpl = async function* (options) {
      round += 1;
      const input = JSON.parse(options.messages.at(-1)!.content) as { cues: { cueId: string; text: string }[] };
      if (round === 1) {
        // 第一次：漏写 sourceCueIds。
        yield { text: JSON.stringify({ title: '主题', paragraphs: [{ text: '正文' }], bullets: [] }), done: false };
        yield { text: '', done: true };
        return;
      }
      // 第二次：带上真实引用。
      yield { text: JSON.stringify({ title: '主题', paragraphs: input.cues.map((cue) => ({ text: cue.text, sourceCueIds: [cue.cueId] })), bullets: [] }), done: false };
      yield { text: '', done: true };
    };
    await observe(30_000); await service.settled();
    expect(requests).toHaveLength(2);
    expect((await service.snapshot(video.id)).completed).toBe(1);
    expect((await db.summaryNodes.toArray())[0]?.status).toBe('done');
  });
  it('后台自动重试失败段：可恢复错误重排，阻塞错误跳过', async () => {
    streamImpl = async function* () { throw appError('NETWORK_ERROR', '测试网络失败'); };
    await observe(30_000); await service.settled();
    const node = (await db.summaryNodes.toArray())[0]!;
    expect(node.status).toBe('failed');
    // 模拟后台重排：只把可恢复失败的节点放回队列。
    await db.summaryNodes.update(node.id, { status: 'failed', attempts: 1, error: appError('NETWORK_ERROR', 'x') });
    streamImpl = normalStream;
    const retried = await service.retryFailedNodes();
    expect(retried).toBe(1);
    await service.settled();
    expect((await db.summaryNodes.toArray())[0]?.status).toBe('done');
  });
  it('后台自动重试跳过鉴权/配额等必须用户处理的失败', async () => {
    streamImpl = async function* () { throw appError('AUTH_FAILED', '测试鉴权失败'); };
    await observe(30_000); await service.settled();
    // 会话已被熔断，重试不应把节点放回队列。
    expect(await service.retryFailedNodes()).toBe(0);
    expect((await db.summaryNodes.toArray())[0]?.status).toBe('failed');
  });
  it('后台自动重试不会无限重试超出上限的节点', async () => {
    await observe(0);
    await nodeFixture(0, { status: 'failed', attempts: 4, error: appError('NETWORK_ERROR', 'x') });
    expect(await service.retryFailedNodes()).toBe(0);
  });
  it('鉴权失败会阻止后续节点继续烧额度', async () => {
    streamImpl = async function* () { throw appError('AUTH_FAILED', '测试鉴权失败'); };
    await observe(30_000); await service.settled(); await observe(60_000); await service.settled();
    expect(requests).toHaveLength(1); expect((await service.snapshot(video.id)).error?.code).toBe('AUTH_FAILED');
  });
  it('连续三个节点失败后熔断，显式重试只重发失败节点', async () => {
    streamImpl = async function* () { throw appError('NETWORK_ERROR', '测试网络失败'); };
    for (const ms of [30_000, 60_000, 65_000]) { await observe(ms, { ended: ms === 65_000 }); await service.settled(); }
    expect(requests).toHaveLength(3); expect((await service.snapshot(video.id)).error?.code).toBe('NETWORK_ERROR');
    streamImpl = normalStream; await service.setEnabled(video.id, true, true); await service.settled();
    expect(requests).toHaveLength(6); expect((await service.snapshot(video.id)).completed).toBe(3);
    await service.setEnabled(video.id, true, true); await service.settled(); expect(requests).toHaveLength(6);
  });
  it('缺少配置不产生HTTP请求；保存配置后可接着处理原排队节点', async () => {
    providerImpl = async () => { throw appError('PROVIDER_NOT_CONFIGURED', '缺少Key'); };
    await observe(30_000); await service.settled(); expect(requests).toHaveLength(0);
    expect((await service.snapshot(video.id)).error?.code).toBe('PROVIDER_NOT_CONFIGURED');
    providerImpl = async () => provider; await service.settingsChanged(); await service.settled();
    expect(requests).toHaveLength(1); expect((await service.snapshot(video.id)).completed).toBe(1);
  });
  it('撤销授权会取消在途请求并拒绝迟到的正文', async () => {
    const pending = gate();
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)), done: false }; await pending.promise; yield { text: '', done: true }; };
    await observe(30_000); await vi.waitFor(() => expect(requests).toHaveLength(1));
    providerImpl = async () => { throw appError('CONSENT_REQUIRED', '测试撤销授权'); };
    await service.settingsChanged(); pending.release(); await service.settled();
    expect(requests[0]?.signal?.aborted).toBe(true); expect((await service.snapshot(video.id)).summary).toBeNull();
  });
  it('过密输入显式失败，不截断字幕后冒充成功', async () => {
    const row = (await getCues(transcriptId))[0]!;
    await db.cues.where('transcriptId').equals(transcriptId).modify((cue) => { if (cue.cueId === row.cueId) cue.text = '字'.repeat(16_001); });
    await observe(30_000); await service.settled();
    expect(requests).toHaveLength(0); expect((await service.snapshot(video.id)).draft?.error?.code).toBe('TOO_LARGE');
  });
  it('保留旧总结与手写笔记，资料库与Markdown/JSON备份兼容', async () => {
    const section = { title: '原来的总结', paragraphs: [{ text: '旧内容', sourceCueIds: ['c0'] }], bullets: [] };
    const legacy: SummaryRecord = { id: 'legacy-summary', videoId: video.id, transcriptId, transcriptRevisionId: transcriptId,
      language: 'zh', cacheKey: 'old', payload: { opening: section, sections: [section] }, coveredCueIds: ['c0'], coverage: 'complete',
      providerSnapshot: { providerId: 'old', providerName: 'old', requestUrl: provider.baseUrl, modelId: 'old' }, promptVersion: 'p2', createdAt: video.createdAt };
    await db.summaries.put(legacy); await saveNote(video.id, '我的手写笔记', 0);
    await observe(30_000); await service.settled();
    expect(await db.summaries.get(legacy.id)).toEqual(legacy); expect((await db.notes.get(video.id))?.markdown).toBe('我的手写笔记');
    expect((await listLibrary())[0]?.hasSummary).toBe(true);
    const summary = (await service.snapshot(video.id)).summary!;
    const markdown = buildMarkdown({ video, cues, translations: new Map(), summary, noteMarkdown: '我的手写笔记',
      includeSummary: true, includeTranscript: false, generatedAt: video.createdAt });
    expect(markdown).toContain('节点 0'); expect(markdown).toContain('测试字幕0'); expect(markdown).toContain('我的手写笔记');
    expect(markdown).toContain('https://www.bilibili.com/video/');
    const backup = serializeBackup(await createBackup());
    expect(backup).not.toContain(provider.apiKey); expect(backup).not.toContain('rawText');
    expect(parseBackup(backup).summaries.some((row) => row.id === summary.id)).toBe(true);
  });
  it('v1数据库升级只增表，旧笔记原样保留', async () => {
    const name = `test-v1-upgrade-${crypto.randomUUID()}`;
    const old = new Dexie(name);
    old.version(1).stores({ videos: 'id, bvid, cid, updatedAt, *tags', transcripts: 'id, videoId, sourceHash, createdAt',
      cues: 'id, transcriptId, [transcriptId+cueId], startMs, sequence', translations: 'id, videoId, transcriptId, cacheKey, createdAt',
      summaries: 'id, videoId, transcriptId, cacheKey, createdAt', notes: 'id, videoId, updatedAt', jobs: 'id, videoId, transcriptId, state, updatedAt',
      chunkResults: 'id, jobId, [jobId+chunkKey], createdAt' });
    await old.table('notes').put({ id: video.id, videoId: video.id, markdown: '升级前笔记', revision: 3, updatedAt: video.updatedAt }); old.close();
    const upgraded = new StudyDatabase(name);
    try {
      await upgraded.open(); expect((await upgraded.notes.get(video.id))?.markdown).toBe('升级前笔记');
      expect(upgraded.verno).toBe(2); expect(await upgraded.summaryNodes.count()).toBe(0);
    } finally { await upgraded.delete(); }
  });
});

describe('自动请求授权门槛', () => {
  it.each(['consent', 'key', 'permission'] as const)('缺少 %s 时不提供可执行凭据', async (missing) => {
    vi.stubGlobal('chrome', { storage: {
      local: { get: async () => ({ 'settings.v1': { ...DEFAULT_SETTINGS, consentAcknowledged: missing !== 'consent', provider: { ...DEFAULT_SETTINGS.provider, baseUrl: provider.baseUrl } } }) },
      session: { get: async () => ({ 'apiKey.session.v1': missing === 'key' ? '' : provider.apiKey }) },
    }, permissions: { contains: async () => missing !== 'permission' } });
    await expect(readyAutoProvider()).rejects.toMatchObject({ code: missing === 'consent' ? 'CONSENT_REQUIRED' : missing === 'key' ? 'PROVIDER_NOT_CONFIGURED' : 'PERMISSION_DENIED' });
  });
});

describe('模型正文格式兼容与诊断', () => {
  it('说明包装中的完整 JSON 可以入库，格式兼容不增加模型请求', async () => {
    streamImpl = async function* (options) {
      const raw = `[说明]\n\`\`\`json\n${JSON.stringify(output(options))}\n\`\`\`\n附注：{仅供核对}`;
      yield { text: raw.slice(0, 40), done: false };
      yield { text: raw.slice(40), done: false };
      yield { text: '', done: true, finishReason: 'stop' };
    };
    await observe(30_000); await service.settled(); await service.resume(); await service.settled();
    const result = await service.snapshot(video.id);
    expect(result.completed).toBe(1); expect(result.failed).toBe(0);
    expect(result.summary?.payload.opening.paragraphs[0]?.sourceCueIds).toEqual(['c0']);
    expect(requests).toHaveLength(1);
  });
  it('换行和尾逗号兼容后正文值与引用保持原样', async () => {
    streamImpl = async function* (options) {
      const payload = output(options);
      payload.paragraphs[0]!.text = '第一行\n第二行';
      const raw = JSON.stringify(payload).replace('\\n', '\n').replace(/}$/, ',}');
      yield { text: raw, done: false }; yield { text: '', done: true };
    };
    await observe(30_000); await service.settled();
    expect((await service.snapshot(video.id)).summary?.payload.opening.paragraphs[0]).toEqual({ text: '第一行\n第二行', sourceCueIds: ['c0'] });
  });
  it('SSE 正常结束但正文为 Markdown 时，提供明确诊断和本机失败返回', async () => {
    const raw = '# 模型测试输出\n- 这不是 JSON';
    streamImpl = async function* () { yield { text: raw, done: false }; yield { text: '', done: true, finishReason: 'stop' }; };
    await observe(30_000); await service.settled(); await service.resume(); await service.settled();
    const result = await service.snapshot(video.id);
    expect(result.summary).toBeNull(); expect(result.failed).toBe(1); expect(requests).toHaveLength(1);
    expect(result.draft?.error?.detail).toContain('kind=non-json');
    expect(result.draft?.error?.detail).toContain('stream=complete; finish=stop');
    expect(result.draft?.error?.detail).not.toContain(raw);
    expect(result.draft?.failureResponse?.text).toBe(raw);
  });
  it('SSE 完整也不补闭合括号或保存半个正文对象', async () => {
    streamImpl = async function* (options) { yield { text: JSON.stringify(output(options)).slice(0, -1), done: false }; yield { text: '', done: true, finishReason: 'stop' }; };
    await observe(30_000); await service.settled();
    const result = await service.snapshot(video.id);
    expect(result.summary).toBeNull(); expect(result.draft?.error?.detail).toContain('kind=incomplete');
    expect(result.draft?.error?.detail).toContain('stream=complete');
  });
  it('格式兼容不能放过越界引用', async () => {
    streamImpl = async function* () {
      yield { text: '{"title":"主题","paragraphs":[{"text":"正文","sourceCueIds":["outside",],},],"bullets":[],}', done: false };
      yield { text: '', done: true };
    };
    await observe(30_000); await service.settled();
    const result = await service.snapshot(video.id);
    expect(result.summary).toBeNull(); expect(result.draft?.error?.code).toBe('VALIDATION_FAILED');
  });
});
