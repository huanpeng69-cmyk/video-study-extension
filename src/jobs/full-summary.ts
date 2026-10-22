/**
 * 整段字幕一次性总结：有多少字幕就总结多少。
 *
 * 与「随播放的 30 秒节点」的区别：
 * - 自动学习只处理已经播到的段落，未观看区间永远不总结；
 * - 本功能读取当前字幕版本的全部 cue，按模型预算分块，**逐块全部处理**，
 *   最后合成一条 summary 并写入笔记。
 *
 * 硬约束（与既有实现一致，不放宽）：
 * - 每块都要求模型给出真实 sourceCueIds，越界或缺失一律失败，绝不补造；
 * - 分块只按完整 cue 边界切，时间轴取自原字幕，不重算、不截断正文；
 * - 任一分块失败则整体失败，不把「部分结果」当完整成稿写入。
 */
import { buildAutoSummaryMessages, validateAutoSummarySection } from '../ai/auto-summary';
import { parseJsonPayload } from '../ai/client';
import type { SummaryPayload, SummarySection } from '../domain/aiResult';
import { appError, toAppError, type AppError } from '../domain/errors';
import { planChunks } from '../domain/chunking';
import { formatTimecode, type Cue } from '../domain/transcript';
import type { ProviderSnapshot } from '../storage/types';

/** 单次整段总结的分块上限；超过就明确拒绝，不静默只总结一部分。 */
export const MAX_FULL_SUMMARY_CHUNKS = 40;

export interface FullSummaryChunk {
  /** 从 1 开始，用于进度显示。 */
  index: number;
  total: number;
  cueCount: number;
  startMs: number;
  endMs: number;
}

export interface FullSummaryPlan {
  chunks: FullSummaryChunk[];
  cueCount: number;
}

/** 只做规划，不发请求：让界面能先显示「要处理几段、覆盖到哪」。 */
export function planFullSummary(cues: Cue[]): FullSummaryPlan {
  if (cues.length === 0) throw appError('NO_SUBTITLE', '当前没有字幕可供总结');
  const plans = planChunks(cues);
  if (plans.length > MAX_FULL_SUMMARY_CHUNKS) {
    throw appError('TOO_LARGE',
      `字幕共 ${cues.length} 条，需要 ${plans.length} 段才能覆盖，超过单次上限 ${MAX_FULL_SUMMARY_CHUNKS} 段；请分段导入后再总结`);
  }
  return {
    cueCount: cues.length,
    chunks: plans.map((plan, index) => {
      const first = plan.cues[0]!;
      const last = plan.cues[plan.cues.length - 1]!;
      return {
        index: index + 1, total: plans.length, cueCount: plan.cues.length,
        startMs: first.startMs, endMs: last.endMs,
      };
    }),
  };
}

/**
 * 把分块结果合成一条 summary。
 *
 * 为什么只在标题里追加时间段：导出与界面按顺序编号，标题带区间才能让读者
 * 对应回原视频；正文与引用一字不改。
 */
export function assembleFullSummary(sections: SummarySection[], coverageSeconds: number): SummaryPayload {
  if (sections.length === 0) throw appError('VALIDATION_FAILED', '没有任何分块结果可合成');
  const withRange = sections.map((section, index) => ({
    ...section,
    title: `第 ${index + 1} 段 · ${section.title}`,
  }));
  return {
    opening: {
      ...withRange[0]!,
      title: `全片概览 · 覆盖约 ${Math.max(1, Math.round(coverageSeconds / 60))} 分钟`,
    },
    sections: withRange.slice(1),
  };
}

export interface FullSummaryRunner {
  /** 实际发一次请求，返回模型正文；失败抛 AppError。 */
  request: (input: { cues: Cue[]; title: string; targetLanguage: string }) => Promise<string>;
  provider: ProviderSnapshot;
  language: string;
  onProgress?: (done: number, total: number) => void;
}

export interface FullSummaryResult {
  payload: SummaryPayload;
  coveredCueIds: string[];
  providerSnapshot: ProviderSnapshot;
}

/**
 * 逐块总结并校验。任一失败即整体失败，不返回半成品。
 *
 * 引用校验用**本块**的真实 cueId 列表，因此跨块引用会被拒绝——
 * 这与自动学习的「引用护栏」完全一致，不因为换了入口就放松。
 */
export async function runFullSummary(cues: Cue[], runner: FullSummaryRunner): Promise<FullSummaryResult> {
  const plans = planChunks(cues);
  if (plans.length === 0) throw appError('NO_SUBTITLE', '当前没有字幕可供总结');
  if (plans.length > MAX_FULL_SUMMARY_CHUNKS) {
    throw appError('TOO_LARGE', `字幕需要 ${plans.length} 段才能覆盖，超过单次上限 ${MAX_FULL_SUMMARY_CHUNKS} 段`);
  }
  const sections: SummarySection[] = [];
  const covered = new Set<string>();
  let stopReason: AppError | null = null;

  for (let index = 0; index < plans.length; index += 1) {
    const plan = plans[index]!;
    if (stopReason) throw stopReason;
    let raw: string;
    try {
      raw = await runner.request({
        cues: plan.cues,
        title: `第 ${index + 1}/${plans.length} 段 ${formatTimecode(plan.cues[0]!.startMs)}–${formatTimecode(plan.cues[plan.cues.length - 1]!.endMs)}`,
        targetLanguage: runner.language,
      });
    } catch (cause) {
      stopReason = toAppError(cause, 'UNKNOWN', '整段总结请求失败');
      throw stopReason;
    }
    let section: SummarySection;
    try {
      section = validateAutoSummarySection(parseJsonPayload(raw), plan.cues.map((cue) => cue.cueId));
    } catch (cause) {
      // 该段失败不吞掉：明确告知是第几段、什么原因，前面已完成的结果不写入。
      const error = toAppError(cause, 'VALIDATION_FAILED', '整段总结的某一段未通过校验');
      throw appError(error.code, `第 ${index + 1}/${plans.length} 段未通过校验：${error.message}`, {
        detail: error.detail,
      });
    }
    sections.push(section);
    for (const block of [...section.paragraphs, ...section.bullets]) {
      for (const cueId of block.sourceCueIds) covered.add(cueId);
    }
    runner.onProgress?.(index + 1, plans.length);
  }

  const lastCue = cues[cues.length - 1]!;
  return {
    payload: assembleFullSummary(sections, lastCue.endMs / 1000),
    coveredCueIds: [...covered],
    providerSnapshot: runner.provider,
  };
}

/** 供「整段总结」拼装 prompt；与自动学习共用同一套规则文本。 */
export function buildFullSummaryMessages(input: { cues: Cue[]; title: string; targetLanguage: string }) {
  return buildAutoSummaryMessages(input);
}
