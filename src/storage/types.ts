/**
 * 数据模型（技术方案 7.2）。时间统一 ISO 8601 UTC，时间轴统一整数毫秒。
 */
import type { SummaryPayload, TranslationItem } from '../domain/aiResult';
import type { Cue, TranscriptGenerationKind, TranscriptSourceKind } from '../domain/transcript';
import type { AppError } from '../domain/errors';
import type { SummarySection } from '../domain/aiResult';
import type { VideoPlatform } from '../domain/video';

export interface VideoRecord {
  id: string;
  /** 通用站点为 'web'；'bilibili' 表示有额外适配器能力（分 P、站方字幕轨道）。 */
  platform: VideoPlatform;
  /** B站为 bvid；通用站点存 URL 推导的视频键，用于显示与去重。 */
  bvid: string;
  aid: string;
  cid: string;
  pageIndex: number;
  title: string;
  canonicalUrl: string;
  durationMs: number;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TranscriptRevision {
  id: string;
  videoId: string;
  language: string;
  sourceKind: TranscriptSourceKind;
  generationKind: TranscriptGenerationKind;
  trackLabel: string;
  sourceHash: string;
  cueCount: number;
  createdAt: string;
}

export interface StoredCue extends Cue {
  transcriptId: string;
}

export interface TranslationRecord {
  id: string;
  videoId: string;
  transcriptId: string;
  targetLanguage: string;
  cacheKey: string;
  items: TranslationItem[];
  status: 'complete' | 'partial';
  createdAt: string;
}

export interface SummaryRecord {
  id: string;
  videoId: string;
  transcriptId: string;
  transcriptRevisionId: string;
  language: string;
  cacheKey: string;
  payload: SummaryPayload;
  /** 处理覆盖的 cueId；partial 时明显不完整。 */
  coveredCueIds: string[];
  coverage: 'complete' | 'partial';
  providerSnapshot: ProviderSnapshot;
  promptVersion: string;
  createdAt: string;
  /** 自动流式节点聚合；旧批量总结没有此字段，仍可读取与导出。 */
  autoStream?: { intervalMs: number; completedNodes: number; totalNodes: number };
}

export interface NoteRecord {
  id: string;
  videoId: string;
  markdown: string;
  /** 乐观并发版本，避免后写无提示覆盖。 */
  revision: number;
  updatedAt: string;
}

export interface ProviderSnapshot {
  providerId: string;
  providerName: string;
  requestUrl: string;
  modelId: string;
}

export type JobState = 'queued' | 'running' | 'paused' | 'partial' | 'completed' | 'interrupted' | 'cancelled' | 'failed';

export interface JobConfigSnapshot extends ProviderSnapshot {
  baseUrl: string;
  targetLanguage: string;
  maxTokens: number | null;
}

export interface ChunkState {
  chunkKey: string;
  attemptId: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  inputHash: string;
  errorCode: string | null;
}

export interface JobRecord {
  id: string;
  type: 'translate' | 'summary';
  videoId: string;
  transcriptId: string;
  inputHash: string;
  /** 不含 Key 的配置快照：恢复任务时使用（技术方案 7.2）。 */
  configSnapshot: JobConfigSnapshot;
  chunkPlan: ChunkState[];
  configFingerprint: string;
  state: JobState;
  generation: number;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkResultRecord {
  id: string;
  jobId: string;
  chunkKey: string;
  attemptId: string;
  status: 'done' | 'failed';
  payload: unknown;
  usage: { promptTokens: number | null; completionTokens: number | null; totalTokens: number | null } | null;
  errorCode: string | null;
  createdAt: string;
}

/** 自动学习按视频保存选择与开关；不含 Key，也不依赖弹窗生命周期。 */
export interface AutoSummarySession {
  id: string;
  videoId: string;
  transcriptId: string;
  enabled: boolean;
  lastNode: number;
  durationMs: number;
  playbackPaused: boolean;
  ended: boolean;
  lastPositionMs: number;
  lastObservedAt: number;
  consecutiveFailures: number;
  error: AppError | null;
  createdAt: string;
  updatedAt: string;
}

export interface SummaryNodeRecord {
  id: string;
  videoId: string;
  transcriptId: string;
  index: number;
  startMs: number;
  endMs: number;
  status: 'queued' | 'streaming' | 'done' | 'empty' | 'failed';
  attempts: number;
  attemptId: string;
  /** 仅用于中断诊断与流式预览，不能当成正式总结或导出。 */
  rawText: string;
  previewText: string;
  result: SummarySection | null;
  providerSnapshot: ProviderSnapshot | null;
  language: string;
  error: AppError | null;
  createdAt: string;
  updatedAt: string;
}

export interface BackupEnvelope {
  schemaVersion: number;
  exportedAt: string;
  app: 'video-study-notes';
  videos: VideoRecord[];
  transcripts: TranscriptRevision[];
  cues: StoredCue[];
  translations: TranslationRecord[];
  summaries: SummaryRecord[];
  notes: NoteRecord[];
}

export const DB_SCHEMA_VERSION = 2;
export const BACKUP_SCHEMA_VERSION = 1;
