/** 浏览器回归夹具：模拟 Chrome API/模型传输，其余使用真实 UI、SSE 解析及存储。 */
import { createRoot, type Root } from 'react-dom/client';
import { PopupApp } from '../../src/ui/PopupApp';
import { StudyDatabase, setDbForTests, saveTranscript } from '../../src/storage/db';
import { DEFAULT_SETTINGS } from '../../src/storage/settings';
import { createAutoSummaryService } from '../../src/jobs/auto-summary-service';
import { streamChat } from '../../src/ai/stream';
import type { RuntimeRequest } from '../../src/lib/messages';
import '../../src/ui/styles.css';

const db = new StudyDatabase(`ui-auto-fixture-${Date.now()}`);
setDbForTests(db);
const videoId = 'bilibili:BV1GJ411x7h7:111';
const context = { tabId: 1, documentEpoch: 'test', bvid: 'BV1GJ411x7h7', aid: '1001', cid: '111', pageIndex: 1,
  title: '自动学习浏览器测试：每 30 秒追加内容', durationMs: 65_000, positionMs: 0, updatedAt: Date.now() };
const settings = { ...DEFAULT_SETTINGS, consentAcknowledged: true, provider: { ...DEFAULT_SETTINGS.provider, baseUrl: 'https://fixture.invalid/v1', modelId: 'fixture-sse' } };
let positionMs = 0;
let requests = 0;
let root: Root | null = null;
const service = createAutoSummaryService({ db: () => db, keepAlive: () => () => {},
  provider: async () => ({ baseUrl: settings.provider.baseUrl, modelId: 'fixture-sse', apiKey: 'fixture-key', providerId: 'fixture', providerName: '测试夹具', targetLanguage: '简体中文', maxTokens: 2048 }),
  stream: (options) => streamChat({ ...options, fetchImpl: async () => {
    requests += 1;
    const data = JSON.parse(options.messages.at(-1)!.content) as { cues: { cueId: string; text: string }[] };
    const text = JSON.stringify({ title: '本节点的学习要点', paragraphs: data.cues.map((cue) => ({ text: cue.text, sourceCueIds: [cue.cueId] })), bullets: [] });
    const encoder = new TextEncoder(); let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream<Uint8Array>({ start(controller) {
      let offset = 0;
      timer = setInterval(() => {
        if (offset < text.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(offset, offset + 12) } }] })}\r\n\r\n`));
          offset += 12;
        } else { clearInterval(timer); controller.enqueue(encoder.encode('data: [DONE]\n\n')); controller.close(); }
      }, 120);
    }, cancel() { clearInterval(timer); } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  } }),
});

function listenerSet() {
  const listeners = new Set<(value?: unknown) => void>();
  return { addListener: (fn: (value?: unknown) => void) => listeners.add(fn), removeListener: (fn: (value?: unknown) => void) => listeners.delete(fn),
    emit: (value?: unknown) => listeners.forEach((fn) => fn(value)) };
}
const chromeFixture = {
  runtime: { id: 'fixture-extension', getURL: (path: string) => `chrome-extension://fixture-extension/${path}`,
    sendMessage: async (message: RuntimeRequest) => {
      switch (message.type) {
        case 'CAPTURE_VIDEO': return { ok: true, data: { ...context, positionMs } };
        case 'GET_VIDEO_STATE': return { ok: true, data: { paused: false, muted: false, volume: 1, playbackRate: 1, positionMs, durationMs: 65_000, ready: true } };
        case 'AUTO_SUMMARY_SELECT': await service.selectTranscript(message.payload.videoId, message.payload.transcriptId); return { ok: true };
        case 'AUTO_SUMMARY_STATE': return { ok: true, data: await service.snapshot(message.payload.videoId) };
        case 'AUTO_SUMMARY_CONTROL': await service.setEnabled(message.payload.videoId, message.payload.enabled, message.payload.retryFailed); return { ok: true };
        case 'SEEK_VIDEO': positionMs = message.payload.positionMs; return { ok: true };
        default: return { ok: false };
      }
    },
    connect: () => {
      const onMessage = listenerSet(); const onDisconnect = listenerSet(); let unsubscribe: (() => void) | undefined;
      return { onMessage, onDisconnect,
        postMessage(message: { type: string; videoId: string }) {
          unsubscribe?.(); unsubscribe = service.subscribe(message.videoId, (event) => onMessage.emit(event));
          queueMicrotask(() => onMessage.emit({ type: 'changed', videoId: message.videoId }));
        },
        disconnect() { unsubscribe?.(); onDisconnect.emit(); },
      };
    },
  },
  storage: { local: { get: async () => ({ 'settings.v1': settings }) }, session: { get: async () => ({ 'apiKey.session.v1': 'fixture-key' }) }, onChanged: listenerSet() },
  tabs: { create: async () => ({}) },
};
Object.defineProperty(globalThis, 'chrome', { value: chromeFixture, configurable: true });

const ready = (async () => {
  await db.open();
  await db.videos.put({ id: videoId, platform: 'bilibili', ...context, canonicalUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/',
    tags: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await saveTranscript({ videoId, language: 'zh', sourceKind: 'srt', generationKind: 'human', sourceHash: 'fixture', trackLabel: '测试字幕',
    cues: [
      { cueId: 'c0', sequence: 0, sourceIndex: 0, startMs: 0, endMs: 30_000, text: '第一段字幕：先理解任务目标，再把目标拆成可核对的步骤。这里是明确标注的测试夹具，不是真实视频分析。' },
      { cueId: 'c1', sequence: 1, sourceIndex: 1, startMs: 30_000, endMs: 60_000, text: '第二段字幕：任务执行与界面展示分开管理，关闭弹窗不应该取消已经启动的后台工作。' },
      { cueId: 'c2', sequence: 2, sourceIndex: 2, startMs: 60_000, endMs: 65_000, text: '尾段字幕：最后检查已经保存的结果和原文引用。' },
    ] });
  open();
})();
function open() {
  if (root) return;
  root = createRoot(document.getElementById('popup-root')!); root.render(<PopupApp />);
}
const api = {
  ready,
  async advance(ms: number) { await ready; positionMs = ms; await service.observe({ videoId, positionMs, durationMs: 65_000, paused: ms >= 65_000, ended: ms >= 65_000 }); },
  close() { root?.unmount(); root = null; }, open,
  snapshot: () => service.snapshot(videoId), requests: () => requests,
  async cleanup() { root?.unmount(); root = null; await service.settled(); await db.delete(); },
};
Object.assign(window, { __autoUiTest: api });
