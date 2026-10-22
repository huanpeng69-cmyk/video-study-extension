/**
 * 模型正文不是 HTTP/SSE 外层 JSON。只做可证明不改值的格式兼容，
 * 不补闭合括号/缺失字段/引用，不从未完成的根对象里捞子对象充当结果。
 */
import { appError } from '../domain/errors';
import { vsLog } from '../lib/log';

const MAX_JSON_CHARS = 2 * 1024 * 1024;
const MAX_CANDIDATES = 32;
type FailureKind = 'non-json' | 'incomplete' | 'syntax' | 'multiple' | 'too-large';
/**
 * 结构位需要归一为半角空格的「非 JSON 空白」。
 *
 * JSON 只认 空格 / \t / \n / \r 四种空白；其余空白字符会让 JSON.parse 直接失败。
 * 这里显式列出而不是用 \s：U+200B（零宽空格）与 U+FEFF（BOM）在 JS 正则里
 * 不属于 \s，漏掉它们就会出现「看起来是空白、却仍报语法错误」。
 */
const NON_JSON_SPACE = /[\u00a0\u1680\u2000-\u200b\u2028\u2029\u202f\u205f\u3000\ufeff]/;
interface Decoded { value: unknown; text: string; trailingCommas: number; controlChars: number; widePunctuation: number; wideSpaces: number }

/** 只去掉开头显式标记的思考区，不删除正文字符串中的标签字样。 */
export function withoutLeadingReasoning(raw: string): { body: string; pending: boolean; removed: boolean } {
  let body = raw.trimStart();
  let removed = false;
  for (let count = 0; count < 8; count += 1) {
    const opening = /^<(think|analysis|reasoning)>/i.exec(body);
    if (!opening) return { body, pending: false, removed };
    const end = new RegExp(`</${opening[1]}>`, 'i').exec(body.slice(opening[0].length));
    if (!end) return { body: '', pending: true, removed: true };
    body = body.slice(opening[0].length + end.index + end[0].length).trimStart();
    removed = true;
  }
  return { body: '', pending: true, removed: true };
}

function fail(kind: FailureKind, chars: number, candidates: number): never {
  const messages: Record<FailureKind, string> = {
    'non-json': '模型返回了非 JSON 正文，未按要求输出结构化内容',
    incomplete: '模型正文中的 JSON 未闭合或引号转义不完整，未作为正式内容保存',
    syntax: '模型正文中的 JSON 语法有误，不能安全转换为正式内容',
    multiple: '模型返回了多个 JSON 结果，无法确定唯一内容',
    'too-large': '模型 JSON 正文超过解析安全上限',
  };
  // 不记录 JSON.parse 原始报错：某些引擎会在错误消息中带正文片段。
  vsLog.warn('json-output:invalid', { kind, chars, candidates });
  throw appError(kind === 'too-large' ? 'TOO_LARGE' : 'BAD_RESPONSE', messages[kind], {
    detail: `phase=model-json; kind=${kind}; chars=${chars}; candidates=${candidates}`,
  });
}

/**
 * 尾逗号、字符串内控制符，以及**结构位上的全角标点**的等价修正。
 *
 * 中文模型常把 `,` `:` 写成 `，` `：`，也常把字符串定界符 `"` 写成 `“ ”`。
 * 这些字符只在字符串之外做等价替换：
 * - 字符串内部一律原样保留（正文里的「第一点，第二点」「他说“你好”」不能被改）；
 * - 全角引号 `“` `”` 在结构位等价于半角 `"`，可确定性地成对归一；
 * - 单引号、缺值、缺括号仍有歧义，绝不修补。
 */
function normalizeSyntax(text: string): { text: string; trailingCommas: number; controlChars: number; widePunctuation: number; wideSpaces: number } {
  const out: string[] = [];
  let quoted = false;
  let escaped = false;
  let previous = '';
  let trailingCommas = 0;
  let controlChars = 0;
  let widePunctuation = 0;
  let wideSpaces = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (quoted) {
      if (escaped) { out.push(char); escaped = false; continue; }
      if (char === '\\') { escaped = true; out.push(char); continue; }
      // 半角/全角闭引号都结束字符串；字符串内的全角开引号「“」是内容，原样保留。
      if (char === '"' || char === '”') { quoted = false; previous = '"'; out.push('"'); continue; }
      if (char.charCodeAt(0) < 0x20) {
        out.push(JSON.stringify(char).slice(1, -1)); controlChars += 1;
      } else out.push(char);
      continue;
    }
    // 结构位的全角引号等价于半角引号，并作为字符串定界符进入字符串状态。
    if (char === '“' || char === '”') {
      widePunctuation += 1;
      quoted = true;
      previous = '"';
      out.push('"');
      continue;
    }
    if (char === '"') quoted = true;
    // 结构位的全角冒号：字符串外等价于 :，正文内容不受影响。
    if (char === '：') {
      widePunctuation += 1;
      out.push(':');
      previous = ':';
      continue;
    }
    // 结构位的逗号（半角/全角）：字符串外等价于 ,，并同样识别尾逗号。
    if (char === ',' || char === '，') {
      if (char === '，') widePunctuation += 1;
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      // [,] / [1,,] / {"a":,} 是缺值，不得删除逗号将其伪装为有效结果。
      if ((text[next] === '}' || text[next] === ']') && previous && !'[{,:'.includes(previous)) {
        trailingCommas += 1;
        continue;
      }
      out.push(',');
      previous = ',';
      continue;
    }
    /*
     * 结构位的非 JSON 空白（全角空格 U+3000、不换行空格 U+00A0、零宽空格 U+200B、
     * 中间 BOM U+FEFF、窄空格 U+202F，以及 \v \f 等）：JSON.parse 只认
     * 空格 / \t / \n / \r 四种空白，中文模型常在 `：` 后面带上它们。
     *
     * 为什么可以替换为半角空格：空白在 token 之间没有语义，换成同样的「分隔」
     * 不改变任何键名或正文取值；字符串内部的空白属于内容，一律不动。
     */
    /*
     * 结构位的非 JSON 空白（全角空格 U+3000、不换行空格 U+00A0、零宽空格 U+200B、
     * 中间 BOM U+FEFF、窄空格 U+202F 等）：JSON.parse 只认 空格 / \t / \n / \r，
     * 中文模型常在「：」后面带上它们。
     *
     * 注意 U+200B / U+FEFF 在 JS 正则里不是 \s，必须显式列出，
     * 否则「看起来有空白」实则匹配不到，仍会判成 JSON 语法错误。
     *
     * 为什么可以替换为半角空格：空白在 token 之间没有语义，换成同样的分隔
     * 不改变任何键名或正文取值；字符串内部的空白属于内容，一律不动。
     */
    if (NON_JSON_SPACE.test(char)) {
      wideSpaces += 1;
      out.push(' ');
      continue;
    }
    out.push(char);
    if (!/\s/.test(char)) previous = char;
  }
  return { text: out.join(''), trailingCommas, controlChars, widePunctuation, wideSpaces };
}

function decode(text: string): Decoded | null {
  try {
    return { value: JSON.parse(text), text, trailingCommas: 0, controlChars: 0, widePunctuation: 0, wideSpaces: 0 };
  } catch { /* 后续只尝试等价语法修正。 */ }
  const normalized = normalizeSyntax(text);
  if (!normalized.trailingCommas && !normalized.controlChars && !normalized.widePunctuation && !normalized.wideSpaces) return null;
  try { return { ...normalized, value: JSON.parse(normalized.text) }; } catch { return null; }
}

interface Candidate { text: string; complete: boolean; intendedJson: boolean }

/** 扫描顶层独立候选。无论解析成功与否，都跳过整个根结构，绝不拆出其中的子块。 */
function* candidates(body: string): Generator<Candidate> {
  let start = -1;
  let quoted = false;
  let escaped = false;
  const stack: string[] = [];
  const candidate = (end: number, complete: boolean): Candidate => {
    const text = body.slice(start, end);
    // [说明] / {仅供核对} 这类包裹注记不是另一个坏 JSON 结果。
    const intendedJson = /^\{\s*(?:["'}:]|[A-Za-z_$][\w$]*\s*:|$)|^\[\s*(?:["'{\[\]\d,:-]|true\b|false\b|null\b|$)/.test(text);
    return { text, complete, intendedJson };
  };
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]!;
    if (start < 0) {
      if (char !== '{' && char !== '[') continue;
      start = index; stack.push(char); quoted = false; escaped = false;
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{' || char === '[') stack.push(char);
    if (char !== '}' && char !== ']') continue;
    const opener = stack.pop();
    if ((opener === '{' && char !== '}') || (opener === '[' && char !== ']')) {
      yield candidate(index + 1, true);
      start = -1; stack.length = 0;
    } else if (stack.length === 0) {
      yield candidate(index + 1, true);
      start = -1;
    }
  }
  if (start >= 0) yield candidate(body.length, false);
}

function resolve(content: string): Decoded {
  if (content.length > MAX_JSON_CHARS) fail('too-large', content.length, 0);
  const reasoning = withoutLeadingReasoning(content);
  if (reasoning.pending) fail('incomplete', content.length, 0);
  const trimmed = reasoning.body.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]!.trim() : trimmed;
  const accept = (parsed: Decoded, extracted: boolean): Decoded => {
    let doubleEncoded = false;
    // 部分服务把整个结构再次编码为 JSON 字符串，只确定性解包一层。
    if (typeof parsed.value === 'string' && /^[\[{]/.test(parsed.value.trim())) {
      const unwrapped = decode(parsed.value.trim());
      if (!unwrapped) fail('syntax', content.length, 1);
      parsed = unwrapped;
      doubleEncoded = true;
    }
    if (extracted || fenced || reasoning.removed || doubleEncoded || parsed.trailingCommas ||
        parsed.controlChars || parsed.widePunctuation || parsed.wideSpaces) {
      vsLog.info('json-output:compatible', { chars: content.length, extracted, reasoningRemoved: reasoning.removed,
        doubleEncoded, trailingCommas: parsed.trailingCommas, controlChars: parsed.controlChars,
        widePunctuation: parsed.widePunctuation, wideSpaces: parsed.wideSpaces });
    }
    return parsed;
  };
  const direct = decode(body);
  if (direct) return accept(direct, false);
  const valid: Decoded[] = [];
  let count = 0;
  let incomplete = false;
  let malformed = false;
  for (const candidate of candidates(body)) {
    count += 1;
    if (count > MAX_CANDIDATES) fail('too-large', content.length, count);
    if (!candidate.complete) { incomplete ||= candidate.intendedJson; continue; }
    const decoded = decode(candidate.text);
    if (decoded) valid.push(decoded);
    else malformed ||= candidate.intendedJson;
  }
  if (incomplete) fail('incomplete', content.length, count);
  if (malformed) fail('syntax', content.length, count);
  if (valid.length > 1) fail('multiple', content.length, count);
  if (valid[0]) return accept(valid[0], true);
  fail('non-json', content.length, count);
}

/** 兼容现有调用接口：返回可供 JSON.parse 的唯一完整正文，而非贪婪截取。 */
export function extractJsonText(content: string): string { return resolve(content).text; }

/** 只解析正文；业务字段与引用仍由原来的严格校验器检查。 */
export function parseJsonPayload(content: string): unknown { return resolve(content).value; }
