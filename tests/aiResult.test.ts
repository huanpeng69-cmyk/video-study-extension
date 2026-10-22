import { describe, expect, it } from 'vitest';
import { resolveCitedRange, validateSummary, validateTranslation } from '../src/domain/aiResult';
import type { Cue } from '../src/domain/transcript';

const cue = (id: string, start: number, end: number): Cue => ({
  cueId: id,
  sequence: 0,
  startMs: start,
  endMs: end,
  text: `text-${id}`,
  sourceIndex: 0,
});

describe('译文校验', () => {
  it('要求每个目标 ID 恰好出现一次，并按原顺序重排', () => {
    const result = validateTranslation(
      [
        { cueId: 'b', translatedText: 'B' },
        { cueId: 'a', translatedText: 'A' },
      ],
      ['a', 'b'],
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.items.map((item) => item.cueId)).toEqual(['a', 'b']);
  });

  it('拒绝缺失、未知、重复与空文本', () => {
    expect(validateTranslation([{ cueId: 'a', translatedText: 'A' }], ['a', 'b']).ok).toBe(false);
    expect(validateTranslation([{ cueId: 'x', translatedText: 'X' }], ['a']).ok).toBe(false);
    expect(
      validateTranslation(
        [
          { cueId: 'a', translatedText: 'A' },
          { cueId: 'a', translatedText: 'A2' },
        ],
        ['a'],
      ).ok,
    ).toBe(false);
    expect(validateTranslation([{ cueId: 'a', translatedText: '   ' }], ['a']).ok).toBe(false);
    expect(validateTranslation('not-array', ['a']).ok).toBe(false);
  });
});

describe('全视频总结结构校验', () => {
  // 结构参照目标示例：编号章节 + 章节内正文段落与列表条目。
  const base = {
    opening: {
      title: '先建立一个核心认知',
      paragraphs: [{ text: '进度计划首先是企业的行为。', sourceCueIds: ['a'] }],
      bullets: [],
    },
    sections: [
      {
        title: '进度计划概述',
        paragraphs: [{ text: '本质是一份时间与逻辑计划。', sourceCueIds: ['a', 'b'] }],
        bullets: [{ text: '合同效力', sourceCueIds: ['b'] }],
      },
    ],
  };

  it('引用来自本批可见输入时通过', () => {
    const result = validateSummary(base, { visibleCueIds: ['a', 'b'] });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.opening.title).toBe('先建立一个核心认知');
      expect(result.summary.sections).toHaveLength(1);
      expect(result.summary.sections[0]?.bullets).toHaveLength(1);
    }
  });

  it('开篇引用未知 ID 时整批失败，不允许删引用凑通过', () => {
    const result = validateSummary(
      { ...base, opening: { title: '开篇', paragraphs: [{ text: 'x', sourceCueIds: ['z'] }], bullets: [] } },
      { visibleCueIds: ['a', 'b'] },
    );
    expect(result.ok).toBe(false);
  });

  it('未知引用被计入丢弃数，条目失去全部引用则不展示', () => {
    const result = validateSummary(
      {
        ...base,
        sections: [
          {
            title: '混合',
            paragraphs: [{ text: '无依据', sourceCueIds: ['z'] }],
            bullets: [{ text: '有效条目', sourceCueIds: ['a'] }],
          },
        ],
      },
      { visibleCueIds: ['a', 'b'] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.summary.sections[0]?.paragraphs).toHaveLength(0);
      expect(result.summary.sections[0]?.bullets).toHaveLength(1);
      expect(result.droppedRefs).toBeGreaterThan(0);
    }
  });

  it('段落与条目都必须有引用：无引用的块一律丢弃', () => {
    const result = validateSummary(
      {
        opening: { title: '开篇', paragraphs: [{ text: '只有正文', sourceCueIds: ['a'] }], bullets: [] },
        sections: [
          { title: '空的', paragraphs: [{ text: '无引用', sourceCueIds: [] }], bullets: [] },
          { title: '有效的', paragraphs: [], bullets: [{ text: '有引用', sourceCueIds: ['b'] }] },
        ],
      },
      { visibleCueIds: ['a', 'b'] },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // 无引用的章节被丢弃，只保留「有效的」。
      expect(result.summary.sections).toHaveLength(1);
      expect(result.summary.sections[0]?.title).toBe('有效的');
    }
  });

  it('没有有效章节时失败，避免产出空壳总结', () => {
    const result = validateSummary(
      { opening: base.opening, sections: [{ title: '空章节', paragraphs: [], bullets: [] }] },
      { visibleCueIds: ['a'] },
    );
    expect(result.ok).toBe(false);
  });

  it('由引用 ID 计算起止时间，不采用模型时间', () => {
    const index = new Map([
      ['a', cue('a', 1000, 2000)],
      ['b', cue('b', 5000, 6000)],
    ]);
    expect(resolveCitedRange(['b', 'a'], index)).toEqual({ startMs: 1000, endMs: 6000 });
    expect(resolveCitedRange(['unknown'], index)).toBeNull();
  });
});
