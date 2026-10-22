/**
 * 字幕跟随播放（纯函数，便于测试）。
 *
 * 参照 Tangentry `activeCue.ts` 的判定规则：多条字幕重叠时（滚动式或逐词式字幕
 * 常见），**取起点最晚的那条**，而不是第一条命中的。否则滚动字幕会一直停在旧行。
 *
 * 与截帧配合时再放宽一点（见 `cueAtCapture`）：截图通常发生在“刚说完那句话”之后，
 * 因此允许把**刚结束不久**的字幕算作当前字幕，但绝不允许取未来的字幕。
 */
import type { Cue } from '../domain/transcript';

/** 截图时容许“刚结束”的宽限：超过这个时长就认为已换段。 */
export const CAPTURE_CUE_GRACE_MS = 4_000;

/**
 * 当前正在显示的字幕。
 * 位置无效（NaN / 负数）返回 null，不猜测。
 */
export function activeCueAt(cues: readonly Cue[], positionMs: number | null | undefined): Cue | null {
  if (positionMs === null || positionMs === undefined) return null;
  if (!Number.isFinite(positionMs) || positionMs < 0) return null;
  let active: Cue | null = null;
  for (const cue of cues) {
    if (cue.startMs > positionMs) break; // 已按时间排序，后面都是未来字幕
    if (positionMs < cue.endMs && (!active || cue.startMs >= active.startMs)) active = cue;
  }
  return active;
}

/**
 * 截帧时的字幕：优先当前正在显示的，否则取刚结束不超过 `graceMs` 的那条。
 * 只回溯已开始的字幕，绝不提前使用未来字幕。
 */
export function cueAtCapture(
  cues: readonly Cue[],
  positionMs: number | null | undefined,
  graceMs = CAPTURE_CUE_GRACE_MS,
): Cue | null {
  const active = activeCueAt(cues, positionMs);
  if (active || positionMs === null || positionMs === undefined) return active;
  if (!Number.isFinite(positionMs) || positionMs < 0) return null;
  let recent: Cue | null = null;
  for (const cue of cues) {
    if (cue.startMs > positionMs) break;
    const gap = positionMs - cue.endMs;
    if (gap >= 0 && gap <= graceMs && (!recent || cue.startMs >= recent.startMs)) recent = cue;
  }
  return recent;
}

/** 摘录半径：在选中字幕前后各多带几条，让笔记保留上下文。 */
export type ExcerptRadius = 0 | 1 | 2;

/**
 * 取选中字幕（或定位到的那条）附近的一段。
 * 顺序与原文一致，且严格按 cues 的原始下标切片——搜索过滤后的可见顺序不影响它。
 */
export function cueExcerpt(
  cues: readonly Cue[],
  anchor: Cue | null,
  radius: ExcerptRadius = 1,
): Cue[] {
  if (!anchor) return [];
  const index = cues.findIndex((cue) => cue.cueId === anchor.cueId);
  if (index < 0) return [];
  const from = Math.max(0, index - radius);
  const to = Math.min(cues.length, index + radius + 1);
  return cues.slice(from, to);
}
