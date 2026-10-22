import { describe, expect, it } from 'vitest';
import { activeCueAt, cueAtCapture, cueExcerpt, CAPTURE_CUE_GRACE_MS } from '../src/ui/followCue';
import type { Cue } from '../src/domain/transcript';

const cue = (cueId: string, startMs: number, endMs: number, text = cueId): Cue => ({
  cueId, sequence: 0, sourceIndex: 0, startMs, endMs, text,
});

const cues: Cue[] = [
  cue('c0', 0, 2_000),
  cue('c1', 2_000, 4_000),
  cue('c2', 4_000, 6_000),
];

describe('跟随播放：当前字幕判定', () => {
  it('按播放位置取命中的那一条', () => {
    expect(activeCueAt(cues, 0)?.cueId).toBe('c0');
    expect(activeCueAt(cues, 2_500)?.cueId).toBe('c1');
    expect(activeCueAt(cues, 5_999)?.cueId).toBe('c2');
  });

  it('边界属于后一条（start 包含、end 不包含），不会两段同时高亮', () => {
    expect(activeCueAt(cues, 2_000)?.cueId).toBe('c1');
    expect(activeCueAt(cues, 4_000)?.cueId).toBe('c2');
    expect(activeCueAt(cues, 6_000)).toBeNull();
  });

  it('重叠的滚动字幕取起点最晚的一条（借鉴 Tangentry 的规则）', () => {
    const rolling: Cue[] = [cue('old', 0, 8_000), cue('new', 5_000, 9_000)];
    expect(activeCueAt(rolling, 6_000)?.cueId).toBe('new');
    expect(activeCueAt(rolling, 4_000)?.cueId).toBe('old');
  });

  it('无效位置返回 null，不猜', () => {
    for (const bad of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      expect(activeCueAt(cues, bad)).toBeNull();
    }
  });

  it('空字幕或位置在空隙里返回 null', () => {
    expect(activeCueAt([], 1_000)).toBeNull();
    expect(activeCueAt([cue('a', 0, 1_000), cue('b', 3_000, 4_000)], 2_000)).toBeNull();
  });
});

describe('截帧取字幕：优先当前，其次刚结束', () => {
  it('正在显示时直接取当前那条', () => {
    expect(cueAtCapture(cues, 3_000)?.cueId).toBe('c1');
  });

  it('刚结束不久（宽限内）仍算这一句，符合“先听到再说要截”的直觉', () => {
    expect(cueAtCapture(cues, 5_000)?.cueId).toBe('c2');
    expect(cueAtCapture(cues, 6_000 + CAPTURE_CUE_GRACE_MS)?.cueId).toBe('c2');
  });

  it('超过宽限就不再附字幕，而不是附上一条旧字幕', () => {
    expect(cueAtCapture(cues, 6_000 + CAPTURE_CUE_GRACE_MS + 1)).toBeNull();
  });

  it('绝不提前使用未来字幕', () => {
    // 位置 1_900 时 c1 尚未开始，应仍然只有 c0。
    expect(cueAtCapture(cues, 1_900)?.cueId).toBe('c0');
    expect(cueAtCapture([cue('future', 5_000, 6_000)], 1_000)).toBeNull();
  });
});

describe('摘录半径', () => {
  it('半径 0 只取本身，1/2 按原文顺序扩展', () => {
    const anchor = cues[1]!;
    expect(cueExcerpt(cues, anchor, 0).map((item) => item.cueId)).toEqual(['c1']);
    expect(cueExcerpt(cues, anchor, 1).map((item) => item.cueId)).toEqual(['c0', 'c1', 'c2']);
    expect(cueExcerpt(cues, cues[0]!, 2).map((item) => item.cueId)).toEqual(['c0', 'c1', 'c2']);
  });

  it('边界不越界，找不到锚点返回空', () => {
    expect(cueExcerpt(cues, cues[2]!, 2).map((item) => item.cueId)).toEqual(['c0', 'c1', 'c2']);
    expect(cueExcerpt(cues, null)).toEqual([]);
    expect(cueExcerpt(cues, cue('ghost', 0, 1))).toEqual([]);
  });
});
