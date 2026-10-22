import { afterEach, describe, expect, it, vi } from 'vitest';
import { extractJsonText, parseJsonPayload } from '../src/ai/client';
import { summaryStreamPreview, validateAutoSummarySection } from '../src/ai/auto-summary';

const section = { title: '测试主题', paragraphs: [{ text: '测试正文', sourceCueIds: ['c0'] }], bullets: [] };
const json = JSON.stringify(section);
const failure = (raw: string) => { try { parseJsonPayload(raw); return null; } catch (error) { return error; } };
afterEach(() => vi.restoreAllMocks());

describe('模型 JSON 正文解析', () => {
  it('合法对象和翻译数组保持不变', () => {
    expect(parseJsonPayload(json)).toEqual(section);
    expect(parseJsonPayload('[{"cueId":"c0","translatedText":"hello"}]')).toEqual([{ cueId: 'c0', translatedText: 'hello' }]);
  });
  it('说明文字的方括号不能破坏后面的完整 JSON', () => {
    expect(parseJsonPayload(`[说明]\n\n\`\`\`json\n${json}\n\`\`\``)).toEqual(section);
  });
  it('说明文字的花括号不能被拼到 JSON 结尾', () => {
    expect(parseJsonPayload(`本段结果：\n${json}\n附注：{仅供核对}`)).toEqual(section);
  });
  it('完整代码块、BOM 与行尾说明均可识别', () => {
    expect(parseJsonPayload(`\uFEFF\`\`\`JSON\r\n${json}\r\n\`\`\`\n请核对引用。`)).toEqual(section);
    expect(JSON.parse(extractJsonText(`这里是结果：${json}`))).toEqual(section);
  });
  it('字符串里的括号、转义引号与反斜杠不参与边界匹配', () => {
    const payload = { ...section, title: '括号 } ][ { 与 "引号"', paragraphs: [{ text: 'C:\\work\\a.txt，标记 ,} 与 ,]', sourceCueIds: ['c0'] }] };
    expect(parseJsonPayload(`结果\n${JSON.stringify(payload)}\n说明 {结束}`)).toEqual(payload);
  });
  it('仅去掉真正的尾逗号，所有正文与 cueId 原样保留', () => {
    const raw = '{"title":"测试主题","paragraphs":[{"text":"测试正文","sourceCueIds":["c0",],},],"bullets":[],}';
    expect(parseJsonPayload(raw)).toEqual(section);
  });
  it('字符串内的原始换行/制表符只作等价转义', () => {
    const raw = '{"title":"测试主题","paragraphs":[{"text":"第一行\n第二行\r\n第三行\t内容","sourceCueIds":["c0"]}],"bullets":[]}';
    expect(parseJsonPayload(raw)).toEqual({ ...section, paragraphs: [{ text: '第一行\n第二行\r\n第三行\t内容', sourceCueIds: ['c0'] }] });
  });
  it('整体被再次 JSON 编码的结果只解包一层', () => {
    expect(parseJsonPayload(JSON.stringify(json))).toEqual(section);
  });
  it('显式思考区中的 JSON 不冒充最终正文', () => {
    expect(parseJsonPayload(`<think>{"title":"思考中的样例"}</think>\n${json}`)).toEqual(section);
    expect(summaryStreamPreview('<think>{"text":"隐藏思考"}')).toBe('');
    expect(summaryStreamPreview(`<think>{"text":"隐藏思考"}</think>${json}`)).toBe('测试主题\n\n测试正文');
  });
  it('正文包含思考标签字样时不删除原文', () => {
    const value = { ...section, title: '代码字符串 <think> 不等于推理区' };
    expect(parseJsonPayload(JSON.stringify(value))).toEqual(value);
  });
  it('纯 Markdown 应明确指出未按 JSON 输出，不能补造引用', () => {
    expect(failure('# 学习要点\n- 测试文本')).toMatchObject({ code: 'BAD_RESPONSE', detail: expect.stringContaining('kind=non-json') });
  });
  it.each(['{"title":"半句', '{"title":"t","paragraphs":[{"text":"已完块","sourceCueIds":["c0"]}]', '[{"cueId":"c0","translatedText":"已完成一条"}'])('未闭合 JSON 不从内部截取完整子对象冒充成功', (raw) => {
    expect(failure(raw)).toMatchObject({ code: 'BAD_RESPONSE', detail: expect.stringContaining('kind=incomplete') });
  });
  it('多个完整 JSON 结果拒绝歧义，不随意挑第一个或最后一个', () => {
    expect(failure(`${json}\n${json}`)).toMatchObject({ code: 'BAD_RESPONSE', detail: expect.stringContaining('kind=multiple') });
  });
  it('损坏的结构不能被后面一个好对象掩盖', () => {
    expect(failure(`{"text":oops}\n${json}`)).toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it.each(['[,]', '[1,,]', '{"a":,}', '{"a":1,,}', "{'title':'不能猜单引号'}", '{"title":"坏"引号"}'])('不修补缺失值、单引号或有歧义的引号：%s', (raw) => {
    expect(failure(raw)).toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('兼容格式后仍拒绝任何越界引用', () => {
    const value = parseJsonPayload('{"title":"主题","paragraphs":[{"text":"正文","sourceCueIds":["c0","outside",],},],"bullets":[],}');
    expect(() => validateAutoSummarySection(value, ['c0'])).toThrowError();
  });
  it('错误与日志只带元数据，不包含原始返回或敏感文本', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(console, 'log').mockImplementation(() => {});
    const sensitive = 'private-fixture-content-do-not-log';
    const error = failure(`{"text":"${sensitive}","bad":oops}`);
    expect(JSON.stringify(error)).not.toContain(sensitive);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(sensitive);
    expect(JSON.stringify(info.mock.calls)).not.toContain(sensitive);
  });
  it('超大正文有界拒绝', () => {
    expect(failure('x'.repeat(2 * 1024 * 1024 + 1))).toMatchObject({ code: 'TOO_LARGE' });
  });
});

it.each(['{', '['])('只有结构开头 %s 时也明确归类为未闭合', (raw) => {
  expect(failure(raw)).toMatchObject({ code: 'BAD_RESPONSE', detail: expect.stringContaining('kind=incomplete') });
});

describe('模型格式偏差的保真归一化', () => {
  const visible = ['c0', 'c1'];
  it('纯字符串条目仍要求引用：不补造出处', () => {
    expect(() => validateAutoSummarySection({ title: 't', paragraphs: ['一句没有引用的话'], bullets: [] }, visible))
      .toThrowError(/缺少原字幕引用/);
  });
  it('超长正文按句切分，文字与引用原样保留', () => {
    const long = `${'甲'.repeat(4000)}。${'乙'.repeat(4000)}。`;
    const result = validateAutoSummarySection(
      { title: 't', paragraphs: [{ text: long, sourceCueIds: ['c0'] }], bullets: [] },
      visible,
    );
    expect(result.paragraphs.length).toBeGreaterThan(1);
    expect(result.paragraphs.map((b) => b.text).join('')).toBe(long);
    expect(result.paragraphs.every((b) => b.sourceCueIds.join() === 'c0')).toBe(true);
  });
  it('条目数上限提高后，多条目仍可保留', () => {
    const blocks = Array.from({ length: 20 }, (_, i) => ({ text: `第${i}条`, sourceCueIds: ['c0'] }));
    const result = validateAutoSummarySection({ title: 't', paragraphs: blocks, bullets: [] }, visible);
    expect(result.paragraphs).toHaveLength(20);
  });
  it('空正文与越界引用仍失败', () => {
    expect(() => validateAutoSummarySection({ title: 't', paragraphs: [{ text: '  ', sourceCueIds: ['c0'] }], bullets: [] }, visible))
      .toThrowError(/空正文/);
    expect(() => validateAutoSummarySection({ title: 't', paragraphs: [{ text: 'x', sourceCueIds: ['nope'] }], bullets: [] }, visible))
      .toThrowError(/超出本段字幕范围/);
  });
});

describe('中文模型在结构位写全角标点（kind=syntax 的真实成因）', () => {
  it('结构位的全角逗号与冒号按等价 ASCII 解析，正文一字不改', () => {
    const payload = { title: '测试主题', paragraphs: [{ text: '第一点，第二点：结论', sourceCueIds: ['c0'] }], bullets: [] };
    // 只把字符串外的 , 与 : 换成全角，其余字符与正文保持一致。
    const raw = JSON.stringify(payload).replace(/":"/g, '"："').replace(/","/g, '"，"').replace(/":\[/g, '"：[')
      .replace(/\],"/g, ']，"').replace(/"},{"/g, '"},{"');
    const wide = raw.replace(/,/g, '，').replace(/:(?!\/\/)/g, '：');
    expect(parseJsonPayload(wide)).toEqual(payload);
  });
  it('正文内原有的全角标点不被替换或删除', () => {
    const text = '逗号，冒号：句号。分号；括号（）都要保留';
    const payload = { title: text, paragraphs: [{ text, sourceCueIds: ['c0'] }], bullets: [] };
    expect(parseJsonPayload(JSON.stringify(payload))).toEqual(payload);
    expect(parseJsonPayload(`{"title":"${text}","paragraphs":[{"text":"${text}","sourceCueIds":["c0"]}],"bullets":[]}`))
      .toEqual(payload);
  });
  it.each([
    ['单引号仍属歧义', "{'title':'标题'}"],
    ['缺值仍是缺值', '{"title":，"paragraphs":[]}'],
    ['全角花括号仍不是 JSON', '｛"title":"标题"｝'],
    ['缺少开括号仍需失败', '"title":"标题"}'],
  ])('%s：%s', (_label, raw) => {
    expect(failure(raw)).toMatchObject({ code: 'BAD_RESPONSE' });
  });
  it('全角标点修复后仍执行严格引用校验，不因格式兼容放过坏引用', () => {
    const value = parseJsonPayload('{"title"："主题"，"paragraphs"：[{"text"："正文"，"sourceCueIds"：["c0"]}]，\"bullets\"：[]}');
    expect(() => validateAutoSummarySection(value, ['c0'])).not.toThrow();
    expect(() => validateAutoSummarySection(value, [])).toThrowError(/超出本段字幕范围/);
  });
});

describe('全角引号的结构位归一化', () => {
  it('把全角引号当作字符串定界符，等价归一为半角', () => {
    const raw = '{“title”:“测试主题”,“paragraphs”:[{“text”:“测试正文”,“sourceCueIds”:[“c0”]}],“bullets”:[]}';
    expect(parseJsonPayload(raw)).toEqual(section);
  });

  it('全角逗号/冒号与全角引号混合仍能解析，且尾逗号同样被清理', () => {
    const raw = '{“title”：“测试主题”，“paragraphs”：[{“text”：“第一点，第二点”，“sourceCueIds”：[“c0”，]}]，“bullets”：[]}';
    expect(parseJsonPayload(raw)).toEqual({
      title: '测试主题',
      paragraphs: [{ text: '第一点，第二点', sourceCueIds: ['c0'] }],
      bullets: [],
    });
  });

  it('字符串内的全角引号是内容，一字不改', () => {
    const value = { ...section, title: '他说“你好”，我答“好”' };
    const raw = JSON.stringify(value);
    expect(parseJsonPayload(raw)).toEqual(value);
  });

  it('全角引号内仍支持转义与控制符等价修正', () => {
    const raw = '{“title”:“测试主题”,“paragraphs”:[{“text”:“第一行\\n第二行”,“sourceCueIds”:[“c0”]}],“bullets”:[]}';
    expect(parseJsonPayload(raw)).toEqual({ ...section, paragraphs: [{ text: '第一行\n第二行', sourceCueIds: ['c0'] }] });
  });
});

describe('结构位非 ASCII 空白（kind=syntax 的另一种真实成因）', () => {
  // JSON.parse 只认 空格/\t/\n/\r；中文模型常在「：」后带上全角或零宽空白。
  it.each([
    ['全角空格 U+3000', 0x3000],
    ['不换行空格 U+00A0', 0x00a0],
    ['零宽空格 U+200B', 0x200b],
    ['窄空格 U+202F', 0x202f],
    ['中间 BOM U+FEFF', 0xfeff],
  ])('%s 出现在结构位时按半角空格等价解析', (_label, codePoint) => {
    const space = String.fromCharCode(codePoint);
    // 用拼接而非模板字面量：避免转义序列在编辑/换行时被写成字面反斜杠。
    const raw = '{' + space + '"title"' + space + ':' + space + '"测试主题"' + space + ',' +
      space + '"paragraphs"' + space + ':' + space + '[{' + space + '"text"' + space + ':' + space +
      '"测试正文"' + space + ',' + space + '"sourceCueIds"' + space + ':' + space + '["c0"]' + space + '}]' +
      space + ',' + space + '"bullets"' + space + ':' + space + '[]' + space + '}';
    expect(parseJsonPayload(raw)).toEqual(section);
  });

  it('字符串内部的同类空白是正文内容，一字不改', () => {
    const text = '甲' + String.fromCharCode(0x3000) + '乙' + String.fromCharCode(0x00a0) + '丙' + String.fromCharCode(0x200b) + '丁';
    const payload = { ...section, paragraphs: [{ text, sourceCueIds: ['c0'] }] };
    expect(parseJsonPayload(JSON.stringify(payload))).toEqual(payload);
  });
  it('替换空白不会把非法结构修成合法', () => {
    // 缺值仍然是缺值：只换空白不等于补值。
    const s = String.fromCharCode(0x3000);
    expect(failure('{' + s + '"title"' + s + ':' + s + ',' + s + '"paragraphs"' + s + ':' + s + '[]}'))
      .toMatchObject({ code: 'BAD_RESPONSE' });
  });
});
