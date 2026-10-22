/** 自动流式订阅只连接可信扩展页，不经 B站 DOM/postMessage 转发正文。 */
import type { AppError } from '../domain/errors';
import type { SummaryNodeRecord, SummaryRecord } from '../storage/types';

export const AUTO_SUMMARY_PORT = 'video-study-auto-summary-v1';
export type LiveSummaryNode = Pick<SummaryNodeRecord,
  'id' | 'transcriptId' | 'index' | 'startMs' | 'endMs' | 'status' | 'attemptId' | 'previewText' | 'error' | 'updatedAt'> & {
    /** 仅失败节点提供，供可信弹窗本机排障；不进入日志、成稿或导出。 */
    failureResponse?: { text: string; truncated: boolean };
  };

export interface AutoSummarySnapshot {
  videoId: string;
  transcriptId: string | null;
  enabled: boolean;
  playbackPaused: boolean;
  ended: boolean;
  completed: number;
  total: number;
  queued: number;
  failed: number;
  empty: number;
  message: string;
  error: AppError | null;
  draft: LiveSummaryNode | null;
  summary: SummaryRecord | null;
}

export type AutoSummaryEvent =
  | { type: 'changed'; videoId: string }
  | { type: 'delta'; videoId: string; node: LiveSummaryNode };

export function liveNode(node: SummaryNodeRecord): LiveSummaryNode {
  const { id, transcriptId, index, startMs, endMs, status, attemptId, previewText, error, updatedAt } = node;
  return { id, transcriptId, index, startMs, endMs, status, attemptId, previewText, error, updatedAt,
    ...(status === 'failed' && node.rawText ? {
      failureResponse: { text: node.rawText.slice(0, 8000), truncated: node.rawText.length > 8000 },
    } : {}),
  };
}
