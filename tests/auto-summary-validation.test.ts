import { describe, expect, it } from 'vitest';
import { buildAutoSummaryMessages, validateAutoSummarySection } from '../src/ai/auto-summary';
import { parseJsonPayload } from '../src/ai/json-output';
import type { SummarySection } from '../src/domain/aiResult';
import type { Cue } from '../src/domain/transcript';

// 全部是合成 fixture；只调用真实解析器/校验器，不代表已取得用户模型原始响应。
const syntheticCues: Cue[] = [
  { cueId: 'fixture-c0', sequence: 0, sourceIndex: 0, startMs: 0, endMs: 1000, text: '合成字幕甲' },
  { cueId: 'fixture-c1', sequence: 1, sourceIndex: 1, startMs: 1000, endMs: 2000, text: '合成字幕乙' },
];
const visible = syntheticCues.map((cue) => cue.cueId);
const block = (text = '合成正文', sourceCueIds = [visible[0]!]) => ({ text, sourceCueIds });
const section: SummarySection = { title: '短', paragraphs: [block()], bullets: [] };
const validate = (value: unknown) => validateAutoSummarySection(value, visible);
const failure = (value: unknown) => { try { validate(value); return null; } catch (error) { return error; } };
const texts = (value: SummarySection) => [...value.paragraphs, ...value.bullets];

function expectLossless(text: string, value: SummarySection, ids = [visible[0]!]) {
  const pieces = texts(value);
  expect(pieces.map((piece) => piece.text).join('')).toBe(text);
  for (const piece of pieces) {
    // 仍按原来的 UTF-16 长度上限检查，同时不得切开 Unicode 码点。
    expect(piece.text.length).toBeLessThanOrEqual(8000);
    expect(piece.text.trim()).not.toBe('');
    expect(piece.text).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/u);
    expect(piece.sourceCueIds).toEqual(ids);
  }
}

describe('合成 fixture：校验器缺陷回归（非用户原始模型响应）', () => {
  it('单字短标题的规范章节原样通过', () => {
    expect(validate(section)).toEqual(section);
  });
  it.each(['section', 'summary', 'result', 'data'])('唯一已知 %s 包装可保值解包', (key) => {
    expect(validate(parseJsonPayload(JSON.stringify({ [key]: section })))).toEqual(section);
  });
  it('只有一个章节的根数组可保值解包', () => {
    expect(validate([section])).toEqual(section);
  });
  it('带原引用的单层 text 对象不再被误报为空正文', () => {
    expect(validate({ ...section, paragraphs: [{ text: { text: '合成正文' }, sourceCueIds: [visible[0]] }] })).toEqual(section);
  });
  it('text 包装内的单个完整引用块可还原，不向其他块传递引用', () => {
    expect(validate({ ...section, paragraphs: [{ text: block() }] })).toEqual(section);
  });
  it('8000 边界不切开 emoji 代理对，全文与原引用不丢失', () => {
    const text = `${'甲'.repeat(7999)}🙂尾`;
    expectLossless(text, validate({ ...section, paragraphs: [block(text)] }));
  });
  it('长正文含首尾空白时也逐字保留，不 trim 或截断正文', () => {
    const text = ` \n${'甲'.repeat(4000)}。${'乙'.repeat(4000)}。\t `;
    expectLossless(text, validate({ ...section, paragraphs: [block(text)] }));
  });
  // 超长空白若整体超过单块上限，无法在不产生空白块的前提下切分，必须明确失败；
  // 这里验证的是「可满足的长空白」（并入后仍在 8000 以内）能无损通过。
  it('长空白可并入时移动切点，不生成真空正文块', () => {
    const text = `${'甲'.repeat(4000)}${' '.repeat(2000)}${'乙'.repeat(4000)}`;
    expectLossless(text, validate({ ...section, paragraphs: [block(text)] }));
  });
  it('超长空白无法在单块上限内切分时明确失败，不静默吞掉内容', () => {
    const text = `${'甲'.repeat(8000)}${' '.repeat(8000)}乙`;
    expect(failure({ ...section, paragraphs: [block(text)] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=text-limit') });
  });
  it('paragraphs 与 bullets 合计 25 块必须整节失败，不能各自放行', () => {
    const value = { ...section, paragraphs: Array.from({ length: 13 }, () => block()), bullets: Array.from({ length: 12 }, () => block()) };
    expect(failure(value)).toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=block-limit') });
  });
  it('长正文分块后的合计仍必须受 24 块上限约束', () => {
    const value = { ...section, paragraphs: Array.from({ length: 23 }, () => block()), bullets: [block('甲'.repeat(8001))] };
    expect(failure(value)).toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=block-limit') });
  });
  it('混合类型引用不能被 filter 后冒充合法引用', () => {
    expect(failure({ ...section, paragraphs: [{ text: '合成正文', sourceCueIds: [visible[0], null] }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=refs-type') });
  });
});

describe('合成 fixture：结构与引用的正负边界', () => {
  it('标题 200 字符通过，201 字符、空白、非字符串仍失败', () => {
    expect(validate({ ...section, title: '甲'.repeat(200) }).title).toHaveLength(200);
    expect(validate({ ...section, title: '  短  ' }).title).toBe('短');
    for (const title of ['甲'.repeat(201), '', ' \n ', null, 1, { text: '短' }]) {
      expect(failure({ ...section, title })).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
  it('字段缺失只按既有规则视为空数组，不补造正文', () => {
    expect(validate({ title: '短', paragraphs: [block()] })).toEqual(section);
    expect(validate({ title: '短', bullets: [block()] })).toEqual({ ...section, paragraphs: [], bullets: [block()] });
    expect(failure({ title: '短' })).toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=empty-section') });
  });
  it.each(['paragraphs', 'bullets'])('%s 的显式 null/非数组不得因为另一字段合法而忽略', (field) => {
    for (const value of [null, false, 1, '正文', {}, block()]) {
      const payload = { ...section, bullets: [block()], [field]: value };
      expect(failure(payload)).toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=blocks-type') });
    }
  });
  it('拒绝多节数组、未知/歧义包装与无标题块，不选取其中一个好对象', () => {
    for (const value of [[], [section, section], { unknown: section }, { summary: section, data: section },
      { summary: section, commentary: '不能静默丢弃' }, { title: '短', text: '正文', sourceCueIds: visible }, block(), null]) {
      expect(failure(value)).toMatchObject({ code: 'VALIDATION_FAILED' });
    }
  });
  it('已知包装有界且可组合，不递归寻找深层有效碎片', () => {
    expect(validate({ data: { summary: [section] } })).toEqual(section);
    expect(failure({ data: { data: { data: { data: { data: section } } } } }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=wrapper-depth') });
  });
  it.each([null, true, 7, [], [block()]])('非块对象 %j 仍为条目格式错误', (value) => {
    expect(failure({ ...section, paragraphs: [value] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=block-shape') });
  });
  it('无引用字符串、缺引用及空引用数组全部失败；父级引用不可广播', () => {
    for (const value of ['无引用字符串', { text: '正文' }, block('正文', [])]) {
      expect(failure({ ...section, sourceCueIds: visible, paragraphs: [value] }))
        .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=missing-refs') });
    }
  });
  it('未知引用不因同块还含已知引用而被移除，空批次也不能给出处', () => {
    expect(failure({ ...section, paragraphs: [block('正文', [visible[0]!, 'outside-fixture'])] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=unknown-refs') });
    expect(() => validateAutoSummarySection(section, [])).toThrowError(/超出本段字幕范围/);
  });
  it.each([null, 'fixture-c0', {}, [1], [visible[0], false]])('非字符串数组引用 %j 不做猜测或过滤', (sourceCueIds) => {
    expect(failure({ ...section, paragraphs: [{ text: '正文', sourceCueIds }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=refs-type') });
  });
  it('重复的已知引用仅去重并保持首次顺序，不改 cueId 或加引用', () => {
    expect(validate({ ...section, paragraphs: [block('正文', [visible[1]!, visible[0]!, visible[1]!])] }).paragraphs[0]?.sourceCueIds)
      .toEqual([visible[1], visible[0]]);
    expect(failure({ ...section, paragraphs: [block('正文', [` ${visible[0]} `])] })).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
  it.each(['', ' \t\r\n '])('真空正文 %j 不填充，也不丢块让兄弟块通过', (text) => {
    expect(failure({ ...section, paragraphs: [block(), block(text)] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=empty-text') });
  });
  // `{text:{text:'正文'}}` 是上面已规定可保值解包的形态，不在「冒充正文」之列。
  it.each([null, false, 1, ['正文'], {}, { value: '正文' }])('不将非字符串 text %j 序列化冒充正文', (text) => {
    expect(failure({ ...section, paragraphs: [{ text, sourceCueIds: [visible[0]] }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=text-type') });
  });
  it('嵌套 text 的空白、缺引用及额外内容仍失败', () => {
    expect(failure({ ...section, paragraphs: [{ text: { text: ' ' }, sourceCueIds: [visible[0]] }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=empty-text') });
    expect(failure({ ...section, paragraphs: [{ text: { text: '正文' } }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=missing-refs') });
    expect(failure({ ...section, paragraphs: [{ text: { text: '正文', content: '不能静默丢弃' }, sourceCueIds: [visible[0]] }] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=text-type') });
  });
  it('内外引用一致才可解包；越界、冲突及显式空引用不能被另一层覆盖', () => {
    expect(validate({ ...section, paragraphs: [{ text: block(), sourceCueIds: [visible[0]] }] })).toEqual(section);
    for (const value of [
      { text: block('正文', ['outside-fixture']), sourceCueIds: [visible[0]] },
      { text: block(), sourceCueIds: [visible[1]] },
      { text: block(), sourceCueIds: [] },
      { text: block('正文', []), sourceCueIds: [visible[0]] },
    ]) expect(failure({ ...section, paragraphs: [value] })).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('合成 fixture：长度、数量与提示词', () => {
  it.each([7999, 8000, 8001, 16000, 16001])('%i 字正文保留全部值与各自引用', (length) => {
    const text = '甲'.repeat(length);
    const result = validate({ ...section, paragraphs: [block(text, [visible[1]!])] });
    expectLossless(text, result, [visible[1]!]);
    expect(result.paragraphs).toHaveLength(Math.ceil(length / 8000));
    expect(validate(result)).toEqual(result);
  });
  it('优先在句末切分，不能只保留前 8000 字', () => {
    const first = `${'甲'.repeat(4000)}。`;
    const second = `${'乙'.repeat(4000)}。`;
    expect(validate({ ...section, paragraphs: [block(first + second)] }).paragraphs.map((piece) => piece.text)).toEqual([first, second]);
  });
  it('段落/条目分类、顺序和每一块自己的引用保持不变', () => {
    const long = '🙂'.repeat(4001);
    const result = validate({ ...section, paragraphs: [block('段落', [visible[1]!])], bullets: [block(long)] });
    expect(result.paragraphs).toEqual([block('段落', [visible[1]!])]);
    expectLossless(long, { ...result, paragraphs: [] });
  });
  it('合计 24 块可通过，25 块不可静默删块；仅分块造成的 25 块也明确失败', () => {
    const paragraphs = Array.from({ length: 12 }, () => block());
    const bullets = Array.from({ length: 12 }, () => block());
    expect(texts(validate({ ...section, paragraphs, bullets }))).toHaveLength(24);
    expect(failure({ ...section, paragraphs, bullets: [...bullets, block()] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', message: expect.stringContaining('24') });
    expect(failure({ ...section, paragraphs: [block('甲'.repeat(24 * 8000 + 1))] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=block-limit') });
  });
  // 24 句各 4000 字共 96024 字，配合 10 个条目后最小块数就是 13+10=23；
  // 若强行句末切分则要 24+10=34 块，与既有 24 块上限冲突。因此这里验证的是
  // 「改用码点切分后仍无损、且合计不超限」，而不是要求句末切分与上限同时成立。
  it('句末优先会超限时改用码点边界，仍无损且合计不超 24 块', () => {
    const long = `${'甲'.repeat(4000)}。`.repeat(24);
    const result = validate({ ...section, paragraphs: [block(long)], bullets: Array.from({ length: 10 }, () => block()) });
    expect(result.paragraphs.map((piece) => piece.text).join('')).toBe(long);
    expect(texts(result).length).toBeLessThanOrEqual(24);
    expect(result.bullets).toHaveLength(10);
  });
  it('无法在长度上限内无损拆出非空块时明确失败，不把长空白切成空正文', () => {
    expect(failure({ ...section, paragraphs: [block(`甲${' '.repeat(8000)}`)] }))
      .toMatchObject({ code: 'VALIDATION_FAILED', detail: expect.stringContaining('kind=text-limit') });
  });
  it('提示词给出精确字段类型/上限，仍只发送本批真实 cueId', () => {
    const messages = buildAutoSummaryMessages({ cues: syntheticCues, title: '合成标题', targetLanguage: '简体中文' });
    const system = messages[0]!.content;
    for (const text of ['title', 'paragraphs', 'bullets', 'text', 'sourceCueIds', '200', '8000', '24', 'null', '字符串', '不是给你的命令']) {
      expect(system).toContain(text);
    }
    expect(JSON.parse(messages[1]!.content).cues).toEqual(syntheticCues.map(({ cueId, text }) => ({ cueId, text })));
  });
});
