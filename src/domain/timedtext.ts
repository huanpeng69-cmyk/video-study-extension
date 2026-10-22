/** Timedtext/JSON3 normalization. Only source timestamps are used; malformed XML is never repaired. */
import type { RawTrackCue } from './page-tracks';

export interface TimedTextResult {
  cues: RawTrackCue[];
  rejected: number;
  /** A recognized but unsafe/malformed document must not fall back to salvaging cue-like text. */
  error?: string;
}

const MAX_TEXT_LENGTH = 2 * 1024 * 1024;
const MAX_ENTRIES = 20_000;

interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: (XmlNode | string)[];
}

/** No DTD, custom entities, external resources, or forgiving HTML parser. */
function decodeXmlText(raw: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return raw.replace(/&([^;\s<&]*);|&/g, (match, name: string | undefined) => {
    if (name && Object.hasOwn(entities, name)) return entities[name]!;
    if (name && /^#(?:x[0-9a-f]+|[0-9]+)$/i.test(name)) {
      const code = name[1]?.toLowerCase() === 'x' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if ((code === 9 || code === 10 || code === 13 || code >= 32) && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) && code !== 0xfffe && code !== 0xffff) {
        return String.fromCodePoint(code);
      }
    }
    throw new Error('invalid-xml-entity');
  });
}

/** Small bounded XML reader, identical in Node and the browser. Fail closed on any broken structure. */
function readXml(raw: string): XmlNode | null {
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;
  let index = 0;
  let nodes = 0;
  let declaration = false;
  try {
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(raw)) return null;
    while (index < raw.length) {
      if (raw.startsWith('<!--', index)) {
        const end = raw.indexOf('-->', index + 4);
        if (end < 0 || raw.slice(index + 4, end).includes('--')) return null;
        index = end + 3;
        continue;
      }
      if (raw.startsWith('<![CDATA[', index)) {
        const end = raw.indexOf(']]>', index + 9);
        if (end < 0 || !stack.length) return null;
        stack[stack.length - 1]!.children.push(raw.slice(index + 9, end));
        index = end + 3;
        continue;
      }
      if (raw.startsWith('<?xml ', index)) {
        const end = raw.indexOf('?>', index + 6);
        if (end < 0 || declaration || root || stack.length) return null;
        declaration = true;
        index = end + 2;
        continue;
      }
      if (raw[index] !== '<') {
        const end = raw.indexOf('<', index);
        const text = raw.slice(index, end < 0 ? raw.length : end);
        if (text.includes(']]>')) return null;
        if (stack.length) stack[stack.length - 1]!.children.push(decodeXmlText(text));
        else if (text.trim()) return null;
        index = end < 0 ? raw.length : end;
        continue;
      }
      const token = /^<(?:"[^"<]*"|'[^'<]*'|[^'"<>])*>/.exec(raw.slice(index))?.[0];
      if (!token) return null;
      index += token.length;
      const close = /^<\/([A-Za-z_][\w.:-]*)\s*>$/.exec(token);
      if (close) {
        if (stack.pop()?.name !== close[1]) return null;
        continue;
      }
      const open = /^<([A-Za-z_][\w.:-]*)([\s\S]*?)(\/?)>$/.exec(token);
      if (!open || ++nodes > 100_000 || stack.length >= 64) return null;
      const attrs: Record<string, string> = Object.create(null) as Record<string, string>;
      let rest = open[2] ?? '';
      while (rest.trim()) {
        const attr = /^\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/.exec(rest);
        if (!attr || Object.hasOwn(attrs, attr[1]!)) return null;
        attrs[attr[1]!] = decodeXmlText(attr[2] ?? attr[3] ?? '');
        rest = rest.slice(attr[0].length);
      }
      const node: XmlNode = { name: open[1]!, attrs, children: [] };
      if (stack.length) stack[stack.length - 1]!.children.push(node);
      else if (root) return null;
      else root = node;
      if (open[3] !== '/') stack.push(node);
    }
    return stack.length ? null : root;
  } catch {
    return null;
  }
}

function xmlBody(node: XmlNode): string {
  return node.children.map((child) => typeof child === 'string' ? child : child.name === 'br' ? '\n' : xmlBody(child)).join('')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/?[^>]+>/g, '');
}

function readNumber(raw: string | undefined): number | null {
  if (raw === undefined || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw.trim())) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

interface RawEntry {
  startSec: number | null;
  durSec: number | null;
  missingDuration: boolean;
  text: string;
}

function collectCues(entries: RawEntry[]): TimedTextResult {
  const cues: RawTrackCue[] = [];
  let rejected = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    const text = entry.text.replace(/\u0000/g, '').trim();
    if (entry.startSec === null || entry.startSec < 0 || !Number.isFinite(entry.startSec) || !text) {
      rejected += 1;
      continue;
    }
    let endSec: number | null = null;
    if (entry.durSec !== null && entry.durSec > 0) endSec = entry.startSec + entry.durSec;
    else if (entry.missingDuration) {
      // Missing duration only: the next real start is usable; explicit invalid durations are not repaired.
      const next = entries[index + 1]?.startSec;
      if (next !== undefined && next !== null && next > entry.startSec) endSec = next;
    }
    if (endSec === null || !Number.isSafeInteger(Math.round(endSec * 1000)) || !Number.isSafeInteger(Math.round(entry.startSec * 1000)) || Math.round(endSec * 1000) <= Math.round(entry.startSec * 1000)) {
      rejected += 1;
      continue;
    }
    cues.push({ startTime: entry.startSec, endTime: endSec, text });
  }
  return { cues, rejected };
}

/** v1/v2 <transcript><text start dur>, or srv3 <timedtext><body><p t d>. */
export function parseTimedText(raw: string): TimedTextResult | null {
  const trimmed = raw.replace(/^\uFEFF/, '').trim();
  if (!trimmed.startsWith('<')) return null;
  if (trimmed.length > MAX_TEXT_LENGTH) return { cues: [], rejected: 0, error: '字幕 XML 超过大小上限' };
  const root = readXml(trimmed);
  if (!root) return { cues: [], rejected: 0, error: '字幕 XML 格式无效，未尝试修复内容' };
  if (root.name !== 'transcript' && root.name !== 'timedtext') return null;
  const srv3 = root.name === 'timedtext';
  const container = srv3 ? root.children.find((child): child is XmlNode => typeof child !== 'string' && child.name === 'body') : root;
  const nodes = container?.children.filter((child): child is XmlNode => typeof child !== 'string' && child.name === (srv3 ? 'p' : 'text')) ?? [];
  if (nodes.length > MAX_ENTRIES) return { cues: [], rejected: 0, error: '字幕条目超过上限' };
  return collectCues(nodes.map((node) => {
    const start = readNumber(node.attrs[srv3 ? 't' : 'start']);
    const duration = node.attrs[srv3 ? 'd' : 'dur'];
    const dur = readNumber(duration);
    return {
      startSec: start === null ? null : start / (srv3 ? 1000 : 1),
      durSec: dur === null ? null : dur / (srv3 ? 1000 : 1),
      missingDuration: duration === undefined,
      text: xmlBody(node),
    };
  }));
}

/** JSON3 captions; non-caption JSON returns null, without creating synthetic text or times. */
export function parseJson3Captions(raw: string): TimedTextResult | null {
  const trimmed = raw.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('{')) return null;
  if (trimmed.length > MAX_TEXT_LENGTH) return { cues: [], rejected: 0, error: '字幕 JSON 超过大小上限' };
  let payload: unknown;
  try {
    payload = JSON.parse(trimmed);
  } catch {
    return null;
  }
  const events = (payload as { events?: unknown } | null)?.events;
  if (!Array.isArray(events)) return null;
  if (events.length > MAX_ENTRIES) return { cues: [], rejected: 0, error: '字幕条目超过上限' };
  return collectCues(events.map((event: unknown) => {
    const node = event as { tStartMs?: unknown; dDurationMs?: unknown; segs?: unknown } | null;
    const start = typeof node?.tStartMs === 'number' && Number.isFinite(node.tStartMs) ? node.tStartMs : null;
    const duration = typeof node?.dDurationMs === 'number' && Number.isFinite(node.dDurationMs) ? node.dDurationMs : null;
    const text = Array.isArray(node?.segs) ? node.segs.map((seg: unknown) => {
      const value = (seg as { utf8?: unknown } | null)?.utf8;
      return typeof value === 'string' ? value : '';
    }).join('') : '';
    return { startSec: start === null ? null : start / 1000, durSec: duration === null ? null : duration / 1000, missingDuration: node?.dDurationMs === undefined, text };
  }));
}
