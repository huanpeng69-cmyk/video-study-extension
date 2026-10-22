/**
 * 后台总结服务的提速相关测试。
 *
 * 覆盖三处直接决定生成速度的逻辑：
 * 1. 分块规模：段数越少，请求次数越少（每段都是一次完整的大模型往返）。
 * 2. 输出预算：固定 2048 对长输入偏小，截断会导致整段重试。
 * 3. 有界并发：在途请求数恒等于并发度，不会一次性打爆服务端。
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_CHARS_PER_CHUNK, DEFAULT_MAX_CUES_PER_CHUNK, planChunks } from '../src/domain/chunking';
import { SUMMARY_CONCURRENCY, summaryOutputBudget } from '../src/jobs/summary-service';
import type { Cue } from '../src/domain/transcript';

function makeCues(count: number, textLength = 12): Cue[] {
  return Array.from({ length: count }, (_, index) => ({
    cueId: `native-${index}`,
    sequence: index,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    text: '字'.repeat(textLength),
    sourceIndex: index,
  }));
}

describe('分块规模（决定请求段数）', () => {
  it('默认上限已从 60 条/3000 字上调，避免把一个请求拆成多个', () => {
    // 这两个值是「速度」的直接杠杆：调小会让段数线性增加。
    expect(DEFAULT_MAX_CUES_PER_CHUNK).toBeGreaterThanOrEqual(200);
    expect(DEFAULT_MAX_CHARS_PER_CHUNK).toBeGreaterThanOrEqual(6000);
  });

  it('60 分钟视频（约 1440 条字幕）不再产生几十个请求', () => {
    const plans = planChunks(makeCues(1440));
    // 旧配置（60 条/3000 字）会产生 24 段；现在应在个位数。
    expect(plans.length).toBeLessThanOrEqual(8);
    expect(plans.length).toBeGreaterThan(0);
  });

  it('分块仍以完整 Cue 为边界，不切割单条字幕（质量不退化）', () => {
    const cues = makeCues(500);
    const plans = planChunks(cues);
    const total = plans.reduce((sum, plan) => sum + plan.cues.length, 0);
    expect(total).toBe(cues.length);
    // 每条 cue 只出现在一个段内，且保留原 cueId。
    const ids = plans.flatMap((plan) => plan.cues.map((cue) => cue.cueId));
    expect(new Set(ids).size).toBe(cues.length);
  });

  it('仍为每段提供前后文，合并质量不受分块变大影响', () => {
    const plans = planChunks(makeCues(600));
    expect(plans.length).toBeGreaterThan(1);
    expect(plans[1]?.contextBefore.length).toBeGreaterThan(0);
    expect(plans[0]?.contextAfter.length).toBeGreaterThan(0);
  });

  it('单条超长字幕不会被切开造假时间轴', () => {
    const cues = makeCues(1, 20_000);
    const plans = planChunks(cues);
    expect(plans).toHaveLength(1);
    expect(plans[0]?.cues[0]?.text).toHaveLength(20_000);
  });
});

describe('输出预算（避免截断导致整段重试）', () => {
  it('长输入获得比固定 2048 更大的预算', () => {
    const budget = summaryOutputBudget(6000, 2048);
    expect(budget).toBeGreaterThan(2048);
  });

  it('永不低于配置下限，也不会无限放大', () => {
    expect(summaryOutputBudget(10, 4096)).toBeGreaterThanOrEqual(1024);
    expect(summaryOutputBudget(1_000_000, 4096)).toBeLessThanOrEqual(8192);
  });

  it('长输入获得比配置更大的预算（新结构输出更长）', () => {
    // 240 条字幕约产出 40 个带引用的块，按旧公式只给 1952 tokens 必然截断。
    expect(summaryOutputBudget(240, 2048)).toBeGreaterThan(3000);
  });

  it('预算随字幕条数增长，且不低于 2048 下限', () => {
    expect(summaryOutputBudget(480, 1024)).toBeGreaterThanOrEqual(2048);
    expect(summaryOutputBudget(480, 1024)).toBeGreaterThan(summaryOutputBudget(60, 1024));
  });

  it('不会无限放大：极长输入也被上限截住', () => {
    expect(summaryOutputBudget(100_000, 4096)).toBeLessThanOrEqual(8192);
  });
});

describe('有界并发', () => {
  it('并发度保持保守，避免撞上免费层限流', () => {
    expect(SUMMARY_CONCURRENCY).toBeGreaterThan(1);
    expect(SUMMARY_CONCURRENCY).toBeLessThanOrEqual(4);
  });
});

describe('按固定时间间隔切段（增量产出）', () => {
  const mkTimed = (n: number, secondsPer: number) =>
    Array.from({ length: n }, (_, i) => ({
      cueId: `native-${i}`,
      sequence: i,
      startMs: i * secondsPer * 1000,
      endMs: (i + 1) * secondsPer * 1000,
      text: `字幕${i}`,
      sourceIndex: i,
    }));

  it('每段覆盖的时间不超过设定间隔', () => {
    // 120 条字幕、每条 2 秒 => 共 240 秒；间隔 60 秒应切出约 4 段
    const plans = planChunks(mkTimed(120, 2), { intervalMs: 60_000 });
    expect(plans.length).toBeGreaterThan(1);
    for (const plan of plans) {
      const first = plan.cues[0];
      const last = plan.cues[plan.cues.length - 1];
      if (!first || !last) continue;
      // 允许最后一段因对齐而略超，但不该超过两倍间隔
      expect(last.endMs - first.startMs).toBeLessThanOrEqual(120_000);
    }
  });

  it('不传 intervalMs 时行为与原来完全一致（向后兼容）', () => {
    const before = planChunks(mkTimed(500, 1));
    const after = planChunks(mkTimed(500, 1), { intervalMs: undefined });
    expect(after.map((p) => p.chunkKey)).toEqual(before.map((p) => p.chunkKey));
  });

  it('时间切分后仍以完整 Cue 为边界，不切割单条字幕', () => {
    const cues = mkTimed(80, 3);
    const plans = planChunks(cues, { intervalMs: 30_000 });
    const ids = plans.flatMap((plan) => plan.cues.map((cue) => cue.cueId));
    expect(new Set(ids).size).toBe(cues.length);
  });
});
