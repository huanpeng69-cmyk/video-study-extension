import { beforeEach, describe, expect, it, vi } from 'vitest';
import { appError } from '../src/domain/errors';
import type { Cue } from '../src/domain/transcript';
import { assembleFullSummary, planFullSummary, runFullSummary, MAX_FULL_SUMMARY_CHUNKS } from '../src/jobs/full-summary';
import { appendSummaryToNote } from '../src/jobs/full-summary-service';
import { buildAutoSummaryMessages } from '../src/ai/auto-summary';

const cue = (index: number, startMs: number, endMs: number, text = `字幕${index}`): Cue =>
  ({ cueId: `c${index}`, sequence: index, startMs, endMs, text, sourceIndex: index });

function makeCues(count: number, stepMs = 1000): Cue[] {
  return Array.from({ length: count }, (_, index) => cue(index, index * stepMs, (index + 1) * stepMs));
}

beforeEach(() => vi.restoreAllMocks());

describe('整段总结：字幕有多少就总结多少', () => {
  it('规划覆盖全部字幕，不丢条目', () => {
    const cues = makeCues(500);
    const plan = planFullSummary(cues);
    expect(plan.cueCount).toBe(500);
    expect(plan.chunks.length).toBeGreaterThan(1);
    // 每段首尾衔接，且总条数守恒。
    expect(plan.chunks.reduce((sum, chunk) => sum + chunk.cueCount, 0)).toBe(500);
    expect(plan.chunks[0]!.startMs).toBe(0);
    expect(plan.chunks.at(-1)!.endMs).toBe(cues.at(-1)!.endMs);
  });

  it('没有字幕时明确失败，不产出空总结', () => {
    expect(() => planFullSummary([])).toThrowError(/没有字幕/);
  });

  it('超出单次分段上限时拒绝，而不是只总结一部分', () => {
    // 每块 maxChars=8000，用超长单条字幕把分段数推高。
    const cues = Array.from({ length: MAX_FULL_SUMMARY_CHUNKS + 5 }, (_, index) =>
      cue(index, index * 60_000, (index + 1) * 60_000, '甲'.repeat(9000)));
    expect(() => planFullSummary(cues)).toThrowError(/超过单次上限/);
  });

  it('全部段落成功才合成，且覆盖记录来自真实引用', async () => {
    const cues = makeCues(3);
    const result = await runFullSummary(cues, {
      provider: { providerId: 'p', providerName: 'P', requestUrl: 'https://x.test/v1/chat/completions', modelId: 'm' },
      language: '简体中文',
      request: async ({ cues: chunkCues }) => JSON.stringify({
        title: '本段主题',
        paragraphs: chunkCues.map((item) => ({ text: item.text, sourceCueIds: [item.cueId] })),
        bullets: [],
      }),
    });
    expect(result.payload.opening.title).toContain('全片概览');
    expect(result.coveredCueIds.sort()).toEqual(['c0', 'c1', 'c2']);
  });

  it('某段引用越界时整体失败，不返回半份成稿', async () => {
    const cues = makeCues(3);
    await expect(runFullSummary(cues, {
      provider: { providerId: 'p', providerName: 'P', requestUrl: 'https://x.test/v1/chat/completions', modelId: 'm' },
      language: '简体中文',
      request: async () => JSON.stringify({
        title: '主题',
        paragraphs: [{ text: '正文', sourceCueIds: ['outside-id'] }],
        bullets: [],
      }),
    })).rejects.toThrowError(/超出本段字幕范围/);
  });

  it('某段缺少引用时指出是第几段，不静默补造', async () => {
    const cues = makeCues(3);
    await expect(runFullSummary(cues, {
      provider: { providerId: 'p', providerName: 'P', requestUrl: 'https://x.test/v1/chat/completions', modelId: 'm' },
      language: '简体中文',
      request: async () => JSON.stringify({
        title: '主题',
        paragraphs: [{ text: '缺少引用的正文' }],
        bullets: [],
      }),
    })).rejects.toThrowError(/第 1\/1 段未通过校验/);
  });

  it('请求失败时整体失败并保留原错误码', async () => {
    const cues = makeCues(2);
    await expect(runFullSummary(cues, {
      provider: { providerId: 'p', providerName: 'P', requestUrl: 'https://x.test/v1/chat/completions', modelId: 'm' },
      language: '简体中文',
      request: async () => { throw appError('AUTH_FAILED', '鉴权失败'); },
    })).rejects.toMatchObject({ code: 'AUTH_FAILED' });
  });

  it('合成时给每段加序号，正文与引用不动', () => {
    const payload = assembleFullSummary([
      { title: '一', paragraphs: [{ text: 'A', sourceCueIds: ['c0'] }], bullets: [] },
      { title: '二', paragraphs: [{ text: 'B', sourceCueIds: ['c1'] }], bullets: [] },
    ], 180);
    expect(payload.opening.title).toContain('全片概览');
    expect(payload.sections[0]!.title).toBe('第 2 段 · 二');
    expect(payload.sections[0]!.paragraphs[0]).toEqual({ text: 'B', sourceCueIds: ['c1'] });
  });
});

describe('笔记追加：不覆盖手写内容', () => {
  it('保留原文并在末尾追加总结', () => {
    const markdown = appendSummaryToNote('# 我的手写笔记\n\n要点 A', {
      opening: { title: '全片概览', paragraphs: [{ text: '总述', sourceCueIds: ['c0'] }], bullets: [] },
      sections: [{ title: '第 2 段 · 细节', paragraphs: [], bullets: [{ text: '条目', sourceCueIds: ['c1'] }] }],
    }, { model: 'm', createdAt: '2026-01-01T00:00:00.000Z' });
    expect(markdown).toContain('# 我的手写笔记');
    expect(markdown).toContain('要点 A');
    expect(markdown).toContain('## 整段总结（m · 2026-01-01T00:00:00.000Z）');
    expect(markdown).toContain('- 条目');
    expect(markdown.indexOf('要点 A')).toBeLessThan(markdown.indexOf('## 整段总结'));
  });

  it('空笔记也能生成小节，不需要占位内容', () => {
    const markdown = appendSummaryToNote('', {
      opening: { title: '概览', paragraphs: [{ text: '正文', sourceCueIds: ['c0'] }], bullets: [] },
      sections: [],
    }, { model: 'm', createdAt: 'now' });
    expect(markdown.startsWith('## 整段总结')).toBe(true);
    expect(markdown).toContain('正文');
  });
});

describe('提示词：把引用要求写成硬约束', () => {
  it('列出本段真实 cueId，并要求每个块都带引用', () => {
    const messages = buildAutoSummaryMessages({ cues: makeCues(2), title: '标题', targetLanguage: '简体中文' });
    const system = messages[0]!.content;
    expect(system).toContain('c0、c1');
    expect(system).toContain('必填字段');
    expect(system).toContain('不要把 sourceCueIds 提到 title 层级');
    expect(system).not.toContain('上一次输出未通过校验');
  });

  it('重写轮次会带上失败原因与可用 ID，但仍然不许编造', () => {
    const messages = buildAutoSummaryMessages({
      cues: makeCues(2), title: '标题', targetLanguage: '简体中文',
      retry: { reason: '节点结论缺少原字幕引用', cueIds: ['c0', 'c1'] },
    });
    const system = messages[0]!.content;
    expect(system).toContain('上一次输出未通过校验');
    expect(system).toContain('节点结论缺少原字幕引用');
    expect(system).toContain('不要编造 ID');
  });
});
