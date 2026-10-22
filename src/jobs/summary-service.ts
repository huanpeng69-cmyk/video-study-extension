/**
 * 后台总结服务（Service Worker 内执行）。
 *
 * 为什么必须在后台而不是弹窗里跑：
 * 弹窗是普通扩展页面，关闭即销毁，页面里的循环会随之消失。段级结果虽已提交，
 * 但「合并 + 落库成最终总结」这最后一步会丢失，用户重开只看到半成品或什么都没有。
 * 这里把执行权交给 Service Worker，弹窗只负责「发起」和「查看进度」，关掉弹窗不影响任务。
 *
 * 不中断的三层保障：
 * 1. 所有权在后台：任务状态、段落结果、最终总结都写 IndexedDB，不依赖任何页面存活。
 * 2. 心跳与自愈：`chrome.alarms` 周期唤醒，检查是否有未终结任务需要推进。
 * 3. 幂等续跑：每段提交前校验 generation，重入时只补未完成段落，不重复计费。
 *
 * 明确限制：MV3 Service Worker 仍可能在极端情况下被终止（浏览器退出、扩展重载）。
 * 这些情况任务不会静默消失——状态留在 IndexedDB，下一次心跳或用户重开时自动续跑。
 */
import { buildMergeMessages, buildSummaryMessages, buildCacheKey, cueRangeKey, PROMPT_VERSION } from '../ai/prompts';
import { parseJsonPayload, requestChat } from '../ai/client';
import { appError, toAppError, type AppError } from '../domain/errors';
import { summaryCoveredCueIds, validateSummary, type SummaryPayload } from '../domain/aiResult';
import { DEFAULT_CHUNK_INTERVAL_MS, planChunks, type ChunkPlan } from '../domain/chunking';
import { normalizeEndpoint } from '../domain/endpoint';
import type { Cue } from '../domain/transcript';
import { vsLog } from '../lib/log';
import { getCues, getDb, getVideo, listChunkResults, listJobs, listTranscripts, putJob, saveSummary } from '../storage/db';
import {
  buildJobRecord,
  commitChunk,
  findReusableJob,
  markJobRunning,
  markJobState,
} from '../storage/jobs';
import { assertProviderReady, loadApiKey, loadSettings, type ReadyProvider } from '../storage/settings';
import type { JobRecord, SummaryRecord } from '../storage/types';

/** 后台任务的阶段：排队 → 抽取各段 → 合并 → 落库。 */
export type SummaryStage = 'queued' | 'extracting' | 'merging' | 'completed' | 'partial' | 'failed' | 'cancelled';

export interface SummaryProgress {
  jobId: string;
  videoId: string;
  stage: SummaryStage;
  /** 已完成的抽取段数。 */
  completed: number;
  /** 总段数（不含合并这一步）。 */
  total: number;
  failedChunks: number;
  updatedAt: string;
  /** 面向用户的单行状态说明。 */
  message: string;
  /** 失败时的错误码，便于区分是鉴权还是网络问题。 */
  errorCode?: string;
}

/**
 * 内存中的运行态索引：只用于避免同一任务被并发执行，不作为事实来源。
 * 事实来源永远是 IndexedDB 里的 job 记录与 chunkResults。
 */
const RUNNING = new Set<string>();
const abortControllers = new Map<string, AbortController>();

export function isRunning(videoId: string): boolean {
  return Array.from(RUNNING).some((jobId) => abortControllers.has(jobId) && jobId.includes(videoId));
}

/** 让后台在每次被唤醒时检查：是否还有未完成的总结任务需要推进。 */
export async function resumePendingSummaries(): Promise<void> {
  const pending = await findPendingSummaryJobs();
  if (pending.length === 0) return;
  vsLog.info('summary:resume', { count: pending.length });
  for (const job of pending) {
    // 串行推进，避免并发抢占同一个视频的字幕与配额。
    await runSummaryJob(job).catch((cause) => {
      vsLog.warn('summary:resume-failed', { jobId: job.id, message: toAppError(cause).message });
    });
  }
}

/**
 * 心跳扫描：找出「确实还有待办段」的总结任务。
 *
 * 与 findLiveSummaryJob 同样的理由：不能把「有段永久失败」的任务一直捡起来重跑。
 * 只挑还有 pending/running 段的，或全部完成但尚未合并落库的。
 */
export async function findPendingSummaryJobs(): Promise<JobRecord[]> {
  const jobs = await getDb().jobs.toArray();
  return jobs.filter((job) => {
    if (job.type !== 'summary') return false;
    if (job.state === 'completed' || job.state === 'cancelled' || job.state === 'failed') return false;
    const hasWorkLeft = job.chunkPlan.some((chunk) => chunk.status === 'pending' || chunk.status === 'running');
    const allDoneButUnmerged = job.chunkPlan.length > 0 && job.chunkPlan.every((chunk) => chunk.status === 'done');
    return hasWorkLeft || allDoneButUnmerged;
  });
}

export interface StartSummaryResult {
  progress: SummaryProgress;
  /** 是否复用了已有任务（不会重复计费已完成的段落）。 */
  reused: boolean;
}

/**
 * 发起（或续跑）一次总结。
 *
 * 每个视频同时只允许一个总结任务：重复点击直接返回当前进度并推进它，
 * 避免同一份字幕被并行提交两遍造成双倍计费。
 */
export async function startSummary(videoId: string): Promise<StartSummaryResult> {
  const video = await getVideo(videoId);
  if (!video) throw appError('NOT_FOUND', '找不到该视频记录，请先在视频页重新识别');

  const transcripts = await listTranscripts(videoId);
  const transcript = transcripts[0];
  if (!transcript) {
    throw appError('NO_SUBTITLE', '该视频还没有字幕', { detail: '请先获取字幕、导入字幕或从音频转写。' });
  }
  const cues = await getCues(transcript.id);
  if (cues.length === 0) {
    throw appError('PARSE_FAILED', '该字幕版本没有条目', { detail: '请重新获取字幕后再生成总结。' });
  }

  const existing = await findLiveSummaryJob(videoId);
  if (existing) {
    void runSummaryJob(existing).catch(() => undefined);
    return { progress: describeJob(existing, cues.length), reused: true };
  }

  const provider = await readyProvider();
  const endpoint = normalizeEndpoint(provider.baseUrl);
  const plans = planChunks(cues);
  const fingerprint = buildCacheKey({
    videoId,
    transcriptId: transcript.id,
    sourceHash: transcript.sourceHash,
    task: 'summary',
    targetLanguage: provider.targetLanguage,
    providerId: provider.providerId,
    normalizedEndpoint: endpoint.requestUrl,
    modelId: provider.modelId,
    range: cueRangeKey(cues),
    paramsFingerprint: String(provider.maxTokens),
  });

  const reusable = await findReusableJob(await listJobs(videoId), {
    type: 'summary',
    videoId,
    transcriptId: transcript.id,
    inputHash: transcript.sourceHash,
    configFingerprint: fingerprint,
  });

  let job: JobRecord;
  if (reusable) {
    job = await markJobRunning(reusable.job);
  } else {
    job = buildJobRecord({
      type: 'summary',
      videoId,
      transcriptId: transcript.id,
      inputHash: transcript.sourceHash,
      configSnapshot: {
        providerId: provider.providerId,
        providerName: provider.providerName,
        requestUrl: endpoint.requestUrl,
        modelId: provider.modelId,
        baseUrl: endpoint.baseUrl,
        targetLanguage: provider.targetLanguage,
        maxTokens: provider.maxTokens,
      },
      configFingerprint: fingerprint,
      plans,
      ownerId: 'background',
    });
    await putJob(job);
  }

  vsLog.info('summary:start', {
    videoId,
    transcriptId: transcript.id,
    chunks: plans.length,
    cues: cues.length,
    reused: Boolean(reusable),
  });

  // 后台执行，不 await：弹窗可以立刻关闭，任务由 Service Worker 推进。
  void runSummaryJob(job).catch((cause) => {
    vsLog.error('summary:run-failed', { jobId: job.id, message: toAppError(cause).message });
  });

  return { progress: describeJob(job, cues.length), reused: Boolean(reusable) };
}

/** 查询某个视频当前的总结进度；无未终结任务时返回 null。 */
export async function summaryProgress(videoId: string): Promise<SummaryProgress | null> {
  const job = await findLiveSummaryJob(videoId);
  if (!job) return null;
  const cues = await getCues(job.transcriptId).catch(() => [] as Cue[]);
  return describeJob(job, cues.length);
}

/** 取消某个视频正在跑的总结任务。已完成的段落仍会保留。 */
export async function cancelSummary(videoId: string): Promise<boolean> {
  const job = await findLiveSummaryJob(videoId);
  if (!job) return false;
  abortControllers.get(job.id)?.abort();
  await markJobState(job, 'cancelled');
  vsLog.info('summary:cancel', { jobId: job.id });
  return true;
}

/**
 * 当前是否有「值得继续推进」的总结任务。
 *
 * 关键修复（0.5.0）：旧实现把 partial 也算作活跃任务，于是一旦有段永久失败
 * （例如输出被截断导致 JSON 非法），任务就永远处于「未终结」状态：
 * 心跳每分钟唤醒、每次打开弹窗都重新发起那些注定失败的请求，
 * 用户看到进度条一直转、耗时无限拉长——这才是「又变慢」的真正来源。
 *
 * 现在只有两种情况算活跃：
 * - pending/running 的段（确实还有活儿要干）；
 * - 全部段已完成但还没落库最终总结（需要走合并这一步）。
 * 反之：没有待办段的任务不再被自动重跑，用户可在界面上手动「重新生成」。
 */
async function findLiveSummaryJob(videoId: string): Promise<JobRecord | null> {
  const jobs = await listJobs(videoId);
  const candidate = jobs.find(
    (job) => job.type === 'summary' && job.state !== 'completed' && job.state !== 'cancelled' && job.state !== 'failed',
  );
  if (!candidate) return null;
  const hasWorkLeft = candidate.chunkPlan.some((chunk) => chunk.status === 'pending' || chunk.status === 'running');
  const allDoneButUnmerged = candidate.chunkPlan.every((chunk) => chunk.status === 'done');
  return hasWorkLeft || allDoneButUnmerged ? candidate : null;
}

function describeJob(job: JobRecord, cueCount: number): SummaryProgress {
  const done = job.chunkPlan.filter((chunk) => chunk.status === 'done').length;
  const total = job.chunkPlan.length;
  const failedChunks = job.chunkPlan.filter((chunk) => chunk.status === 'failed').length;
  const stage = mapStage(job.state, done, total);
  return {
    jobId: job.id,
    videoId: job.videoId,
    stage,
    completed: done,
    total,
    failedChunks,
    updatedAt: job.updatedAt,
    message: describeStage(stage, done, total, cueCount),
    errorCode: job.chunkPlan.find((chunk) => chunk.errorCode)?.errorCode ?? undefined,
  };

}
function mapStage(state: JobRecord['state'], done: number, total: number): SummaryStage {
  switch (state) {
    case 'queued':
      return 'queued';
    case 'running':
      // 所有段都完成时说明已进入合并阶段。
      return total > 0 && done >= total ? 'merging' : 'extracting';
    case 'completed':
      return 'completed';
    case 'partial':
      return 'partial';
    case 'cancelled':
      return 'cancelled';
    case 'failed':
      return 'failed';
    default:
      return 'extracting';
  }
}

function describeStage(stage: SummaryStage, done: number, total: number, cueCount: number): string {
  switch (stage) {
    case 'queued':
      return '任务已排队（后台继续执行，可关闭弹窗）';
    case 'extracting':
      return `后台整理中 ${done}/${total} 段（共 ${cueCount} 条字幕）`;
    case 'merging':
      return '各段完成，正在合并为完整总结';
    case 'completed':
      return '总结已完成';
    case 'partial':
      return `总结仅覆盖部分内容（${done}/${total} 段），可重试补齐`;
    case 'cancelled':
      return '任务已取消';
    case 'failed':
      return '任务失败，可重新生成';
    default:
      return '处理中';
  }
}

/**
 * 执行（或继续执行）一个总结任务。
 * 幂等：已完成段落由 chunkPlan 记录，重入时只跑剩下的段。
 */
export async function runSummaryJob(job: JobRecord): Promise<void> {
  if (RUNNING.has(job.id)) return;
  RUNNING.add(job.id);
  const controller = new AbortController();
  abortControllers.set(job.id, controller);

  let current = job;
  try {
    const provider = await readyProvider();
    const cues = await getCues(current.transcriptId);
    const cueIndex = new Map(cues.map((cue) => [cue.cueId, cue]));
    const title = (await getVideo(current.videoId))?.title ?? '未命名视频';
    // 按固定时间间隔切段：段与视频时间一一对应，进度可解释、章节顺序自然。
    const allPlans = planChunks(cues, { intervalMs: DEFAULT_CHUNK_INTERVAL_MS });
    const doneKeys = new Set(
      current.chunkPlan.filter((chunk) => chunk.status === 'done').map((chunk) => chunk.chunkKey),
    );
    const pendingPlans = allPlans.filter((plan) => !doneKeys.has(plan.chunkKey));

    /**
     * 每完成一段就增量落库一份可读总结。
     *
     * 这是「逐步产出」的关键：以前只在 finalize 时写 summaries 表，
     * 用户必须等到全部段跑完才看到任何内容。现在每段完成即写一份快照，
     * 弹窗轮询就能读到并往下追加新章节，不必等全片结束。
     *
     * 快照只包含已完成的段，且标记 coverage='partial'，
     * 直到 finalize 合并完成才改为 complete——不把半成品说成成品。
     */
    const publishPartial = async () => {
      const rows = await listChunkResults(current.id);
      const doneMap = new Map(rows.filter((row) => row.status === 'done').map((row) => [row.chunkKey, row.payload]));
      const ordered = current.chunkPlan
        .map((chunk) => doneMap.get(chunk.chunkKey) as SummaryPayload | undefined)
        .filter((payload): payload is SummaryPayload => Boolean(payload));
      if (ordered.length === 0) return;
      await saveSummary(buildSummaryRecord(current, provider, mergeIncremental(ordered), 'partial'));
    };

    vsLog.info('summary:run', {
      jobId: current.id,
      pending: pendingPlans.length,
      done: doneKeys.size,
      total: allPlans.length,
    });

    // 阶段一：抽取各段。有界并发而非严格串行——每段都是一次完整的大模型往返，
    // 串行时总耗时 = 段数 × 单段延迟；并发 3 路可把墙钟时间降到约 1/3，
    // 同时不把服务端限流打爆（保持 3 是为了兼容免费层的 RPM 限制）。
    await runExtractionStage({
      plans: pendingPlans,
      concurrency: SUMMARY_CONCURRENCY,
      signal: controller.signal,
      runOne: async (plan) => {
        const result = await requestChat({
          baseUrl: provider.baseUrl,
          modelId: provider.modelId,
          apiKey: provider.apiKey,
          maxTokens: summaryOutputBudget(plan.cues.length, provider.maxTokens),
          temperature: 0.2,
          messages: buildSummaryMessages({ plan, targetLanguage: provider.targetLanguage, title }),
          signal: controller.signal,
        });
        const payload = parseJsonPayload(result.content);
        const validated = validateSummary(payload, { visibleCueIds: plan.cues.map((cue) => cue.cueId) });
        if (!validated.ok) throw validated.error;
        await commitChunk(current, plan.chunkKey, validated.summary, result.usage);
        current = {
          ...current,
          chunkPlan: current.chunkPlan.map((chunk) =>
            chunk.chunkKey === plan.chunkKey ? { ...chunk, status: 'done' as const, errorCode: null } : chunk,
          ),
        };
        // 每段完成即发一份可读快照：界面据此随进度往下追加章节，不必等全片结束。
        await publishPartial();
      },
      onFailure: async (plan, error) => {
        current = {
          ...current,
          chunkPlan: current.chunkPlan.map((chunk) =>
            chunk.chunkKey === plan.chunkKey ? { ...chunk, status: 'failed' as const, errorCode: error.code } : chunk,
          ),
        };
        await putJob({ ...current, state: 'running' });
      },
      shouldStop: (error) => isFatal(error),
    });

    if (controller.signal.aborted) {
      await markJobState(current, 'cancelled');
      return;
    }
    const fatalFailure = current.chunkPlan.find((chunk) => chunk.status === 'failed' && chunk.errorCode && isFatalCode(chunk.errorCode));
    if (fatalFailure) {
      // 已有段落仍然合并落库，让用户至少拿到部分结果。
      await finalize(
        current,
        cues,
        cueIndex,
        appError(fatalFailure.errorCode as never, '该段生成失败'),
      );
      return;
    }

    await finalize(current, cues, cueIndex, null);
    return;
  } catch (cause) {
    const error = toAppError(cause, 'UNKNOWN', '总结任务失败');
    vsLog.error('summary:job-error', { jobId: current.id, code: error.code, message: error.message });
    await markJobState(current, error.code === 'ABORTED' ? 'cancelled' : 'failed').catch(() => undefined);
    throw error;
  } finally {
    abortControllers.delete(job.id);
    RUNNING.delete(job.id);
  }
}

/** 并发度：兼顾提速与免费层 RPM 限制。 */
export const SUMMARY_CONCURRENCY = 3;

function isFatalCode(code: string): boolean {
  return ['AUTH_FAILED', 'QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'PROVIDER_NOT_CONFIGURED', 'NOT_FOUND'].includes(code);
}

/**
 * 有界并发执行抽取段。
 *
 * 用「固定数量 worker 抢任务」而不是 `Promise.all`：
 * - 一次性发起几十个请求会撞上服务端限流，反而更慢；
 * - 固定 worker 让在途请求数恒等于 concurrency，速度可控、失败可控；
 * - 某段失败不阻塞其他段，已完成的段照常落库。
 */
async function runExtractionStage(input: {
  plans: ChunkPlan[];
  concurrency: number;
  signal?: AbortSignal;
  runOne: (plan: ChunkPlan) => Promise<void>;
  onFailure: (plan: ChunkPlan, error: AppError) => Promise<void>;
  shouldStop: (error: AppError) => boolean;
}): Promise<void> {
  const queue = [...input.plans];
  let stopped = false;
  /** 连续失败计数：成功一段即清零。用于熔断全局性问题。 */
  let consecutiveFailures = 0;

  const worker = async () => {
    for (;;) {
      if (stopped || input.signal?.aborted) return;
      const plan = queue.shift();
      if (!plan) return;
      try {
        await input.runOne(plan);
        consecutiveFailures = 0;
      } catch (cause) {
        const error = toAppError(cause, 'UNKNOWN', '该段生成失败');
        if (error.code === 'ABORTED') return;
        consecutiveFailures += 1;
        const fatal = input.shouldStop(error);
        // 连续失败说明是系统性问题（预算过小 / 服务异常），继续跑只是浪费时间。
        const tripped = consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
        vsLog.warn('summary:chunk-failed', {
          chunkKey: plan.chunkKey,
          code: error.code,
          fatal,
          consecutiveFailures,
          tripped,
        });
        await input.onFailure(plan, error);
        // 鉴权/额度类错误继续跑只会重复失败；连续失败达阈值也同样停止本轮。
        if (fatal || tripped) stopped = true;
      }
    }
  };

  const workers = Math.max(1, Math.min(input.concurrency, input.plans.length));
  await Promise.all(Array.from({ length: workers }, () => worker()));
}

/**
 * 是否属于「继续跑只会重复失败」的错误。
 *
 * 注意 BAD_RESPONSE（输出被截断、JSON 非法）**不在此列**：
 * 它通常与具体段内容有关，其他段仍可能成功，所以不整体中断。
 * 但若连续多段都失败，说明是全局性问题（例如 max_tokens 仍偏小），
 * 由 runExtractionStage 的连续失败熔断兜底，避免把时间耗在注定失败的段上。
 */
function isFatal(error: AppError): boolean {
  return ['AUTH_FAILED', 'QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'PROVIDER_NOT_CONFIGURED', 'NOT_FOUND'].includes(
    error.code,
  );
}

/**
 * 连续失败多少段就停止本轮。
 * 用「连续」而非「累计」：偶发的单段失败不应影响整体，
 * 而连续失败几乎一定意味着输入/预算/服务层面的系统性问题。
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * 阶段二：合并已完成的段落并落库成可查看的总结。
 * fatal 非空表示因鉴权/额度等不可恢复错误提前收尾：此时若无任何段落则直接抛错。
 */
async function finalize(
  job: JobRecord,
  cues: Cue[],
  cueIndex: Map<string, Cue>,
  fatal: AppError | null,
): Promise<void> {
  const provider = await readyProvider();
  const persisted = (await listJobs(job.videoId)).find((item) => item.id === job.id) ?? job;
  const rows = await listChunkResults(job.id);
  const doneMap = new Map(rows.filter((row) => row.status === 'done').map((row) => [row.chunkKey, row.payload]));
  // 顺序以 chunkPlan 为准，不依赖 IndexedDB 的返回顺序。
  const ordered = persisted.chunkPlan
    .map((chunk) => doneMap.get(chunk.chunkKey) as SummaryPayload | undefined)
    .filter((payload): payload is SummaryPayload => Boolean(payload));

  if (ordered.length === 0) {
    await markJobState(persisted, 'failed');
    if (fatal) throw fatal;
    throw appError('VALIDATION_FAILED', '没有生成可用的总结', { detail: '可检查模型与配额后重试。' });
  }

  let merged: SummaryPayload;
  let coverage: SummaryRecord['coverage'] = 'complete';
  const first = ordered[0];
  try {
    if (ordered.length === 1 && first) {
      merged = first;
    } else {
      const visible = cues.map((cue) => cue.cueId);
      const result = await requestChat({
        baseUrl: provider.baseUrl,
        modelId: provider.modelId,
        apiKey: provider.apiKey,
        maxTokens: summaryOutputBudget(cues.length, provider.maxTokens),
        temperature: 0.2,
        messages: buildMergeMessages(
          ordered.map((payload) => JSON.stringify(payload)),
          provider.targetLanguage,
        ),
      });
      const parsed = parseJsonPayload(result.content);
      const validated = validateSummary(parsed, { visibleCueIds: visible });
      if (!validated.ok) throw validated.error;
      merged = validated.summary;
    }
  } catch (cause) {
    // 合并失败不丢已完成的段：保留第一段并标记 partial，用户至少能看到内容。
    const error = toAppError(cause, 'VALIDATION_FAILED', '合并阶段失败');
    vsLog.warn('summary:merge-failed', { jobId: job.id, code: error.code, message: error.message });
    if (!first) throw error;
    merged = first;
    coverage = 'partial';
  }

  const failedCount = persisted.chunkPlan.filter((chunk) => chunk.status === 'failed').length;
  if (failedCount > 0 || ordered.length < persisted.chunkPlan.length) coverage = 'partial';

  const covered = summaryCoveredCueIds(merged, new Set(cueIndex.keys())).slice(0, 4000);

  const record = buildSummaryRecord(persisted, provider, merged, coverage, covered);
  await saveSummary(record);
  await markJobState(persisted, coverage === 'complete' ? 'completed' : 'partial');
  vsLog.info('summary:done', {
    jobId: persisted.id,
    coverage,
    sections: merged.sections.length + 1,
    bullets: merged.sections.reduce((sum, section) => sum + section.bullets.length, 0),
    covered: covered.length,
  });
}

/** 取回可用凭据；缺 Key 或模型时给出可操作错误。 */
async function readyProvider(): Promise<ReadyProvider> {
  const settings = await loadSettings();
  const apiKey = await loadApiKey(settings);
  return assertProviderReady(settings, apiKey);
}

/**
 * 按本段规模估算输出预算。
 *
 * 关键教训（0.5.0 修复）：0.4.0 版本按「输入字符数」估算，在旧结构下够用，
 * 但 0.5.0 换成了「章节 + 段落/条目」结构，每个块都要带 sourceCueIds 数组，
 * 输出体积大幅上升。240 条字幕按旧公式只给 1952 tokens，
 * 而实际需要约 4000+，于是**每一段都必然截断**——不是偶发慢，是确定性失败。
 *
 * 新公式按「字幕条数」估算输出块数，再折算 token：
 * - 约 6 条字幕产出一个段落或条目（经验值，偏保守）；
 * - 每个块含 text 与 sourceCueIds，约 150 字符、即约 100 tokens；
 * - 预留 512 tokens 给 JSON 骨架与标题。
 * 上限保持 8192，避免个别服务对超大 max_tokens 直接报错。
 */
export function summaryOutputBudget(cueCount: number, configured: number): number {
  const blocks = Math.ceil(cueCount / 6);
  const byBlocks = blocks * 100 + 512;
  // 用户配置的 maxTokens 作为下限参考，但不能低于旧版的 2048——
  // 新结构的输出天然比旧结构长，沿用旧下限会导致同样的截断问题。
  const floor = Math.max(2048, Math.min(configured, 4096));
  return Math.max(floor, Math.min(byBlocks, 8192));
}

/** 应停止本轮的错误类别（与 worker 熔断共用同一判据）。 */
export function shouldAbortStage(error: AppError): boolean {
  return isFatal(error);
}

/**
 * 增量合并：把已完成各段按顺序拼成一份可读总结，不做模型调用。
 *
 * 为什么增量时不做模型合并：合并是一次完整的大模型往返，若每完成一段就合并一次，
 * 总耗时反而更长。逐步产出阶段只做结构拼接（各段章节依次排列），
 * 等全部段完成后由 finalize 做一次真正的归并，把重复观点压掉。
 * 代价是阶段性快照里可能有跨段重复——UI 上以「后台整理中」明确标示。
 */
function mergeIncremental(ordered: SummaryPayload[]): SummaryPayload {
  const first = ordered[0];
  if (!first) throw appError('VALIDATION_FAILED', '没有可用的段落结果');
  if (ordered.length === 1) return first;
  return {
    opening: first.opening,
    sections: ordered.flatMap((payload) => payload.sections),
  };
}

/**
 * 构造可落库的总结记录。
 * finalize（完整总结）与 publishPartial（增量快照）共用，避免两处结构漂移。
 */
function buildSummaryRecord(
  job: JobRecord,
  provider: ReadyProvider,
  payload: SummaryPayload,
  coverage: SummaryRecord['coverage'],
  covered?: string[],
): SummaryRecord {
  const known = new Set<string>([...payload.opening.paragraphs, ...payload.opening.bullets].flatMap((b) => b.sourceCueIds));
  return {
    id: `sum-${job.videoId}-${Date.now().toString(36)}`,
    videoId: job.videoId,
    transcriptId: job.transcriptId,
    transcriptRevisionId: job.transcriptId,
    cacheKey: job.configFingerprint,
    language: provider.targetLanguage,
    payload,
    coveredCueIds: (covered ?? summaryCoveredCueIds(payload, known)).slice(0, 4000),
    coverage,
    providerSnapshot: {
      providerId: provider.providerId,
      providerName: provider.providerName,
      requestUrl: job.configSnapshot.requestUrl,
      modelId: provider.modelId,
    },
    promptVersion: PROMPT_VERSION,
    createdAt: new Date().toISOString(),
  };
}
