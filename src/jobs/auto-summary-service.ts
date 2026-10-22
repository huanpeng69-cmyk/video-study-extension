/**
 * 播放驱动的自动学习。SSE、节点水位和提交均属于 Service Worker。
 * 弹窗只订阅事件；断开订阅不 abort。旧 summaries/notes 不清空、不改写。
 */
import { buildAutoSummaryMessages, summaryStreamPreview, validateAutoSummarySection } from '../ai/auto-summary';
import { parseJsonPayload, sanitizeErrorDetail } from '../ai/client';
import { streamChat } from '../ai/stream';
import { appError, toAppError, type AppError } from '../domain/errors';
import { normalizeEndpoint } from '../domain/endpoint';
import { formatTimecode, type Cue } from '../domain/transcript';
import { liveNode, type AutoSummaryEvent, type AutoSummarySnapshot } from '../lib/auto-summary';
import { vsLog } from '../lib/log';
import { getDb, type StudyDatabase } from '../storage/db';
import { assertProviderReady, loadApiKey, loadSettings, type ReadyProvider } from '../storage/settings';
import type { AutoSummarySession, SummaryNodeRecord, SummaryRecord } from '../storage/types';
import { AUTO_NODE_INTERVAL_MS, AUTO_NODE_VERSION, decideTrigger, nodeRange, summaryNodeId } from './auto-nodes';

export const MAX_AUTO_STREAMS = 2;
export const MAX_NODE_ATTEMPTS = 2; // 仅 SW 中断自动恢复一次；正常请求失败不自动重试。
const MAX_CONSECUTIVE_FAILURES = 3;
/** 后台自动重试失败段的总尝试上限：与 SW 中断恢复共用同一 attempts 计数，避免无限计费。 */
export const MAX_AUTO_RETRY_ATTEMPTS = 4;
const MAX_QUEUED_NODES = 8;
const MAX_NODE_INPUT_CHARS = 16_000;
const MAX_NODE_OUTPUT_CHARS = 65_536;
const BLOCKING_CODES = new Set(['AUTH_FAILED', 'QUOTA_EXCEEDED', 'PROVIDER_NOT_CONFIGURED', 'PERMISSION_DENIED', 'CONSENT_REQUIRED', 'NOT_FOUND']);

export interface PlaybackSample {
  videoId: string;
  positionMs: number;
  durationMs: number;
  paused: boolean;
  ended?: boolean;
}

export interface AutoSummaryDependencies {
  db: () => StudyDatabase;
  provider: () => Promise<ReadyProvider>;
  stream: typeof streamChat;
  now: () => number;
  keepAlive: () => () => void;
}

/** 每次请求前校验授权；后台不会偷偷申请新域名权限或绕过数据发送确认。 */
export async function readyAutoProvider(): Promise<ReadyProvider> {
  const settings = await loadSettings();
  if (!settings.consentAcknowledged) {
    throw appError('CONSENT_REQUIRED', '请在设置中确认允许按播放进度自动发送字幕');
  }
  const provider = assertProviderReady(settings, await loadApiKey(settings));
  const origin = normalizeEndpoint(provider.baseUrl).origin;
  if (!await chrome.permissions.contains({ origins: [`${origin}/*`] })) {
    throw appError('PERMISSION_DENIED', '请先在设置中授权当前模型域名');
  }
  return provider;
}

/** 请求期间才维持 SW 活动；有总请求超时，不是无限保活。 */
function keepWorkerAlive(): () => void {
  const timer = setInterval(() => {
    void chrome.runtime.getPlatformInfo().catch(() => {
      vsLog.warn('auto:keepalive-unavailable', {});
    });
  }, 20_000);
  return () => clearInterval(timer);
}

function safeError(cause: unknown): AppError {
  const error = toAppError(cause, 'UNKNOWN', '自动学习失败');
  return { ...error, message: sanitizeErrorDetail(error.message), detail: error.detail ? sanitizeErrorDetail(error.detail) : undefined };
}

/** 字幕按「开始时间」归入所在节点；末段收纳到视频结束为止。 */
export function cuesForNode(cues: Cue[], node: Pick<SummaryNodeRecord, 'startMs' | 'endMs'>, durationMs: number): Cue[] {
  const lastNode = node.endMs >= durationMs;
  return cues.filter((cue) => cue.startMs >= node.startMs &&
    (lastNode ? cue.startMs < durationMs : cue.startMs < node.endMs));
}

export function autoSummaryId(transcriptId: string): string {
  return `auto-summary:${transcriptId}:${AUTO_NODE_VERSION}`;
}

export function createAutoSummaryService(overrides: Partial<AutoSummaryDependencies> = {}) {
  const deps: AutoSummaryDependencies = {
    db: getDb, provider: readyAutoProvider, stream: streamChat, now: Date.now, keepAlive: keepWorkerAlive, ...overrides,
  };
  const active = new Map<string, { controller: AbortController; node: SummaryNodeRecord; promise: Promise<void> }>();
  const subscribers = new Map<string, Set<(event: AutoSummaryEvent) => void>>();
  const runtimeErrors = new Map<string, AppError>();
  let pumpPromise: Promise<void> | null = null;
  let pumpAgain = false;
  const stamp = () => new Date(deps.now()).toISOString();
  const emit = (event: AutoSummaryEvent) => {
    for (const listener of subscribers.get(event.videoId) ?? []) {
      try { listener(event); } catch { vsLog.warn('auto:subscriber-disconnected', {}); }
    }
  };
  const changed = (videoId: string) => emit({ type: 'changed', videoId });

  async function selectTranscript(videoId: string, transcriptId?: string): Promise<AutoSummarySession | null> {
    const db = deps.db();
    let selectionChanged = false;
    const session = await db.transaction('rw', [db.autoSummarySessions, db.summaryNodes, db.transcripts, db.videos], async () => {
      const video = await db.videos.get(videoId);
      if (!video) return null; // 没有在扩展保存过的视频不启动任务。
      const existing = await db.autoSummarySessions.get(videoId);
      if (existing && (!transcriptId || existing.transcriptId === transcriptId)) return existing;
      const transcript = transcriptId
        ? await db.transcripts.get(transcriptId)
        : (await db.transcripts.where('videoId').equals(videoId).sortBy('createdAt')).at(-1);
      if (!transcript || transcript.videoId !== videoId) {
        if (transcriptId) throw appError('BAD_REQUEST', '字幕版本不属于该视频');
        return null;
      }
      selectionChanged = true;
      if (existing) {
        await db.summaryNodes.where('transcriptId').equals(existing.transcriptId)
          .filter((node) => node.status === 'streaming')
          .modify({ status: 'queued', attemptId: '', rawText: '', previewText: '', updatedAt: stamp() });
      }
      const nodes = await db.summaryNodes.where('transcriptId').equals(transcript.id).toArray();
      const next: AutoSummarySession = {
        id: videoId, videoId, transcriptId: transcript.id, enabled: existing?.enabled ?? true,
        lastNode: nodes.reduce((max, node) => Math.max(max, node.index), -1),
        durationMs: existing?.durationMs || video.durationMs,
        playbackPaused: existing?.playbackPaused ?? true, ended: existing?.ended ?? false,
        lastPositionMs: existing?.lastPositionMs ?? 0, lastObservedAt: existing?.lastObservedAt ?? 0,
        consecutiveFailures: 0, error: null, createdAt: existing?.createdAt ?? stamp(), updatedAt: stamp(),
      };
      await db.autoSummarySessions.put(next);
      return next;
    });
    const running = active.get(videoId);
    if (running && running.node.transcriptId !== session?.transcriptId) running.controller.abort();
    if (selectionChanged) { runtimeErrors.delete(videoId); changed(videoId); }
    return session;
  }

  async function observe(sample: PlaybackSample): Promise<void> {
    if (!Number.isFinite(sample.positionMs) || !Number.isFinite(sample.durationMs) || sample.durationMs <= 0 || sample.positionMs < 0) return;
    if (!await selectTranscript(sample.videoId)) return;
    const db = deps.db();
    let notify = false;
    await db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
      const current = await db.autoSummarySessions.get(sample.videoId);
      if (!current) return;
      const next = { ...current, durationMs: sample.durationMs, playbackPaused: sample.paused,
        ended: sample.ended === true && sample.positionMs >= sample.durationMs - 250,
        lastPositionMs: sample.positionMs, lastObservedAt: deps.now(), updatedAt: stamp() };
      notify = current.playbackPaused !== next.playbackPaused || current.ended !== next.ended;
      const decision = decideTrigger({ ...sample, lastNode: current.lastNode });
      // 注意：`current.error` 是刻意的熔断（含 AUTH_FAILED / 未配置 / 未授权），
      // 不能因为播放继续就自动放行，否则会持续请求失败接口并被反复计费。
      // 解除只能靠用户在自动学习页点「继续/重试失败段」或改配置。
      if (current.enabled && !current.error && decision.fire) {
        const pending = await db.summaryNodes.where('transcriptId').equals(current.transcriptId)
          .filter((node) => node.status === 'queued').count();
        if (pending >= MAX_QUEUED_NODES) {
          next.error = appError('RATE_LIMITED', '待处理节点积压，已暂停自动请求；可稍后继续自动学习');
        } else {
          const id = summaryNodeId(current.transcriptId, decision.index);
          if (!await db.summaryNodes.get(id)) {
            await db.summaryNodes.add({
              id, videoId: sample.videoId, transcriptId: current.transcriptId, index: decision.index,
              ...nodeRange(decision.index, sample.durationMs), status: 'queued', attempts: 0, attemptId: '',
              rawText: '', previewText: '', result: null, providerSnapshot: null, language: '', error: null,
              createdAt: stamp(), updatedAt: stamp(),
            });
          }
          next.lastNode = decision.index;
          vsLog.info('auto:node-queued', { index: decision.index, reason: decision.reason });
        }
        notify = true;
      }
      await db.autoSummarySessions.put(next);
    });
    if (notify) changed(sample.videoId);
    await kick(); // 只完成调度，不等待 SSE。
  }

  /**
   * 字幕就绪即登记自动学习会话（不请求模型，也不伪造播放节点）。
   *
   * 为什么需要：会话原本只在 `observe()` 收到播放位置时才创建，
   * 于是「有字幕、但还没播到 30 秒 / 停在 0 秒 / 一打开就暂停」时，
   * 自动学习页只会显示「正在连接后台…」或什么都不出现。
   * 这里只把会话建出来（enabled 继承既有设置，默认 true），
   * 真正的节点仍由真实播放位置触发，0 秒不会抢跑。
   */
  async function prepare(videoId: string, transcriptId?: string): Promise<AutoSummarySession | null> {
    const session = await selectTranscript(videoId, transcriptId);
    if (session) changed(videoId);
    return session;
  }

  async function setEnabled(videoId: string, enabled: boolean, retryFailed = false): Promise<void> {
    const db = deps.db();
    await db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
      const session = await db.autoSummarySessions.get(videoId);
      if (!session) throw appError('NO_SUBTITLE', '请先载入字幕');
      await db.autoSummarySessions.update(videoId, { enabled, error: null, consecutiveFailures: 0, updatedAt: stamp() });
      const nodes = await db.summaryNodes.where('transcriptId').equals(session.transcriptId).toArray();
      for (const node of nodes) {
        if ((!enabled && node.status === 'streaming') || (enabled && retryFailed && (node.status === 'failed' || node.status === 'queued'))) {
          await db.summaryNodes.update(node.id, { status: 'queued', attemptId: '', attempts: enabled ? 0 : node.attempts,
            rawText: '', previewText: '', error: null, updatedAt: stamp() });
        }
      }
    });
    runtimeErrors.delete(videoId);
    if (!enabled) active.get(videoId)?.controller.abort();
    changed(videoId);
    await kick();
  }

  /**
   * 后台自动重试失败段（由心跳 alarm 驱动，不需要弹窗在开）。
   *
   * 为什么要有次数上限：请求失败可能计费，无上限重试会持续花钱并打死接口。
   * 只重试「可恢复」的失败：网络/超时/格式/校验类；
   * 鉴权、配额、未配置、未授权等属于必须用户先处理的问题，原样跳过。
   * 已放弃的节点（attempts 用尽）不再拾起，避免无限循环。
   */
  async function retryFailedNodes(): Promise<number> {
    const db = deps.db();
    const requeued: string[] = [];
    await db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
      for (const session of await db.autoSummarySessions.toArray()) {
        if (!session.enabled || session.error) continue;
        const nodes = await db.summaryNodes.where('transcriptId').equals(session.transcriptId).toArray();
        for (const node of nodes) {
          if (node.status !== 'failed') continue;
          if (node.attempts >= MAX_AUTO_RETRY_ATTEMPTS) continue;
          const code = node.error?.code ?? '';
          if (BLOCKING_CODES.has(code)) continue;
          await db.summaryNodes.update(node.id, { status: 'queued', attemptId: '',
            rawText: '', previewText: '', error: null, updatedAt: stamp() });
          requeued.push(node.id);
        }
      }
    });
    if (!requeued.length) return 0;
    vsLog.info('auto:retry-failed', { nodes: requeued.length });
    for (const session of await db.autoSummarySessions.toArray()) changed(session.videoId);
    await kick();
    return requeued.length;
  }
  async function pausePlayback(videoId: string): Promise<void> {
    await deps.db().autoSummarySessions.update(videoId, { playbackPaused: true, ended: false, updatedAt: stamp() });
    changed(videoId);
  }

  /** CAS：暂停、切换字幕、删除资料或新尝试后，迟到的 delta/结果不得重新写回。 */
  async function updateNode(node: SummaryNodeRecord, patch: Partial<SummaryNodeRecord>): Promise<boolean> {
    const db = deps.db();
    return db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
      const session = await db.autoSummarySessions.get(node.videoId);
      const current = await db.summaryNodes.get(node.id);
      if (!session?.enabled || session.transcriptId !== node.transcriptId || !current ||
        current.status !== 'streaming' || current.attemptId !== node.attemptId) return false;
      await db.summaryNodes.update(node.id, { ...patch, updatedAt: stamp() });
      return true;
    });
  }

  async function publish(node: SummaryNodeRecord): Promise<boolean> {
    const db = deps.db();
    return db.transaction('rw', [db.autoSummarySessions, db.summaryNodes, db.summaries, db.videos], async () => {
      const session = await db.autoSummarySessions.get(node.videoId);
      const persisted = await db.summaryNodes.get(node.id);
      if (!session?.enabled || session.transcriptId !== node.transcriptId || !await db.videos.get(node.videoId) ||
        !persisted || persisted.status !== 'streaming' || persisted.attemptId !== node.attemptId) return false;
      await db.summaryNodes.put({ ...node, status: 'done', rawText: '', previewText: '', error: null, updatedAt: stamp() });
      const all = await db.summaryNodes.where('transcriptId').equals(node.transcriptId).sortBy('index');
      const done = all.filter((row) => row.status === 'done' && row.result);
      const sections = done.map((row) => ({
        ...row.result!,
        title: `节点 ${row.index} · ${formatTimecode(row.startMs)}–${formatTimecode(row.endMs)} · ${row.result!.title}`,
      }));
      const first = sections[0];
      if (!first || !node.providerSnapshot) throw appError('VALIDATION_FAILED', '节点提交缺少有效正文或模型信息');
      const total = Math.ceil(session.durationMs / AUTO_NODE_INTERVAL_MS);
      const complete = done.length === total && done.every((row, index) => row.index === index);
      const covered = new Set(sections.flatMap((section) => [...section.paragraphs, ...section.bullets].flatMap((block) => block.sourceCueIds)));
      const record: SummaryRecord = {
        id: autoSummaryId(node.transcriptId), videoId: node.videoId, transcriptId: node.transcriptId,
        transcriptRevisionId: node.transcriptId, cacheKey: `${node.transcriptId}|${AUTO_NODE_VERSION}`,
        language: node.language, payload: { opening: first, sections: sections.slice(1) },
        coverage: complete ? 'complete' : 'partial', coveredCueIds: [...covered],
        providerSnapshot: node.providerSnapshot, promptVersion: AUTO_NODE_VERSION, createdAt: stamp(),
        autoStream: { intervalMs: AUTO_NODE_INTERVAL_MS, completedNodes: done.length, totalNodes: total },
      };
      await db.summaries.put(record);
      await db.autoSummarySessions.update(node.videoId, { consecutiveFailures: 0, updatedAt: stamp() });
      return true;
    });
  }

  async function runNode(initial: SummaryNodeRecord, controller: AbortController): Promise<void> {
    const db = deps.db();
    let node = initial;
    let stopKeepAlive: (() => void) | undefined;
    try {
      const session = await db.autoSummarySessions.get(node.videoId);
      if (!session?.enabled || session.error || session.transcriptId !== node.transcriptId || (session.playbackPaused && !session.ended)) return;

      const allCues = await db.cues.where('transcriptId').equals(node.transcriptId).sortBy('sequence');
      const cues = cuesForNode(allCues, node, session.durationMs);
      if (!cues.length) {
        await db.summaryNodes.update(node.id, { status: 'empty', updatedAt: stamp() });
        vsLog.info('auto:node-empty', {
          index: node.index,
          windowMs: `${node.startMs}-${node.endMs}`,
          totalCues: allCues.length,
          inWindow: 0,
          firstCueMs: allCues[0] ? `${allCues[0].startMs}-${allCues[0].endMs}` : null,
          lastCueMs: allCues.at(-1) ? `${allCues.at(-1)!.startMs}-${allCues.at(-1)!.endMs}` : null,
        });
        changed(node.videoId);
        return;
      }
      let provider: ReadyProvider;
      try { provider = await deps.provider(); } catch (cause) {
        await db.autoSummarySessions.update(node.videoId, { error: safeError(cause), updatedAt: stamp() });
        changed(node.videoId);
        return;
      }
      if (controller.signal.aborted) return;
      const claimed = await db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
        const currentSession = await db.autoSummarySessions.get(node.videoId);
        const current = await db.summaryNodes.get(node.id);
        if (!currentSession?.enabled || currentSession.transcriptId !== node.transcriptId || currentSession.error ||
          (currentSession.playbackPaused && !currentSession.ended) || current?.status !== 'queued') return null;
        const next: SummaryNodeRecord = { ...current, status: 'streaming', attempts: current.attempts + 1,
          attemptId: crypto.randomUUID(), rawText: '', previewText: '', error: null, updatedAt: stamp(),
          language: provider.targetLanguage,
          providerSnapshot: { providerId: provider.providerId, providerName: provider.providerName,
            requestUrl: normalizeEndpoint(provider.baseUrl).requestUrl, modelId: provider.modelId } };
        await db.summaryNodes.put(next);
        return next;
      });
      if (!claimed) return;
      node = claimed;
      const running = active.get(node.videoId);
      if (running) running.node = node;
      changed(node.videoId);
      if (node.attempts > MAX_NODE_ATTEMPTS) throw appError('NETWORK_ERROR', '该节点已中断两次，已停止自动恢复；可手动重试失败段');
      if (cues.reduce((count, cue) => count + cue.text.length, 0) > MAX_NODE_INPUT_CHARS) {
        throw appError('TOO_LARGE', '这一时间段字幕过密，已停止请求；未截断原文或伪造结果');
      }
      const title = (await db.videos.get(node.videoId))?.title ?? '';
      stopKeepAlive = deps.keepAlive();
      let lastPersist = 0;
      let lastEmit = 0;
      let complete = false;
      let finishReason = 'not-provided';
      // 引用类失败可原地重写一次：只让模型按真实 cueId 重述，绝不替它补引用。
      const REFS_RETRY_KINDS = ['missing-refs', 'unknown-refs', 'refs-type', 'refs-format'];
      let retry: { reason: string; cueIds: string[] } | undefined;
      for (let round = 0; round < 2; round += 1) {
        const messages = buildAutoSummaryMessages({ cues, title, targetLanguage: provider.targetLanguage, retry });
        vsLog.info('auto:stream-start', { index: node.index, attempt: node.attempts, cues: cues.length, round });
        for await (const delta of deps.stream({
          baseUrl: provider.baseUrl, modelId: provider.modelId, apiKey: provider.apiKey,
          messages, maxTokens: Math.max(1024, Math.min(4096, provider.maxTokens)),
          temperature: 0.2, signal: controller.signal,
        })) {
          if (controller.signal.aborted) throw appError('ABORTED', '已暂停自动学习');
          complete ||= delta.done;
          if (delta.done && delta.finishReason) finishReason = delta.finishReason === 'stop' ? 'stop' : 'other';
          if (!delta.text) continue;
          node = { ...node, rawText: node.rawText + delta.text, updatedAt: stamp() };
          if (node.rawText.length > MAX_NODE_OUTPUT_CHARS) throw appError('TOO_LARGE', '节点输出超出安全上限');
          node.previewText = summaryStreamPreview(node.rawText);
          const currentActive = active.get(node.videoId);
          if (currentActive) currentActive.node = node;
          if (deps.now() - lastPersist >= 500) {
            if (!await updateNode(node, { rawText: node.rawText, previewText: node.previewText })) throw appError('ABORTED', '该节点已失效');
            lastPersist = deps.now();
          }
          if (deps.now() - lastEmit >= 50) {
            emit({ type: 'delta', videoId: node.videoId, node: liveNode(node) });
            lastEmit = deps.now();
          }
        }
        if (!complete) throw appError('BAD_RESPONSE', '流式连接未完整结束，草稿不会保存为正式内容');
        try {
          node.result = validateAutoSummarySection(parseJsonPayload(node.rawText), cues.map((cue) => cue.cueId));
          break;
        } catch (cause) {
          const error = safeError(cause);
          if (error.detail?.startsWith('phase=model-json')) error.detail += `; stream=complete; finish=${finishReason}`;
          const kind = /kind=([a-z-]+)/.exec(error.detail ?? '')?.[1] ?? '';
          // 只有「引用写得不对」才值得重述；JSON 语法坏、正文空、结构缺失都不重试。
          if (round === 0 && error.code === 'VALIDATION_FAILED' && REFS_RETRY_KINDS.includes(kind)) {
            retry = { reason: error.message, cueIds: cues.map((cue) => cue.cueId) };
            vsLog.info('auto:refs-retry', { index: node.index, kind });
            node = { ...node, rawText: '', previewText: '' };
            complete = false;
            finishReason = 'not-provided';
            continue;
          }
          throw error;
        }
      }
      if (!node.result) throw appError('VALIDATION_FAILED', '节点正文未通过校验');
      if (await publish(node)) vsLog.info('auto:stream-completed', { index: node.index });
    } catch (cause) {
      const error = safeError(cause);
      const saved = await updateNode(node, { status: 'failed', rawText: node.rawText, previewText: node.previewText, error });
      if (!saved && node.status === 'queued' && error.code !== 'ABORTED') {
        runtimeErrors.set(node.videoId, error);
        await db.autoSummarySessions.update(node.videoId, { error, updatedAt: stamp() });
      }
      if (saved) {
        await db.transaction('rw', db.autoSummarySessions, async () => {
          const session = await db.autoSummarySessions.get(node.videoId);
          if (!session || session.transcriptId !== node.transcriptId) return;
          const failures = session.consecutiveFailures + 1;
          await db.autoSummarySessions.update(node.videoId, { consecutiveFailures: failures, updatedAt: stamp(),
            error: BLOCKING_CODES.has(error.code) || failures >= MAX_CONSECUTIVE_FAILURES ? error : null });
        });
        vsLog.warn('auto:stream-failed', { index: node.index, code: error.code });
      }
    } finally {
      stopKeepAlive?.();
      changed(node.videoId);
    }
  }

  async function pumpOnce(): Promise<void> {
    const db = deps.db();
    const sessions = await db.autoSummarySessions.toArray();
    for (const session of sessions) {
      if (active.size >= MAX_AUTO_STREAMS) return;
      if (active.has(session.videoId) || runtimeErrors.has(session.videoId) || !session.enabled || session.error || (session.playbackPaused && !session.ended)) continue;
      const node = (await db.summaryNodes.where('transcriptId').equals(session.transcriptId)
        .filter((row) => row.status === 'queued').sortBy('index'))[0];
      if (!node) continue;
      const controller = new AbortController();
      // 先占位后异步执行，避免连续播放上报重复领取同一节点。
      const entry = { controller, node, promise: Promise.resolve() };
      active.set(session.videoId, entry);
      entry.promise = runNode(node, controller).catch((cause) => {
        runtimeErrors.set(session.videoId, safeError(cause));
        vsLog.error('auto:storage-or-run-failed', { code: safeError(cause).code });
      }).finally(() => {
        if (active.get(session.videoId) === entry) active.delete(session.videoId);
        changed(session.videoId);
        void kick().catch((cause) => vsLog.error('auto:schedule-failed', { code: safeError(cause).code }));
      });
    }
  }

  function kick(): Promise<void> {
    pumpAgain = true;
    if (pumpPromise) return pumpPromise;
    pumpPromise = (async () => {
      do { pumpAgain = false; await pumpOnce(); } while (pumpAgain);
    })().finally(() => { pumpPromise = null; });
    return pumpPromise;
  }

  /** 心跳恢复在途节点。HTTP 连接无法跨 SW 终止保留，最多重新请求一次。 */
  async function resume(): Promise<void> {
    const db = deps.db();
    const nodes = await db.summaryNodes.where('status').equals('streaming').toArray();
    for (const node of nodes) {
      if (active.get(node.videoId)?.node.id === node.id) continue;
      await db.transaction('rw', db.summaryNodes, async () => {
        const current = await db.summaryNodes.get(node.id);
        if (!current || current.status !== 'streaming' || current.attemptId !== node.attemptId || active.has(node.videoId)) return;
        const exhausted = current.attempts >= MAX_NODE_ATTEMPTS;
        await db.summaryNodes.update(node.id, { status: exhausted ? 'failed' : 'queued', attemptId: '',
          rawText: '', previewText: '', updatedAt: stamp(),
          error: exhausted ? appError('NETWORK_ERROR', '后台连接已中断两次，停止自动恢复；可重试失败段') : null });
      });
      changed(node.videoId);
    }
    await kick();
  }

  async function settingsChanged(): Promise<void> {
    const db = deps.db();
    runtimeErrors.clear();
    let error: AppError | null = null;
    try { await deps.provider(); } catch (cause) { error = safeError(cause); }
    await db.transaction('rw', db.autoSummarySessions, db.summaryNodes, async () => {
      const sessions = await db.autoSummarySessions.toArray();
      for (const session of sessions) {
        await db.autoSummarySessions.update(session.id, { error, consecutiveFailures: 0, updatedAt: stamp() });
        if (error) {
          const running = active.get(session.id);
          if (running) await db.summaryNodes.update(running.node.id, { status: 'queued', attemptId: '', rawText: '', previewText: '', updatedAt: stamp() });
        }
      }
    });
    for (const running of active.values()) if (error) running.controller.abort();
    for (const session of await db.autoSummarySessions.toArray()) changed(session.videoId);
    await kick();
  }

  async function snapshot(videoId: string): Promise<AutoSummarySnapshot> {
    const db = deps.db();
    const session = await db.autoSummarySessions.get(videoId);
    const nodes = session ? await db.summaryNodes.where('transcriptId').equals(session.transcriptId).sortBy('index') : [];
    const summary = session ? await db.summaries.get(autoSummaryId(session.transcriptId)) ??
      (await db.summaries.where('transcriptId').equals(session.transcriptId).sortBy('createdAt')).at(-1) ?? null : null;
    const running = active.get(videoId)?.node;
    const persistedLive = nodes.find((node) => node.status === 'streaming');
    const live = persistedLive && running?.attemptId === persistedLive.attemptId ? running : persistedLive;
    const last = nodes.at(-1);
    const draft = live ?? nodes.find((node) => node.status === 'queued') ??
      (last?.status === 'failed' || last?.status === 'empty' ? last : null);
    const queued = nodes.filter((node) => node.status === 'queued').length;
    const failure = session?.error ?? runtimeErrors.get(videoId) ?? null;
    const message = !session ? '请先获取、导入或转写字幕' : !session.enabled ? '已暂停自动学习' : failure ? failure.message :
      live ? `SSE 正在读取节点 ${live.index}（关闭弹窗仍继续）` :
      session.playbackPaused && !session.ended ? '视频已暂停，恢复播放后继续自动触发' :
      queued ? `等待处理 ${queued} 个已触发节点` : session.ended ? '播放已结束，已保留通过校验的节点' :
      '自动学习已开启，等待下一个 30 秒节点';
    return { videoId, transcriptId: session?.transcriptId ?? null, enabled: session?.enabled ?? true,
      playbackPaused: session?.playbackPaused ?? true, ended: session?.ended ?? false,
      completed: nodes.filter((node) => node.status === 'done').length,
      total: session ? Math.ceil(session.durationMs / AUTO_NODE_INTERVAL_MS) : 0, queued,
      failed: nodes.filter((node) => node.status === 'failed').length, empty: nodes.filter((node) => node.status === 'empty').length,
      message, error: failure, draft: draft ? liveNode(draft) : null, summary };
  }

  return {
    observe, prepare, selectTranscript, setEnabled, pausePlayback, resume, settingsChanged, snapshot, retryFailedNodes,
    subscribe(videoId: string, listener: (event: AutoSummaryEvent) => void): () => void {
      const listeners = subscribers.get(videoId) ?? new Set();
      listeners.add(listener); subscribers.set(videoId, listeners);
      return () => { listeners.delete(listener); if (!listeners.size) subscribers.delete(videoId); };
    },
    /** 测试和关停使用：等待已启动任务；未到达的播放节点不会因此触发。 */
    async settled(): Promise<void> {
      for (;;) {
        await pumpPromise;
        const running = [...active.values()].map((entry) => entry.promise);
        if (!running.length && !pumpPromise) return;
        await Promise.all(running);
      }
    },
  };
}

export const autoSummaryService = createAutoSummaryService();
