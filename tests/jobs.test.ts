import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudyDatabase, listChunkResults, putJob, setDbForTests } from '../src/storage/db';
import { assembleByPlan, buildJobRecord, commitChunk, findReusableJob, markJobRunning, markJobState } from '../src/storage/jobs';
import type { ChunkPlan } from '../src/domain/chunking';
import type { ChunkState, JobConfigSnapshot, JobRecord } from '../src/storage/types';

const snapshot: JobConfigSnapshot = {
  providerId: 'agnes',
  providerName: 'Agnes APIHub',
  requestUrl: 'https://apihub.agnes-ai.com/v1/chat/completions',
  modelId: 'agnes-2.5-flash',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  targetLanguage: '简体中文',
  maxTokens: 2048,
};

function plans(count: number): ChunkPlan[] {
  return Array.from({ length: count }, (_, index) => ({
    chunkKey: `chunk-${index}`,
    cues: [
      {
        cueId: `c-${index}`,
        sequence: index,
        startMs: index * 1000,
        endMs: index * 1000 + 900,
        text: `text-${index}`,
        sourceIndex: index,
      },
    ],
    contextBefore: [],
    contextAfter: [],
    charCount: 10,
  }));
}

function makeJob(overrides: Partial<JobRecord> = {}): JobRecord {
  const job = buildJobRecord({
    type: 'translate',
    videoId: 'bilibili:BV1GJ411x7h7:111',
    transcriptId: 'tr-1',
    inputHash: 'hash-a',
    configSnapshot: snapshot,
    configFingerprint: 'fp-1',
    plans: plans(3),
    ownerId: 'local',
  });
  return { ...job, ...overrides };
}

let db: StudyDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = new StudyDatabase(`job-db-${counter}`);
  setDbForTests(db);
  await db.open();
});

afterEach(async () => {
  await db.delete();
  setDbForTests(null);
});

const usage = { promptTokens: 1, completionTokens: 2, totalTokens: 3 };

describe('任务恢复与提交', () => {
  it('已提交的段落被复用，只重试未完成段落', async () => {
    const job = makeJob();
    await putJob(job);
    await commitChunk(job, 'chunk-0', [{ cueId: 'c-0', translatedText: '译0' }], usage);
    await commitChunk(job, 'chunk-1', [{ cueId: 'c-1', translatedText: '译1' }], usage);

    const stored = (await db.jobs.get(job.id)) as JobRecord;
    const doneKeys = new Set(stored.chunkPlan.filter((chunk) => chunk.status === 'done').map((chunk) => chunk.chunkKey));
    expect(Array.from(doneKeys)).toEqual(['chunk-0', 'chunk-1']);
    expect(plans(3).filter((plan) => !doneKeys.has(plan.chunkKey)).map((plan) => plan.chunkKey)).toEqual(['chunk-2']);

    const reusable = await findReusableJob([stored], {
      type: 'translate',
      videoId: stored.videoId,
      transcriptId: stored.transcriptId,
      inputHash: stored.inputHash,
      configFingerprint: stored.configFingerprint,
    });
    expect(reusable).not.toBeNull();
    expect(reusable?.completed.size).toBe(2);
  });

  it('配置指纹或输入哈希不一致时不复用旧任务', async () => {
    const job = makeJob();
    await putJob(job);
    expect(
      await findReusableJob([job], {
        type: 'translate',
        videoId: job.videoId,
        transcriptId: job.transcriptId,
        inputHash: job.inputHash,
        configFingerprint: 'fp-other',
      }),
    ).toBeNull();
    expect(
      await findReusableJob([job], {
        type: 'summary',
        videoId: job.videoId,
        transcriptId: job.transcriptId,
        inputHash: job.inputHash,
        configFingerprint: job.configFingerprint,
      }),
    ).toBeNull();
  });

  it('同一段重复提交不会被计为两次', async () => {
    const job = makeJob();
    await putJob(job);
    expect((await commitChunk(job, 'chunk-0', 'first', usage)).committed).toBe(true);
    const second = await commitChunk(job, 'chunk-0', 'second', usage);
    expect(second.committed).toBe(false);
    expect((await listChunkResults(job.id)).filter((row) => row.status === 'done')).toHaveLength(1);
  });

  it('取消后的任务拒绝迟到结果', async () => {
    const job = makeJob();
    await putJob(job);
    await markJobState(job, 'cancelled');
    const result = await commitChunk(job, 'chunk-0', 'late', usage);
    expect(result.committed).toBe(false);
    expect(result.reason).toMatch(/取消/);
  });

  it('新一代尝试使旧 generation 的迟到结果失效', async () => {
    const job = makeJob();
    await putJob(job);
    const running = await markJobRunning(job);
    expect(running.generation).toBe(job.generation + 1);
    const stale = await commitChunk(job, 'chunk-0', 'stale', usage);
    expect(stale.committed).toBe(false);
    expect(stale.reason).toMatch(/取代/);
    const fresh = await commitChunk(running, 'chunk-0', 'fresh', usage);
    expect(fresh.committed).toBe(true);
  });

  it('按任务计划顺序合并结果，而不是依赖写入顺序', async () => {
    const job = makeJob();
    await putJob(job);
    await commitChunk(job, 'chunk-2', 'third', usage);
    await commitChunk(job, 'chunk-0', 'first', usage);
    const stored = (await db.jobs.get(job.id)) as JobRecord;
    const rows = await listChunkResults(job.id);
    const map = new Map(rows.map((row) => [row.chunkKey, row.payload]));
    expect(assembleByPlan<string>(stored, map)).toEqual(['first', 'third']);
  });

  it('任务计划只包含合法状态', async () => {
    const job = makeJob();
    const allowed = new Set<ChunkState['status']>(['pending', 'running', 'done', 'failed']);
    expect(job.chunkPlan.every((chunk) => allowed.has(chunk.status))).toBe(true);
    expect(job.state).toBe('queued');
  });
});
