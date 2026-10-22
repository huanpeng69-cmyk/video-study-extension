/**
 * 导出（技术方案 7.4、PRD F09）。
 * Markdown 由结构化数据生成，不从渲染 DOM 抓取；文件名与 frontmatter 都做转义。
 */
import type { SummaryPayload } from '../domain/aiResult';
import { watchUrlFor } from '../domain/video';
import { formatTimecode, type Cue } from '../domain/transcript';
import type { SummaryRecord, VideoRecord } from '../storage/types';

export interface MarkdownExportInput {
  video: VideoRecord;
  cues: Cue[];
  translations: Map<string, string>;
  summary?: SummaryRecord;
  noteMarkdown: string;
  includeTranscript: boolean;
  includeSummary: boolean;
  generatedAt: string;
}

/** 文件名移除路径分隔符、控制字符，限制长度。 */
export function safeFileName(title: string, fallback = 'video-notes'): string {
  const cleaned = title
    .normalize('NFKC')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function escapeYaml(value: string): string {
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ');
  return `"${escaped}"`;
}

function buildFrontmatter(input: MarkdownExportInput, summary: SummaryRecord | undefined): string {
  const { video } = input;
  const lines = [
    '---',
    `title: ${escapeYaml(video.title)}`,
    `source: ${escapeYaml(watchUrlFor(video, 0))}`,
    `bvid: ${video.bvid}`,
    `cid: ${video.cid}`,
    `page: ${video.pageIndex}`,
    `created: ${input.generatedAt}`,
  ];
  if (video.tags.length > 0) lines.push(`tags: [${video.tags.map(escapeYaml).join(', ')}]`);
  if (summary) {
    lines.push(`model: ${escapeYaml(summary.providerSnapshot.modelId)}`);
    lines.push(`summary_status: ${summary.coverage}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}

function renderBlock(
  block: { text: string; sourceCueIds: string[] },
  video: VideoRecord,
  cueIndex: Map<string, Cue>,
  kind: 'paragraph' | 'bullet',
): string[] {
  const first = block.sourceCueIds.map((id) => cueIndex.get(id)).find(Boolean);
  const link = first ? ` [${formatTimecode(first.startMs)}](${watchUrlFor(video, first.startMs)})` : '';
  // 段落不加列表符号，条目加短横线：与成稿笔记的排版一致。
  return kind === 'bullet' ? [`- ${block.text}${link}`] : [`${block.text}${link}`];
}

/** 章节序号：一、二、三……超过十个用「十一、」这类中文数字。 */
export function sectionOrdinal(index: number): string {
  const number = index + 1;
  if (!Number.isInteger(number) || number < 1 || number > 9999) return `${number}、`;
  const digits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const units = ['千', '百', '十', ''];
  let value = '';
  let zero = false;
  [1000, 100, 10, 1].forEach((divisor, place) => {
    const digit = Math.floor(number / divisor) % 10;
    if (digit) {
      if (zero) value += '零';
      value += `${digits[digit]}${units[place]}`;
      zero = false;
    } else if (value && number % divisor) zero = true;
  });
  return `${value.replace(/^一十/, '十')}、`;
}

/**
 * 渲染全视频总结：编号章节 + 章节内正文段落与列表条目。
 * 编号在这里按顺序生成，模型不参与编号，避免出现「一、」重复或跳号。
 */
function renderSummary(summary: SummaryRecord, video: VideoRecord, cueIndex: Map<string, Cue>): string[] {
  const payload: SummaryPayload = summary.payload;
  const sections = [payload.opening, ...payload.sections];
  const lines: string[] = ['## 学习总结', ''];

  if (summary.coverage === 'partial') {
    lines.push('> 注意：这是未完成的总结，只覆盖部分字幕。', '');
  }

  sections.forEach((section, index) => {
    lines.push(`### ${sectionOrdinal(index)}${section.title}`, '');
    for (const block of section.paragraphs) lines.push(...renderBlock(block, video, cueIndex, 'paragraph'));
    if (section.paragraphs.length > 0) lines.push('');
    for (const block of section.bullets) lines.push(...renderBlock(block, video, cueIndex, 'bullet'));
    lines.push('');
  });

  lines.push(
    `> 基于字幕整理 · ${summary.providerSnapshot.providerName} · ${summary.providerSnapshot.modelId} · ${summary.createdAt}`,
    '',
  );
  return lines;
}

export function buildMarkdown(input: MarkdownExportInput): string {
  const { video } = input;
  const cueIndex = new Map(input.cues.map((cue) => [cue.cueId, cue]));
  const summary = input.includeSummary ? input.summary : undefined;
  const lines: string[] = [buildFrontmatter(input, summary).trimEnd(), ''];
  lines.push(`# ${video.title}`, '');
  lines.push(
    `- 视频：[${video.bvid} · 第 ${video.pageIndex} P](${watchUrlFor(video, 0)})`,
    '',
  );

  if (summary) lines.push(...renderSummary(summary, video, cueIndex));

  lines.push('## 我的笔记', '');
  lines.push(input.noteMarkdown.trim() ? input.noteMarkdown.trim() : '_（尚未填写）_', '');

  if (input.includeTranscript) {
    lines.push('## 字幕原文', '');
    if (input.cues.length === 0) {
      lines.push('_（没有字幕）_', '');
    }
    for (const cue of input.cues) {
      const translated = input.translations.get(cue.cueId);
      const stamp = `[${formatTimecode(cue.startMs)}](${watchUrlFor(video, cue.startMs)})`;
      lines.push(`- ${stamp} ${cue.text}`);
      if (translated) lines.push(`  - ${translated}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

/** 原文导出 SRT：时间轴直接取自原字幕，不做任何重排或合并。 */
export function buildSrt(cues: Cue[]): string {
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const stamp = (ms: number) => {
    const total = Math.max(0, Math.round(ms));
    const hours = Math.floor(total / 3_600_000);
    const minutes = Math.floor((total % 3_600_000) / 60_000);
    const seconds = Math.floor((total % 60_000) / 1000);
    const millis = total % 1000;
    return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(millis, 3)}`;
  };
  return cues
    .map((cue, index) => `${index + 1}\n${stamp(cue.startMs)} --> ${stamp(cue.endMs)}\n${cue.text}\n`)
    .join('\n');
}

/**
 * 模型/Markdown 输出按不可信内容处理：渲染前只允许安全协议。
 * 生成时先移除脚本、内联事件与危险链接，避免导出或预览时执行。
 */
export function sanitizeMarkdown(markdown: string): string {
  return markdown
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '')
    .replace(/data:text\/html/gi, '');
}
