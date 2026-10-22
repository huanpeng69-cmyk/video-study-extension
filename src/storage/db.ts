/**
 * IndexedDB 仓储（技术方案 7.1、7.3）。
 * 笔记与 AI 结果分表保存；手写笔记永不被 AI 结果覆盖。
 */
import Dexie, { type Table } from 'dexie';
import { appError, toAppError } from '../domain/errors';
import type { Cue } from '../domain/transcript';
import {
  DB_SCHEMA_VERSION,
  type ChunkResultRecord,
  type JobRecord,
  type NoteRecord,
  type StoredCue,
  type SummaryRecord,
  type TranscriptRevision,
  type TranslationRecord,
  type VideoRecord,
  type AutoSummarySession,
  type SummaryNodeRecord,
} from './types';

export class StudyDatabase extends Dexie {
  videos!: Table<VideoRecord, string>;
  transcripts!: Table<TranscriptRevision, string>;
  cues!: Table<StoredCue, string>;
  translations!: Table<TranslationRecord, string>;
  summaries!: Table<SummaryRecord, string>;
  notes!: Table<NoteRecord, string>;
  jobs!: Table<JobRecord, string>;
  chunkResults!: Table<ChunkResultRecord, string>;
  autoSummarySessions!: Table<AutoSummarySession, string>;
  summaryNodes!: Table<SummaryNodeRecord, string>;

  constructor(name = 'video-study-notes') {
    super(name);
    this.version(1).stores({
      videos: 'id, bvid, cid, updatedAt, *tags',
      transcripts: 'id, videoId, sourceHash, createdAt',
      cues: 'id, transcriptId, [transcriptId+cueId], startMs, sequence',
      translations: 'id, videoId, transcriptId, cacheKey, createdAt',
      summaries: 'id, videoId, transcriptId, cacheKey, createdAt',
      notes: 'id, videoId, updatedAt',
      jobs: 'id, videoId, transcriptId, state, updatedAt',
      chunkResults: 'id, jobId, [jobId+chunkKey], createdAt',
    });
    // 只增加表：原有字幕、总结、笔记与任务保持原样。
    this.version(DB_SCHEMA_VERSION).stores({
      autoSummarySessions: 'id, videoId, transcriptId, updatedAt',
      summaryNodes: 'id, videoId, transcriptId, [transcriptId+index], status, updatedAt',
    });
  }
}

let dbInstance: StudyDatabase | null = null;

export function getDb(): StudyDatabase {
  if (!dbInstance) dbInstance = new StudyDatabase();
  return dbInstance;
}

/** 测试注入：允许替换为 fake-indexeddb 支撑的实例。 */
export function setDbForTests(db: StudyDatabase | null): void {
  dbInstance = db;
}

function wrap<T>(operation: () => Promise<T>, message: string): Promise<T> {
  return operation().catch((cause) => {
    throw toAppError(cause, 'STORAGE_FAILED', message);
  });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export async function upsertVideo(record: VideoRecord): Promise<void> {
  await wrap(async () => {
    const existing = await getDb().videos.get(record.id);
    if (!existing) {
      await getDb().videos.put(record);
      return;
    }
    await getDb().videos.put({
      ...record,
      createdAt: existing.createdAt,
      tags: existing.tags.length > 0 ? existing.tags : record.tags,
      updatedAt: nowIso(),
    });
  }, '保存视频信息失败');
}

export async function getVideo(videoId: string): Promise<VideoRecord | undefined> {
  return wrap(() => getDb().videos.get(videoId), '读取视频信息失败');
}

export async function updateVideoTags(videoId: string, tags: string[]): Promise<void> {
  await wrap(async () => {
    const clean = Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean))).slice(0, 20);
    await getDb().videos.update(videoId, { tags: clean, updatedAt: nowIso() });
  }, '保存标签失败');
}

/**
 * 保存字幕版本：相同 sourceHash 复用已有 revision，内容变化则新建版本，
 * 不覆盖仍被笔记引用的旧版本。
 */
export async function saveTranscript(input: {
  videoId: string;
  language: string;
  sourceKind: TranscriptRevision['sourceKind'];
  generationKind: TranscriptRevision['generationKind'];
  trackLabel: string;
  sourceHash: string;
  cues: Cue[];
}): Promise<{ revision: TranscriptRevision; reused: boolean }> {
  return wrap(async () => {
    const existing = await getDb()
      .transcripts.where('videoId')
      .equals(input.videoId)
      .filter((row) => row.sourceHash === input.sourceHash && row.language === input.language)
      .first();
    if (existing) return { revision: existing, reused: true };

    const revision: TranscriptRevision = {
      id: `tr-${input.videoId}-${input.sourceHash}-${input.language}`,
      videoId: input.videoId,
      language: input.language,
      sourceKind: input.sourceKind,
      generationKind: input.generationKind,
      trackLabel: input.trackLabel.slice(0, 120),
      sourceHash: input.sourceHash,
      cueCount: input.cues.length,
      createdAt: nowIso(),
    };
    await getDb().transaction('rw', getDb().transcripts, getDb().cues, async () => {
      await getDb().transcripts.put(revision);
      // 表主键是 id：同一字幕版本内 cueId 唯一，跨版本需带 revision 前缀。
      const rows: StoredCue[] = input.cues.map((cue) => ({
        ...cue,
        id: `${revision.id}:${cue.cueId}`,
        transcriptId: revision.id,
      }));
      await getDb().cues.bulkPut(rows);
    });
    return { revision, reused: false };
  }, '保存字幕失败');
}


/**
 * 原地更新一个字幕版本的条目（用于「边采边显示」）。
 *
 * 为什么需要：采集过程中字幕会不断增长，但该版本 id 已被自动学习会话引用。
 * 若每片都新建版本，旧节点会绑在只含开头几条字幕的版本上，
 * 表现为「前面的节点有内容、后面的节点显示没有可用字幕」。
 * 这里保持 version id 与 createdAt 不变，只替换条目与计数。
 */
export async function replaceTranscriptCues(transcriptId: string, cues: Cue[]): Promise<TranscriptRevision> {
  return wrap(async () => {
    const revision = await getDb().transcripts.get(transcriptId);
    if (!revision) throw appError('NOT_FOUND', '字幕版本已不存在，无法追加条目');
    const rows: StoredCue[] = cues.map((cue) => ({ ...cue, id: `${transcriptId}:${cue.cueId}`, transcriptId }));
    await getDb().transaction('rw', getDb().transcripts, getDb().cues, async () => {
      await getDb().cues.where('transcriptId').equals(transcriptId).delete();
      await getDb().cues.bulkPut(rows);
      await getDb().transcripts.put({ ...revision, cueCount: cues.length });
    });
    return { ...revision, cueCount: cues.length };
  }, '更新字幕条目失败');
}
export async function listTranscripts(videoId: string): Promise<TranscriptRevision[]> {
  return wrap(
    () => getDb().transcripts.where('videoId').equals(videoId).reverse().sortBy('createdAt'),
    '读取字幕版本失败',
  );
}

export async function getCues(transcriptId: string): Promise<StoredCue[]> {
  return wrap(() => getDb().cues.where('transcriptId').equals(transcriptId).sortBy('sequence'), '读取字幕条目失败');
}

export async function saveNote(videoId: string, markdown: string, expectedRevision: number): Promise<NoteRecord> {
  return wrap(async () => {
    const existing = await getDb().notes.get(videoId);
    const currentRevision = existing?.revision ?? 0;
    if (existing && currentRevision !== expectedRevision) {
      throw appError('STORAGE_FAILED', '笔记已在其他窗口更新，已保留双方内容', {
        detail: `当前版本 ${currentRevision}，期望版本 ${expectedRevision}`,
      });
    }
    const record: NoteRecord = {
      id: videoId,
      videoId,
      markdown,
      revision: currentRevision + 1,
      updatedAt: nowIso(),
    };
    await getDb().notes.put(record);
    return record;
  }, '保存笔记失败');
}

export async function getNote(videoId: string): Promise<NoteRecord | undefined> {
  return wrap(() => getDb().notes.get(videoId), '读取笔记失败');
}

export async function saveTranslation(record: TranslationRecord): Promise<void> {
  await wrap(() => getDb().translations.put(record), '保存译文失败');
}

export async function findTranslation(cacheKey: string): Promise<TranslationRecord | undefined> {
  return wrap(() => getDb().translations.where('cacheKey').equals(cacheKey).first(), '读取译文失败');
}

export async function saveSummary(record: SummaryRecord): Promise<void> {
  await wrap(() => getDb().summaries.put(record), '保存总结失败');
}

export async function latestSummary(videoId: string): Promise<SummaryRecord | undefined> {
  return wrap(
    () => getDb().summaries.where('videoId').equals(videoId).reverse().sortBy('createdAt').then((rows) => rows[0]),
    '读取总结失败',
  );
}

export async function findSummaryByCacheKey(cacheKey: string): Promise<SummaryRecord | undefined> {
  return wrap(() => getDb().summaries.where('cacheKey').equals(cacheKey).first(), '读取总结失败');
}

export async function putJob(job: JobRecord): Promise<void> {
  await wrap(() => getDb().jobs.put(job), '保存任务失败');
}

export async function getJob(jobId: string): Promise<JobRecord | undefined> {
  return wrap(() => getDb().jobs.get(jobId), '读取任务失败');
}

export async function listJobs(videoId: string): Promise<JobRecord[]> {
  return wrap(() => getDb().jobs.where('videoId').equals(videoId).reverse().sortBy('updatedAt'), '读取任务失败');
}

export async function listInterruptedJobs(): Promise<JobRecord[]> {
  return wrap(
    () => getDb().jobs.filter((job) => job.state === 'running' || job.state === 'queued').toArray(),
    '读取未完成任务失败',
  );
}

/**
 * 结果与块状态在同一事务提交（技术方案 6.1）。
 * 后写校验 attemptId + generation，迟到结果不会覆盖已取消任务。
 */
export async function commitChunkResult(input: {
  jobId: string;
  chunkKey: string;
  attemptId: string;
  generation: number;
  payload: unknown;
  usage: ChunkResultRecord['usage'];
}): Promise<{ committed: boolean; reason?: string }> {
  return wrap(async () => {
    const db = getDb();
    return db.transaction('rw', db.jobs, db.chunkResults, async () => {
      const job = await db.jobs.get(input.jobId);
      if (!job) return { committed: false, reason: '任务不存在' };
      if (job.generation !== input.generation) return { committed: false, reason: '任务已被新一次尝试取代' };
      if (job.state === 'cancelled') return { committed: false, reason: '任务已取消' };
      const doneKey = `${input.jobId}:${input.chunkKey}`;
      const existing = await db.chunkResults.get(doneKey);
      if (existing && existing.status === 'done') return { committed: false, reason: '该段已完成' };
      await db.chunkResults.put({
        id: doneKey,
        jobId: input.jobId,
        chunkKey: input.chunkKey,
        attemptId: input.attemptId,
        status: 'done',
        payload: input.payload,
        usage: input.usage,
        errorCode: null,
        createdAt: nowIso(),
      });
      const chunkPlan = job.chunkPlan.map((chunk) =>
        chunk.chunkKey === input.chunkKey ? { ...chunk, status: 'done' as const, errorCode: null } : chunk,
      );
      await db.jobs.put({ ...job, chunkPlan, updatedAt: nowIso() });
      return { committed: true };
    });
  }, '保存任务进度失败');
}

export async function listChunkResults(jobId: string): Promise<ChunkResultRecord[]> {
  return wrap(() => getDb().chunkResults.where('jobId').equals(jobId).sortBy('createdAt'), '读取任务结果失败');
}

export async function deleteVideoCascade(videoId: string): Promise<void> {
  await wrap(async () => {
    const db = getDb();
    await db.transaction(
      'rw',
      [db.videos, db.transcripts, db.cues, db.translations, db.summaries, db.notes, db.jobs, db.chunkResults, db.autoSummarySessions, db.summaryNodes],
      async () => {
        const transcripts = await db.transcripts.where('videoId').equals(videoId).toArray();
        for (const transcript of transcripts) {
          await db.cues.where('transcriptId').equals(transcript.id).delete();
        }
        const jobs = await db.jobs.where('videoId').equals(videoId).toArray();
        for (const job of jobs) await db.chunkResults.where('jobId').equals(job.id).delete();
        await db.transcripts.where('videoId').equals(videoId).delete();
        await db.translations.where('videoId').equals(videoId).delete();
        await db.summaries.where('videoId').equals(videoId).delete();
        await db.jobs.where('videoId').equals(videoId).delete();
        await db.summaryNodes.where('videoId').equals(videoId).delete();
        await db.autoSummarySessions.delete(videoId);
        await db.notes.delete(videoId);
        await db.videos.delete(videoId);
      },
    );
  }, '删除资料失败');
}

export interface LibraryListItem {
  video: VideoRecord;
  hasNote: boolean;
  transcriptCount: number;
  /** 是否已有可用总结；列表只读元数据，不加载总结正文。 */
  hasSummary: boolean;
}
/** 资料库列表只读元数据，不加载字幕正文（技术方案 7.3）。 */
export async function listLibrary(query?: string): Promise<LibraryListItem[]> {
  return wrap(async () => {
    const db = getDb();
    const videos = await db.videos.orderBy('updatedAt').reverse().toArray();
    const keyword = query?.trim().toLowerCase();
    const items: LibraryListItem[] = [];
    for (const video of videos) {
      const [note, transcriptCount, summary] = await Promise.all([
        db.notes.get(video.id),
        db.transcripts.where('videoId').equals(video.id).count(),
        db.summaries.where('videoId').equals(video.id).first(),
      ]);
      if (keyword) {
        const haystack = [video.title, ...video.tags, note?.markdown ?? ''].join('\n').toLowerCase();
        if (!haystack.includes(keyword)) continue;
      }
      items.push({
        video,
        hasNote: Boolean(note && note.markdown.trim()),
        transcriptCount,
        hasSummary: Boolean(summary),
      });
    }
    return items;
  }, '读取资料库失败');
}

export async function countAll(): Promise<{ videos: number; notes: number }> {
  return wrap(async () => ({
    videos: await getDb().videos.count(),
    notes: await getDb().notes.count(),
  }), '统计存储失败');
}
