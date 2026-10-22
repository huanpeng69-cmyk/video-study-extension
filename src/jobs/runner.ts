/**
 * 分段任务执行器（技术方案 6.1、6.2）。
 * - AI 执行器在扩展学习页面运行，不依赖常驻 Service Worker
 * - 每块结果与状态在同一 IndexedDB 事务提交
 * - 取消后不再排新请求；迟到结果因 generation 校验被丢弃
 */
import { buildMergeMessages, buildSummaryMessages, buildTranslateMessages } from '../ai/prompts';
import { parseJsonPayload, requestChat } from '../ai/client';
import { validateSummary, validateTranslation, type SummaryPayload, type TranslationItem } from '../domain/aiResult';
import type { ChunkPlan } from '../domain/chunking';
import { appError, toAppError, type AppError } from '../domain/errors';
import type { Cue } from '../domain/transcript';
import type { ReadyProvider } from '../storage/settings';
import type { JobConfigSnapshot, JobRecord, JobState } from '../storage/types';

export interface RunSummaryTaskInput {
  videoId: string;
  transcriptId: string;
  title: string;
  provider: ReadyProvider;
  plans: ChunkPlan[];
  inputHash: string;
  configFingerprint: string;
  configSnapshot: JobConfigSnapshot;
  cacheKeyPrefix: string;
  /** 每块提交回调：必须完成持久化后才继续下一块。 */
  onCommit: (chunkKey: string, payload: SummaryPayload, usage: UsageInfo) => Promise<void>;
  onStateChange?: (state: JobState, completed: number, total: number) => void;
  signal?: AbortSignal;
}

export interface UsageInfo {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface RunOutcome {
  job: JobRecord;
  items: TranslationItem[];
  summaries: SummaryPayload[];
  usage: UsageInfo;
  failedChunks: number;
  /** 未收到响应、可能已在服务端计费的段数。 */
  unknownChunks: number;
}

function emptyUsage(): UsageInfo {
  return { promptTokens: null, completionTokens: null, totalTokens: null };
}

function addUsage(a: UsageInfo, b: UsageInfo): UsageInfo {
  const sum = (x: number | null, y: number | null): number | null =>
    x === null && y === null ? null : (x ?? 0) + (y ?? 0);
  return {
    promptTokens: sum(a.promptTokens, b.promptTokens),
    completionTokens: sum(a.completionTokens, b.completionTokens),
    totalTokens: sum(a.totalTokens, b.totalTokens),
  };
}

function makeAttemptId(): string {
  return `at-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildJobRecord(input: {
  type: 'translate' | 'summary';
  videoId: string;
  transcriptId: string;
  inputHash: string;
  configSnapshot: JobConfigSnapshot;
  configFingerprint: string;
  plans: ChunkPlan[];
  ownerId: string;
}): JobRecord {
  const now = new Date().toISOString();
  return {
    id: `job-${input.type}-${input.videoId}-${Date.now().toString(36)}`,
    type: input.type,
    videoId: input.videoId,
    transcriptId: input.transcriptId,
    inputHash: input.inputHash,
    configSnapshot: input.configSnapshot,
    chunkPlan: input.plans.map((plan) => ({
      chunkKey: plan.chunkKey,
      attemptId: makeAttemptId(),
      status: 'pending' as const,
      inputHash: `${plan.chunkKey}:${plan.charCount}`,
      errorCode: null,
    })),
    configFingerprint: input.configFingerprint,
    state: 'queued',
    generation: 1,
    ownerId: input.ownerId,
    createdAt: now,
    updatedAt: now,
  };
}

export interface SummaryRunOutcome extends RunOutcome {
  payloads: SummaryPayload[];
}

export interface TranslateRunOutcome extends RunOutcome {
  payloads: TranslationItem[][];
}

export interface RunTranslateTaskInput extends RunSummaryTaskInput {
  targetLanguage: string;
}

/** 翻译任务：每块必须完整对齐，否则该块失败。 */
export async function runTranslateTask(input: RunTranslateTaskInput): Promise<TranslateRunOutcome> {
  return runChunks<TranslationItem[]>(
    {
      ...input,
      jobType: 'translate',
      flatten: (payloads) => payloads.flat(),
    },
    async (plan) => {
      const result = await requestChat({
        baseUrl: input.provider.baseUrl,
        modelId: input.provider.modelId,
        apiKey: input.provider.apiKey,
        maxTokens: input.provider.maxTokens,
        temperature: 0.2,
        messages: buildTranslateMessages({ plan, targetLanguage: input.targetLanguage, title: input.title }),
        signal: input.signal,
      });
      const payload = parseJsonPayload(result.content);
      const validated = validateTranslation(payload, plan.cues.map((cue) => cue.cueId));
      if (!validated.ok) throw validated.error;
      return { payload: validated.items, usage: result.usage };
    },
  );
}

/** 总结任务：逐块抽取后合并；合并失败时保留各块结果并标记 partial。 */
export async function runSummaryTask(input: RunSummaryTaskInput): Promise<SummaryRunOutcome> {
  return runChunks<SummaryPayload>(
    { ...input, jobType: 'summary' },
    async (plan) => {
      const result = await requestChat({
        baseUrl: input.provider.baseUrl,
        modelId: input.provider.modelId,
        apiKey: input.provider.apiKey,
        maxTokens: input.provider.maxTokens,
        temperature: 0.2,
        messages: buildSummaryMessages({ plan, targetLanguage: input.provider.targetLanguage, title: input.title }),
        signal: input.signal,
      });
      const payload = parseJsonPayload(result.content);
      const validated = validateSummary(payload, { visibleCueIds: plan.cues.map((cue) => cue.cueId) });
      if (!validated.ok) throw validated.error;
      return { payload: validated.summary, usage: result.usage };
    },
  );
}

/** 把多块总结归并为全文总结（技术方案 5.4 Reduce 阶段）。 */
export async function mergeSummaries(
  provider: ReadyProvider,
  payloads: SummaryPayload[],
  visibleCueIds: string[],
  signal?: AbortSignal,
): Promise<{ summary: SummaryPayload; usage: UsageInfo }> {
  if (payloads.length === 1 && payloads[0]) {
    return { summary: payloads[0], usage: emptyUsage() };
  }
  const result = await requestChat({
    baseUrl: provider.baseUrl,
    modelId: provider.modelId,
    apiKey: provider.apiKey,
    maxTokens: provider.maxTokens,
    temperature: 0.2,
    messages: buildMergeMessages(
      payloads.map((payload) => JSON.stringify(payload)),
      provider.targetLanguage,
    ),
    signal,
  });
  const parsed = parseJsonPayload(result.content);
  const validated = validateSummary(parsed, { visibleCueIds });
  if (!validated.ok) throw validated.error;
  return { summary: validated.summary, usage: result.usage };
}

interface ChunkOutcome<T> {
  payload: T;
  usage: UsageInfo;
}

interface ChunkRunContext<T> extends RunSummaryTaskInput {
  jobType: 'translate' | 'summary';
  /** 翻译任务把各块结果展平为一条按原 Cue 顺序的列表。 */
  flatten?: (payloads: T[]) => TranslationItem[];
}

async function runChunks<T>(
  input: ChunkRunContext<T>,
  runOne: (plan: ChunkPlan) => Promise<ChunkOutcome<T>>,
): Promise<RunOutcome & { payloads: T[] }> {
  const state: JobState = 'running';
  input.onStateChange?.(state, 0, input.plans.length);
  const payloads: T[] = [];
  let failedChunks = 0;
  let unknownChunks = 0;
  let usage = emptyUsage();
  let lastError: AppError | null = null;

  for (let index = 0; index < input.plans.length; index += 1) {
    if (input.signal?.aborted) {
      input.onStateChange?.('cancelled', index, input.plans.length);
      break;
    }
    const plan = input.plans[index];
    if (!plan) continue;
    try {
      const outcome = await runOne(plan);
      await input.onCommit(plan.chunkKey, outcome.payload as never, outcome.usage);
      payloads.push(outcome.payload);
      usage = addUsage(usage, outcome.usage);
    } catch (cause) {
      const error = toAppError(cause, 'UNKNOWN', '该段生成失败');
      if (error.code === 'ABORTED') {
        input.onStateChange?.('cancelled', index, input.plans.length);
        break;
      }
      lastError = error;
      failedChunks += 1;
      // 超时/网络中断时服务端可能已处理：状态未知，不能声称未计费。
      if (error.code === 'TIMEOUT' || error.code === 'NETWORK_ERROR') unknownChunks += 1;
      // 鉴权/额度/权限问题继续下去只会重复失败，立即终止。
      if (['AUTH_FAILED', 'QUOTA_EXCEEDED', 'PERMISSION_DENIED', 'PROVIDER_NOT_CONFIGURED', 'NOT_FOUND'].includes(error.code)) {
        break;
      }
    }
    input.onStateChange?.('running', index + 1, input.plans.length);
  }

  const job = buildJobRecord({
    videoId: input.videoId,
    type: input.jobType,
    transcriptId: input.transcriptId,
    inputHash: input.inputHash,
    configSnapshot: input.configSnapshot,
    configFingerprint: input.configFingerprint,
    plans: input.plans,
    ownerId: 'local',
  });
  let finalState: JobState;
  if (input.signal?.aborted) finalState = 'cancelled';
  else if (failedChunks === 0 && payloads.length === input.plans.length) finalState = 'completed';
  else if (payloads.length > 0) finalState = 'partial';
  else finalState = 'failed';
  job.state = finalState;
  input.onStateChange?.(finalState, payloads.length, input.plans.length);

  if (payloads.length === 0 && lastError) {
    throw appError(lastError.code, lastError.message, { detail: lastError.detail, retryable: lastError.retryable });
  }
  return {
    job,
    items: input.flatten ? input.flatten(payloads) : [],
    summaries: input.jobType === 'summary' ? (payloads as unknown as SummaryPayload[]) : [],
    payloads,
    usage,
    failedChunks,
    unknownChunks,
  };
}

export function chunkCoveredCueIds(cues: Cue[], plans: ChunkPlan[]): string[] {
  const ids = new Set<string>();
  for (const plan of plans) for (const cue of plan.cues) ids.add(cue.cueId);
  return cues.filter((cue) => ids.has(cue.cueId)).map((cue) => cue.cueId);
}
