/**
 * 字幕领域模型与导入解析（技术方案 3.4）。
 * 原字幕只读：译文、段落、AI 批次都是派生视图，不改变原始时间轴。
 */
import { appError, type AppError } from './errors';

export type TranscriptSourceKind = 'native' | 'srt' | 'vtt' | 'asr';
export type TranscriptGenerationKind = 'human' | 'ai' | 'unknown';

export interface Cue {
  cueId: string;
  sequence: number;
  startMs: number;
  endMs: number;
  text: string;
  /** 源文件中的原始序号，用于诊断。 */
  sourceIndex: number;
}

export interface TranscriptParseResult {
  cues: Cue[];
  warnings: string[];
  /** 被拒绝的条目数量，不能静默丢弃后声称导入成功。 */
  rejected: number;
}

export const MAX_CUES = 20_000;
export const MAX_DURATION_MS = 2 * 60 * 60 * 1000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

export function makeCueId(sourceKind: TranscriptSourceKind, sourceIndex: number): string {
  return `${sourceKind}-${sourceIndex}`;
}


/** 解析 mm:ss.mmm、hh:mm:ss.mmm 或逗号小数点，返回整数毫秒。 */
export function parseTimestamp(raw: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/.exec(raw.trim());
  if (!match) return null;
  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const fractionRaw = match[4] ?? '0';
  const millis = Number(fractionRaw.padEnd(3, '0'));
  if (![hours, minutes, seconds, millis].every(Number.isFinite)) return null;
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
}
/**
 * 先解码常见实体，再移除标签：B站正文常以转义的 &lt;br&gt; 表示换行，
 * 顺序反了会把换行当成可见字符保留下来。
 */
function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n?/g, '\n')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?[^>]+>/g, '')
    .trim();
}
/**
 * 解析 B站字幕 JSON（body[].from/to/content，秒）。
 * 时间轴来自源数据，不由模型生成。
 */
export function parseNativeSubtitleBody(body: unknown): TranscriptParseResult {
  const warnings: string[] = [];
  const cues: Cue[] = [];
  let rejected = 0;
  if (!Array.isArray(body)) {
    throw appError('PARSE_FAILED', '字幕正文不是预期的数组结构');
  }
  if (body.length > MAX_CUES) {
    throw appError('TOO_LARGE', `字幕条目超过上限 ${MAX_CUES}`);
  }
  let lastEnd = 0;
  body.forEach((item, index) => {
    const record = item as Record<string, unknown> | null;
    const from = typeof record?.from === 'number' ? record.from : NaN;
    const to = typeof record?.to === 'number' ? record.to : NaN;
    const text = typeof record?.content === 'string' ? normalizeText(record.content) : '';
    if (!Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to <= from || !text) {
      rejected += 1;
      warnings.push(`第 ${index + 1} 条时间或文本无效，已跳过`);
      return;
    }
    const startMs = Math.round(from * 1000);
    const endMs = Math.round(to * 1000);
    if (startMs < lastEnd) warnings.push(`第 ${index + 1} 条相对上一条时间有重叠或逆序`);
    lastEnd = endMs;
    cues.push({
      cueId: makeCueId('native', index),
      sequence: cues.length,
      startMs,
      endMs,
      text,
      sourceIndex: index,
    });
  });
  if (cues.length === 0 && rejected > 0) {
    throw appError('PARSE_FAILED', '没有可用的字幕条目', { detail: warnings.slice(0, 3).join('；') });
  }
  return { cues, warnings, rejected };
}

/** SRT / VTT 文本导入；支持 BOM、CRLF、多行正文、VTT cue 标识与设置。 */
export function parseSubtitleText(rawText: string, kind: 'srt' | 'vtt'): TranscriptParseResult {
  const text = rawText.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) throw appError('PARSE_FAILED', '字幕文件为空');
  const warnings: string[] = [];
  const cues: Cue[] = [];
  let rejected = 0;
  const blocks = text.split(/\n{2,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trimEnd());
    while (lines.length > 0 && lines[0] === '') lines.shift();
    if (lines.length === 0) continue;
    const head = lines[0] ?? '';
    if (kind === 'vtt' && (head === 'WEBVTT' || head.startsWith('WEBVTT '))) continue;
    if (head.startsWith('NOTE') || head.startsWith('STYLE') || head.startsWith('REGION')) continue;

    let timingIndex = 0;
    if (!head.includes('-->')) timingIndex = 1;
    const timingLine = lines[timingIndex];
    if (!timingLine || !timingLine.includes('-->')) {
      rejected += 1;
      warnings.push(`无法识别时间行：${head.slice(0, 40)}`);
      continue;
    }
    const [startRaw, restRaw] = timingLine.split('-->');
    const endRaw = (restRaw ?? '').trim().split(/\s+/)[0] ?? '';
    const startMs = parseTimestamp(startRaw ?? '');
    const endMs = parseTimestamp(endRaw);
    if (startMs === null || endMs === null || endMs <= startMs) {
      rejected += 1;
      warnings.push(`时间轴无效：${timingLine.slice(0, 40)}`);
      continue;
    }
    const bodyText = normalizeText(lines.slice(timingIndex + 1).join('\n'));
    if (!bodyText) {
      rejected += 1;
      warnings.push('空字幕条目已跳过');
      continue;
    }
    const sourceIndex = cues.length + rejected;
    cues.push({
      cueId: makeCueId(kind, sourceIndex),
      sequence: cues.length,
      startMs,
      endMs,
      text: bodyText,
      sourceIndex,
    });
  }

  if (cues.length === 0) {
    throw appError('PARSE_FAILED', '未解析到任何有效字幕条目', { detail: warnings.slice(0, 3).join('；') });
  }
  if (cues.length > MAX_CUES) throw appError('TOO_LARGE', `字幕条目超过上限 ${MAX_CUES}`);
  const duration = cues[cues.length - 1];
  if (duration && duration.endMs > MAX_DURATION_MS) {
    throw appError('TOO_LARGE', '字幕时长超过首版上限 2 小时');
  }
  return { cues, warnings, rejected };
}

export function assertImportSize(bytes: number): void {
  if (bytes > MAX_IMPORT_BYTES) {
    throw appError('TOO_LARGE', '字幕文件超过 5 MiB 上限');
  }
}

/** 稳定哈希：用于判断同一视频字幕内容是否变化。 */
export function hashTranscript(cues: Cue[]): string {
  let hash = 0x811c9dc5;
  const input = cues.map((cue) => `${cue.startMs}-${cue.endMs}-${cue.text}`).join('\u0001');
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 字幕来源类型无法判断时标 unknown，不根据轨道名称猜测。 */
export function inferGenerationKind(trackLabel: string | undefined): TranscriptGenerationKind {
  if (!trackLabel) return 'unknown';
  const label = trackLabel.toLowerCase();
  if (/ai|auto|自动|机器/.test(label)) return 'ai';
  if (/human|manual|人工|字幕组/.test(label)) return 'human';
  return 'unknown';
}


/**
 * 把转写段落转成字幕条目。
 *
 * 时间轴来自转写服务返回的 segment（已加上分段偏移），不是由模型生成，
 * 因此与原视频实时对齐。缺少 end 时退化为 start + 兜底时长，不伪造更细的时间。
 */
export function cuesFromAsrSegments(
  segments: { startMs: number; endMs: number; text: string }[],
): Cue[] {
  const cues: Cue[] = [];
  let lastEnd = 0;
  segments.forEach((segment, index) => {
    const text = segment.text.replace(/\s+/g, ' ').trim();
    if (!text) return;
    const startMs = Math.max(0, Math.round(segment.startMs));
    // 保持单调：上一条结束之后才开始，避免时间轴重叠导致点击跳转抖动。
    const safeStart = Math.max(startMs, lastEnd);
    const endMs = Math.max(Math.round(segment.endMs), safeStart + 1);
    lastEnd = endMs;
    cues.push({
      cueId: makeCueId('asr', index),
      sequence: cues.length,
      startMs: safeStart,
      endMs,
      text,
      sourceIndex: index,
    });
  });
  if (cues.length === 0) {
    throw appError('PARSE_FAILED', '转写没有产生可用文本', {
      detail: '音频可能是纯音乐或静音，可换一段有讲解的区间重试。',
    });
  }
  return cues;
}
export function formatTimecode(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export type ParseOutcome = { ok: true; result: TranscriptParseResult } | { ok: false; error: AppError };
