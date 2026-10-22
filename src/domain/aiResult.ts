/**
 * AI 结果契约与校验（技术方案 5.3、5.4）。
 * 核心原则：格式正确 ≠ 内容正确；引用必须来自本批可见输入，非法引用使该批失败，
 * 不允许“删掉引用让校验变绿”。
 */
import { appError } from './errors';
import type { Cue } from './transcript';

export interface TranslationItem {
  cueId: string;
  translatedText: string;
}

/**
 * 全视频总结的结构。
 *
 * 参照用户提供的目标结构（《施工项目进度管理_学习笔记》）：
 *   标题
 *   一、先建立一个核心认知        ← 编号章节
 *     正文段落（可多段）
 *     列表条目（可多条）
 *   二、…
 *
 * 与旧结构的差别：旧结构是固定五字段（overview/chapters/keyPoints/terms/reviewQuestions），
 * 章节只能装「要点」；新结构让章节内部可以同时有正文段落与列表条目，
 * 更贴近成稿笔记的写法。
 *
 * 护栏不变：正文段落与列表条目都必须带 sourceCueIds，且只能引用本批可见的 cueId。
 * 没有依据的内容不允许输出——这一条比「写得像成稿」更重要。
 */
export interface SummaryBlock {
  /** 段落或条目的文字。 */
  text: string;
  /** 依据的字幕 ID；必须来自本批可见输入。 */
  sourceCueIds: string[];
}

export interface SummarySection {
  /** 章节标题，不含「一、」这类编号（编号由界面与导出按顺序生成）。 */
  title: string;
  /** 章节内的正文段落。 */
  paragraphs: SummaryBlock[];
  /** 章节内的列表条目。 */
  bullets: SummaryBlock[];
}

export interface SummaryPayload {
  /** 开篇定位或总体概括；对应示例中的「一、先建立一个核心认知」。 */
  opening: SummarySection;
  /** 其余编号章节，按视频顺序排列。 */
  sections: SummarySection[];
}

/** 严格校验译文：每个目标 ID 恰好出现一次，无未知/重复/空文本。 */
export function validateTranslation(
  items: unknown,
  expectedCueIds: string[],
): { ok: true; items: TranslationItem[] } | { ok: false; error: ReturnType<typeof appError> } {
  if (!Array.isArray(items)) {
    return { ok: false, error: appError('VALIDATION_FAILED', '译文返回不是数组') };
  }
  const expected = new Set(expectedCueIds);
  const seen = new Set<string>();
  const valid: TranslationItem[] = [];
  for (const raw of items) {
    const item = raw as Record<string, unknown> | null;
    const cueId = typeof item?.cueId === 'string' ? item.cueId : '';
    const translatedText = typeof item?.translatedText === 'string' ? item.translatedText.trim() : '';
    if (!cueId || !translatedText) {
      return { ok: false, error: appError('VALIDATION_FAILED', '译文存在空 ID 或空文本') };
    }
    if (!expected.has(cueId)) {
      return { ok: false, error: appError('VALIDATION_FAILED', `译文包含未知 cueId：${cueId.slice(0, 32)}`) };
    }
    if (seen.has(cueId)) {
      return { ok: false, error: appError('VALIDATION_FAILED', `译文重复 cueId：${cueId.slice(0, 32)}`) };
    }
    seen.add(cueId);
    valid.push({ cueId, translatedText });
  }
  const missing = expectedCueIds.filter((id) => !seen.has(id));
  if (missing.length > 0) {
    return {
      ok: false,
      error: appError('VALIDATION_FAILED', `译文缺少 ${missing.length} 条目标字幕`, {
        detail: missing.slice(0, 5).join(', '),
      }),
    };
  }
  // 按原字幕顺序重排，返回顺序不重要。
  const order = new Map(expectedCueIds.map((id, index) => [id, index]));
  valid.sort((a, b) => (order.get(a.cueId) ?? 0) - (order.get(b.cueId) ?? 0));
  return { ok: true, items: valid };
}

interface SummaryContext {
  /** 本批可见的原字幕 ID；引用只能来自这里。 */
  visibleCueIds: string[];
}

/**
 * 校验全视频总结的结构与引用。
 *
 * 规则（护栏，不因结构变化而放宽）：
 * - 每个正文段落与列表条目必须有至少一个 `sourceCueIds`；
 * - 引用必须存在于本批可见输入，越界引用被剔除并计数；
 * - 引用被剔除后不足一个的条目整体丢弃，不做「删掉引用让校验变绿」；
 * - 空章节（无标题或无任何有效条目）丢弃；
 * - 全部章节都无效时整批失败，避免产出空壳总结。
 */
export function validateSummary(
  payload: unknown,
  context: SummaryContext,
): { ok: true; summary: SummaryPayload; droppedRefs: number } | { ok: false; error: ReturnType<typeof appError> } {
  const record = payload as Record<string, unknown> | null;
  if (!record || typeof record !== 'object') {
    return { ok: false, error: appError('BAD_RESPONSE', '总结返回不是对象') };
  }
  const visible = new Set(context.visibleCueIds);
  let droppedRefs = 0;

  const readBlock = (raw: unknown): SummaryBlock | null => {
    const item = raw as Record<string, unknown> | null;
    const text = typeof item?.text === 'string' ? item.text.trim() : '';
    const ids = Array.isArray(item?.sourceCueIds)
      ? item.sourceCueIds.filter((v): v is string => typeof v === 'string')
      : [];
    if (!text) return null;
    const known = ids.filter((id) => visible.has(id));
    droppedRefs += ids.length - known.length;
    // 没有有效引用即丢弃：不允许无依据内容进入成稿。
    if (known.length === 0) return null;
    return { text, sourceCueIds: Array.from(new Set(known)) };
  };

  const readBlocks = (raw: unknown): SummaryBlock[] =>
    Array.isArray(raw) ? raw.map(readBlock).filter((b): b is SummaryBlock => b !== null) : [];

  const readSection = (raw: unknown): SummarySection | null => {
    const item = raw as Record<string, unknown> | null;
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    if (!title) return null;
    const paragraphs = readBlocks(item?.paragraphs);
    const bullets = readBlocks(item?.bullets);
    if (paragraphs.length === 0 && bullets.length === 0) {
      droppedRefs += 1;
      return null;
    }
    return { title, paragraphs, bullets };
  };

  const opening = readSection(record.opening);
  if (!opening) {
    return { ok: false, error: appError('VALIDATION_FAILED', '开篇章节缺少有效内容或引用') };
  }

  const sections: SummarySection[] = [];
  if (Array.isArray(record.sections)) {
    for (const raw of record.sections) {
      const section = readSection(raw);
      if (section) sections.push(section);
    }
  }

  if (sections.length === 0) {
    return { ok: false, error: appError('VALIDATION_FAILED', '总结没有包含任何带有效引用的章节') };
  }

  return {
    ok: true,
    summary: { opening, sections },
    droppedRefs,
  };
}

/** 按顺序展开所有章节（开篇在前），供引用统计与导出复用。 */
export function allSummarySections(payload: SummaryPayload): SummarySection[] {
  return [payload.opening, ...payload.sections];
}

/** 收集总结覆盖的全部 cueId（已校验、去重）。 */
export function summaryCoveredCueIds(payload: SummaryPayload, known: Set<string>): string[] {
  const ids = new Set<string>();
  for (const section of allSummarySections(payload)) {
    for (const block of [...section.paragraphs, ...section.bullets]) {
      for (const id of block.sourceCueIds) if (known.has(id)) ids.add(id);
    }
  }
  return Array.from(ids);
}

/** 由引用 ID 解析出起止时间；时间永远来自原字幕，不采用模型输出。 */
export function resolveCitedRange(
  cueIds: string[],
  cueIndex: Map<string, Cue>,
): { startMs: number; endMs: number } | null {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const id of cueIds) {
    const cue = cueIndex.get(id);
    if (!cue) continue;
    start = Math.min(start, cue.startMs);
    end = Math.max(end, cue.endMs);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { startMs: start, endMs: end };
}
