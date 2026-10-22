/**
 * 分段与预算（技术方案 5.2）。
 * 预算以完整 Cue 为边界，保留原 cueId；不做数组位置推断。
 */
import type { Cue } from './transcript';
import { appError } from './errors';

export interface ChunkPlan {
  chunkKey: string;
  cues: Cue[];
  /** 仅用于提供上下文，不要求模型翻译这些条目。 */
  contextBefore: string[];
  contextAfter: string[];
  charCount: number;
}

/**
 * 分块上限。
 *
 * 为什么从 60 条 / 3000 字上调：
 * 这两个值直接决定请求段数，而每段都是一次完整的大模型往返。
 * 实测 60 分钟讲解视频（约 1440 条字幕）会被切成 24 段，串行执行需要数分钟；
 * 模型本身一次完全能读下更多上下文，切成 60 条只是把一个请求拆成三次，
 * 时间线性增加而质量没有提升。
 *
 * 现取值仍留有充足余量：240 条约 3000~6000 字，远低于主流模型窗口，
 * 且每段要求模型只做“本段抽取”，输出长度可控，不会因为输入变长而降质。
 */
export const DEFAULT_MAX_CUES_PER_CHUNK = 240;
export const DEFAULT_MAX_CHARS_PER_CHUNK = 8000;
export const CONTEXT_BEFORE_LINES = 3;
export const CONTEXT_AFTER_LINES = 2;

export interface ChunkOptions {
  maxCues?: number;
  maxChars?: number;
  /**
   * 按时间间隔切段（毫秒）。设置后优先按它切，并仍受 maxCues/maxChars 上限约束。
   *
   * 为什么要按时间：增量产出时，用户看到的是「当前进度对应哪一段」。
   * 按条数切段会让每段覆盖的时长忽长忽短（讲解密集处一段可能只覆盖两分钟，
   * 稀疏处覆盖十分钟），进度条与视频时间对不上，用户无法预期「还要等多久」。
   * 按固定时间间隔切，段与时间轴一一对应，进度可解释。
   */
  intervalMs?: number;
}

/** 增量产出的默认时间粒度：每段覆盖 5 分钟视频。 */
export const DEFAULT_CHUNK_INTERVAL_MS = 5 * 60_000;

/**
 * 按 Cue 边界分批。单个 Cue 超长时不切割文本生成假时间轴，
 * 而是单独成批，由上游判断是否需要提示缩小范围（技术方案 5.2 最后一条）。
 *
 * 切段边界永远是**完整 Cue**：时间轴只取自原字幕，不因分段而重算。
 */
export function planChunks(cues: Cue[], options: ChunkOptions = {}): ChunkPlan[] {
  const maxCues = options.maxCues ?? DEFAULT_MAX_CUES_PER_CHUNK;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS_PER_CHUNK;
  const intervalMs = options.intervalMs;
  if (cues.length === 0) return [];
  const plans: ChunkPlan[] = [];
  let current: Cue[] = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const first = current[0];
    const last = current[current.length - 1];
    const startIndex = first ? first.sequence : 0;
    plans.push({
      chunkKey: `chunk-${plans.length}-${startIndex}-${last ? last.sequence : startIndex}`,
      cues: current,
      contextBefore: [],
      contextAfter: [],
      charCount: currentChars,
    });
    current = [];
    currentChars = 0;
  };

  for (const cue of cues) {
    const cueChars = cue.text.length;
    const overflowBySize = current.length > 0 && (current.length >= maxCues || currentChars + cueChars > maxChars);
    // 时间间隔只作为一个额外的切分条件：超出间隔就收一段，但绝不把单条字幕切开。
    const first = current[0];
    const overflowByTime =
      intervalMs !== undefined && current.length > 0 && first !== undefined && cue.endMs - first.startMs > intervalMs;
    if (overflowBySize || overflowByTime) flush();
    current.push(cue);
    currentChars += cueChars;
  }
  flush();

  return plans.map((plan, index) => {
    const previous = plans[index - 1];
    const next = plans[index + 1];
    return {
      ...plan,
      contextBefore: previous ? tailText(previous.cues, CONTEXT_BEFORE_LINES) : [],
      contextAfter: next ? headText(next.cues, CONTEXT_AFTER_LINES) : [],
    };
  });
}

function tailText(cues: Cue[], count: number): string[] {
  return cues.slice(-count).map((cue) => cue.text);
}

function headText(cues: Cue[], count: number): string[] {
  return cues.slice(0, count).map((cue) => cue.text);
}

export function assertWithinModelBudget(inputChars: number, maxInputChars: number): void {
  if (inputChars > maxInputChars) {
    throw appError('TOO_LARGE', '本段文本超出模型上下文预算');
  }
}
