/** 30 秒播放节点。事实来源是 IndexedDB；本模块不保存易丢失的内存水位。 */
export const AUTO_NODE_INTERVAL_MS = 30_000;
export const AUTO_NODE_VERSION = 'auto-p1';

export interface NodeRange {
  startMs: number;
  endMs: number;
}

/** 到达 30 秒时节点 0 才就绪；0 秒不能抢跑 0–30 秒。 */
export function nodeIndexFor(positionMs: number): number {
  if (!Number.isFinite(positionMs) || positionMs < AUTO_NODE_INTERVAL_MS) return -1;
  return Math.floor(positionMs / AUTO_NODE_INTERVAL_MS) - 1;
}

export function nodeRange(index: number, durationMs = Number.POSITIVE_INFINITY): NodeRange {
  if (!Number.isInteger(index) || index < 0) throw new RangeError('节点序号无效');
  return {
    startMs: index * AUTO_NODE_INTERVAL_MS,
    endMs: Math.min((index + 1) * AUTO_NODE_INTERVAL_MS, durationMs),
  };
}

export interface TriggerDecision {
  fire: boolean;
  index: number;
  reason: 'paused' | 'already-fired' | 'not-started' | 'reached' | 'ended' | 'invalid-progress';
}

/**
 * 只处理最新到达的完整区间，前跳不补跑大量未观看内容，后退不重复计费。
 * 播放自然结束时处理不足 30 秒的尾段（ended 不是普通 pause）。
 */
export function decideTrigger(input: {
  positionMs: number;
  durationMs: number;
  paused: boolean;
  ended?: boolean;
  lastNode: number;
}): TriggerDecision {
  if (!Number.isFinite(input.positionMs) || !Number.isFinite(input.durationMs) || input.positionMs < 0 || input.durationMs <= 0) {
    return { fire: false, index: -1, reason: 'invalid-progress' };
  }
  const position = Math.min(input.positionMs, input.durationMs);
  const ended = input.ended === true && position >= input.durationMs - 250;
  if (input.paused && !ended) return { fire: false, index: -1, reason: 'paused' };
  const index = ended ? Math.ceil(input.durationMs / AUTO_NODE_INTERVAL_MS) - 1 : nodeIndexFor(position);
  if (index < 0) return { fire: false, index, reason: 'not-started' };
  if (index <= input.lastNode) return { fire: false, index, reason: 'already-fired' };
  return { fire: true, index, reason: ended ? 'ended' : 'reached' };
}

export function summaryNodeId(transcriptId: string, index: number): string {
  return `${transcriptId}:${AUTO_NODE_VERSION}:${index}`;
}
