import { describe, expect, it } from 'vitest';
import { planChunks } from '../src/domain/chunking';
import type { Cue } from '../src/domain/transcript';

function makeCues(count: number, length = 10): Cue[] {
  return Array.from({ length: count }, (_, index) => ({
    cueId: `c-${index}`,
    sequence: index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: 'x'.repeat(length),
    sourceIndex: index,
  }));
}

describe('分段规划', () => {
  it('按 Cue 数量分批且不丢条目', () => {
    const cues = makeCues(150);
    const plans = planChunks(cues, { maxCues: 60, maxChars: 100_000 });
    expect(plans).toHaveLength(3);
    expect(plans.flatMap((plan) => plan.cues)).toHaveLength(150);
    expect(plans.every((plan) => plan.charCount <= 100_000)).toBe(true);
    expect(new Set(plans.map((plan) => plan.chunkKey)).size).toBe(3);
  });

  it('按字符预算分批', () => {
    const cues = makeCues(30, 100);
    const plans = planChunks(cues, { maxCues: 1000, maxChars: 350 });
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) {
      // 单个 Cue 本身可以超出预算，但成批时不应明显超过。
      expect(plan.cues.length === 1 || plan.charCount <= 350).toBe(true);
    }
  });

  it('为相邻块提供上下文且不把上下文算入待翻译内容', () => {
    const cues = makeCues(120);
    const plans = planChunks(cues, { maxCues: 60, maxChars: 100_000 });
    expect(plans[0]?.contextBefore).toHaveLength(0);
    expect(plans[0]?.contextAfter).toHaveLength(2);
    expect(plans[1]?.contextBefore).toHaveLength(3);
    expect(plans[1]?.cues).toHaveLength(60);
  });

  it('空输入返回空计划', () => {
    expect(planChunks([])).toEqual([]);
  });
});
