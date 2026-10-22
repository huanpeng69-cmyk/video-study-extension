/**
 * 任务持久化与恢复（技术方案 6.1、6.2、PRD F11）。
 * 目标：关闭侧边栏或页面被丢弃后，重开能复用已完成段落，且不重复提交。
 *
 * 明确限制：本地去重只保证不重复写入结果；远端 POST 是否已计费无法确定。
 */
import { nowIso, putJob, getJob, listChunkResults, commitChunkResult, type getDb } from './db';
import type { ChunkPlan } from '../domain/chunking';
import type { ChunkState, JobConfigSnapshot, JobRecord } from './types';

export interface ReusableJob {
  job: JobRecord;
  /** 已提交的段落 key 与内容。 */
  completed: Map<string, unknown>;

  /** 只对尚未完成的段落发起请求。 */
  pendingPlan: ChunkPlan[];
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
  const now = nowIso();
  return {
    id: `job-${input.type}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
    type: input.type,
    videoId: input.videoId,
    transcriptId: input.transcriptId,
    inputHash: input.inputHash,
    configSnapshot: input.configSnapshot,
    chunkPlan: input.plans.map<ChunkState>((plan) => ({
      chunkKey: plan.chunkKey,
      attemptId: makeAttemptId(),
      status: 'pending',
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

/**
 * 查找可恢复的同配置任务：只有身份、输入哈希与配置指纹完全一致才算。
 * 复用旧任务可以避免把另一份字幕或另一模型的段落混进来。
 */
export async function findReusableJob(
  jobs: JobRecord[],
  input: { type: JobRecord['type']; videoId: string; transcriptId: string; inputHash: string; configFingerprint: string },
): Promise<ReusableJob | null> {
  const candidate = jobs.find(
    (job) =>
      job.type === input.type &&
      job.videoId === input.videoId &&
      job.transcriptId === input.transcriptId &&
      job.inputHash === input.inputHash &&
      job.configFingerprint === input.configFingerprint &&
      job.state !== 'cancelled',
  );
  if (!candidate) return null;
  const results = await listChunkResults(candidate.id);
  const completed = new Map<string, unknown>();
  for (const result of results) {
    if (result.status === 'done') completed.set(result.chunkKey, result.payload);
  }
  return { job: candidate, completed, pendingPlan: [] };
}

/** 标记任务为运行中，并刷新 attempt（新一轮尝试）。 */
export async function markJobRunning(job: JobRecord): Promise<JobRecord> {
  const next: JobRecord = {
    ...job,
    state: 'running',
    generation: job.generation + 1,
    chunkPlan: job.chunkPlan.map((chunk) =>
      chunk.status === 'done' ? chunk : { ...chunk, attemptId: makeAttemptId(), status: 'pending' },
    ),
    updatedAt: nowIso(),
  };
  await putJob(next);
  return next;
}

export async function markJobState(job: JobRecord, state: JobRecord['state']): Promise<void> {
  await putJob({ ...job, state, updatedAt: nowIso() });
}

/** 提交一段结果，校验 generation，防止迟到响应覆盖新尝试。 */
export async function commitChunk(
  job: JobRecord,
  chunkKey: string,
  payload: unknown,
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null },
): Promise<{ committed: boolean; reason?: string }> {
  const chunk = job.chunkPlan.find((item) => item.chunkKey === chunkKey);
  if (!chunk) return { committed: false, reason: '该段不在任务计划内' };
  return commitChunkResult({
    jobId: job.id,
    chunkKey,
    attemptId: chunk.attemptId,
    generation: job.generation,
    payload,
    usage,
  });
}

/**
 * 把已提交的段落按原计划顺序合并回完整结果。
 * 顺序以 chunkPlan 为准，避免依赖 IndexedDB 的返回顺序。
 */
export function assembleByPlan<T>(job: JobRecord, completed: Map<string, unknown>): T[] {
  const ordered: T[] = [];
  for (const chunk of job.chunkPlan) {
    if (chunk.status !== 'done') continue;
    const payload = completed.get(chunk.chunkKey);
    if (payload === undefined) continue;
    ordered.push(payload as T);
  }
  return ordered;
}

export async function loadJobById(jobId: string): Promise<JobRecord | undefined> {
  return getJob(jobId);
}
