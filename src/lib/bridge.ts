/**
 * UI 与后台之间的类型安全封装。
 * 只暴露固定动作，不提供“取任意 URL”的能力。
 */
import type { TranscriptParseResult } from '../domain/transcript';
import type { AppError } from '../domain/errors';
import type { PlaybackAction } from './messages';
import type { AutoSummarySnapshot } from './auto-summary';
import {
  sendRuntimeMessage,
  type CapturedFrame,
  type RuntimeResponse,
  type TabContext,
  type TrackSummary,
  type VideoState,
} from './messages';

export type UiTabContext = TabContext;

export interface BridgeResult<T> {
  ok: boolean;
  data?: T;
  error?: AppError;
}

function toResult<T>(response: RuntimeResponse<T>): BridgeResult<T> {
  if (response.ok) return { ok: true, data: response.data };
  return { ok: false, error: response.error };
}

export async function captureVideo(tabId?: number): Promise<BridgeResult<UiTabContext>> {
  const response = await sendRuntimeMessage<UiTabContext>({ type: 'CAPTURE_VIDEO', payload: { tabId } });
  return toResult(response);
}

export async function readTabContext(): Promise<UiTabContext | null> {
  const response = await captureVideo();
  return response.ok && response.data ? response.data : null;
}

export async function listTracks(aid: string, cid: string): Promise<BridgeResult<TrackSummary[]>> {
  const response = await sendRuntimeMessage<TrackSummary[]>({ type: 'LIST_TRACKS', payload: { aid, cid } });
  return toResult(response);
}

export async function readSubtitle(url: string): Promise<BridgeResult<TranscriptParseResult>> {
  const response = await sendRuntimeMessage<TranscriptParseResult>({ type: 'READ_SUBTITLE', payload: { url } });
  return toResult(response);
}

export async function seekCurrentTab(positionMs: number): Promise<BridgeResult<null>> {
  const response = await sendRuntimeMessage<null>({ type: 'SEEK_VIDEO', payload: { positionMs } });
  return toResult(response);
}

/** 播放控制：视频原声播放/暂停、进度、倍速、音量。 */
export async function controlPlayback(action: PlaybackAction, value?: number | boolean): Promise<BridgeResult<null>> {
  const response = await sendRuntimeMessage<null>({ type: 'CONTROL_PLAYBACK', payload: { action, value } });
  return toResult(response);
}

export async function getVideoState(): Promise<BridgeResult<VideoState>> {
  const response = await sendRuntimeMessage<VideoState>({ type: 'GET_VIDEO_STATE', payload: {} });
  return toResult(response);
}

/** 截取当前视频画面（仅视频帧，不含弹幕与页面元素）。 */
export async function captureFrame(): Promise<BridgeResult<CapturedFrame>> {
  const response = await sendRuntimeMessage<CapturedFrame>({ type: 'CAPTURE_FRAME', payload: {} });
  return toResult(response);
}

export interface SummaryProgressInfo {
  jobId: string;
  videoId: string;
  stage: 'queued' | 'extracting' | 'merging' | 'completed' | 'partial' | 'failed' | 'cancelled';
  completed: number;
  total: number;
  failedChunks: number;
  updatedAt: string;
  message: string;
  errorCode?: string;
}

/** 在后台发起学习总结；立即返回，关掉弹窗也会继续跑。 */
export async function startSummary(videoId: string): Promise<BridgeResult<{ progress: SummaryProgressInfo; reused: boolean }>> {
  const response = await sendRuntimeMessage<{ progress: SummaryProgressInfo; reused: boolean }>({
    type: 'START_SUMMARY',
    payload: { videoId },
  });
  return toResult(response);
}

/** 查询后台总结进度；返回 null 表示当前没有未完成任务。 */
export async function summaryProgress(videoId: string): Promise<BridgeResult<SummaryProgressInfo | null>> {
  const response = await sendRuntimeMessage<SummaryProgressInfo | null>({
    type: 'SUMMARY_PROGRESS',
    payload: { videoId },
  });
  return toResult(response);
}

/** 读取已保存的总结；弹窗关闭后重新打开也走这里。 */
export async function readSummary(videoId: string): Promise<BridgeResult<SummaryRecordLike | null>> {
  const response = await sendRuntimeMessage<SummaryRecordLike | null>({ type: 'GET_SUMMARY', payload: { videoId } });
  return toResult(response);
}

export async function cancelSummary(videoId: string): Promise<BridgeResult<{ cancelled: boolean }>> {
  const response = await sendRuntimeMessage<{ cancelled: boolean }>({ type: 'CANCEL_SUMMARY', payload: { videoId } });
  return toResult(response);
}

/** 只取 UI 需要的字段，避免把整个存储结构耦合进桥接层。 */
export interface SummaryRecordLike {
  id: string;
  videoId: string;
  transcriptId: string;
  coverage: 'complete' | 'partial';
  createdAt: string;
}

export async function autoSummaryState(videoId: string): Promise<BridgeResult<AutoSummarySnapshot>> {
  return toResult(await sendRuntimeMessage<AutoSummarySnapshot>({ type: 'AUTO_SUMMARY_STATE', payload: { videoId } }));
}

export async function selectAutoTranscript(videoId: string, transcriptId: string): Promise<BridgeResult<null>> {
  return toResult(await sendRuntimeMessage<null>({ type: 'AUTO_SUMMARY_SELECT', payload: { videoId, transcriptId } }));
}

export async function controlAutoSummary(videoId: string, enabled: boolean, retryFailed = false): Promise<BridgeResult<null>> {
  return toResult(await sendRuntimeMessage<null>({ type: 'AUTO_SUMMARY_CONTROL', payload: { videoId, enabled, retryFailed } }));
}

/** 整段总结：先看要处理几段（不发请求）。 */
export async function previewFullSummary(videoId: string, transcriptId: string): Promise<BridgeResult<{
  cueCount: number;
  chunks: { index: number; total: number; cueCount: number; startMs: number; endMs: number }[];
}>> {
  return toResult(await sendRuntimeMessage({ type: 'FULL_SUMMARY_PREVIEW', payload: { videoId, transcriptId } }));
}

/** 整段总结：把当前字幕版本全部总结并追加进笔记。 */
export async function startFullSummary(
  videoId: string, transcriptId: string, appendToNote = true,
): Promise<BridgeResult<{ summaryId: string; noteUpdated: boolean }>> {
  return toResult(await sendRuntimeMessage({ type: 'FULL_SUMMARY_START', payload: { videoId, transcriptId, appendToNote } }));
}

export interface FullSummaryProgressInfo {
  videoId: string;
  phase: 'planning' | 'requesting' | 'saving' | 'done' | 'failed';
  done: number;
  total: number;
  message: string;
  error?: { code: string; message: string; detail?: string };
}

export async function fullSummaryProgress(videoId: string): Promise<BridgeResult<FullSummaryProgressInfo | null>> {
  return toResult(await sendRuntimeMessage({ type: 'FULL_SUMMARY_PROGRESS', payload: { videoId } }));
}

export interface AsrSegment {
  startMs: number;
  endMs: number;
  text: string;
}

export interface LocalAsrView {
  id: string;
  status: 'starting' | 'recording' | 'transcribing' | 'completed' | 'failed';
  model: string;
  recordedMs: number;
  completedChunks: number;
  queuedChunks: number;
  warnings: string[];
  error?: AppError;
  transcriptId?: string;
  /** 已完成分片的分段，用于边采集边显示字幕。 */
  segments?: AsrSegment[];
}

/** 开始本地转写（采集标签页音频 → 本机 Whisper）。不使用聊天 Key。 */
export async function startLocalTranscription(): Promise<BridgeResult<{ id: string; status: string }>> {
  return toResult(await sendRuntimeMessage<{ id: string; status: string }>({ type: 'TRANSCRIBE_AUDIO', payload: {} }));
}

/** 查询当前本地转写会话；完成后从 transcriptId 读取字幕版本。 */
export async function localTranscriptionState(): Promise<BridgeResult<LocalAsrView | null>> {
  return toResult(await sendRuntimeMessage<LocalAsrView | null>({ type: 'ASR_STATE', payload: {} }));
}

export async function stopLocalTranscription(): Promise<BridgeResult<null>> {
  return toResult(await sendRuntimeMessage<null>({ type: 'ASR_STOP', payload: {} }));
}

/** 确认已取得当前站点权限，并让后台注入通用页面脚本。 */
export async function ensurePageScript(): Promise<BridgeResult<null>> {
  return toResult(await sendRuntimeMessage<null>({ type: 'ENSURE_PAGE_SCRIPT', payload: {} }));
}

export interface PageTrackInfo {
  url: string;
  label: string;
  language: string;
  kind: string;
  hasParsedCues: boolean;
}

/** 列出页面自身的字幕轨道（通用层，不依赖站方接口）。 */
export async function listPageTracks(): Promise<BridgeResult<PageTrackInfo[]>> {
  return toResult(await sendRuntimeMessage<PageTrackInfo[]>({ type: 'LIST_PAGE_TRACKS', payload: {} }));
}

/** 读取某条页内字幕轨道的文本（已是 WebVTT，或站点原始字幕文件）。 */
export async function readPageTrack(url: string): Promise<BridgeResult<{ text: string }>> {
  return toResult(await sendRuntimeMessage<{ text: string }>({ type: 'READ_PAGE_TRACK', payload: { url } }));
}

export async function openExtensionPage(page: 'library' | 'options' | 'selfcheck', query = ''): Promise<void> {
  const url = chrome.runtime.getURL(`${page}.html${query ? `?${query}` : ''}`);
  await chrome.tabs.create({ url });
}
