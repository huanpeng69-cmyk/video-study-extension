/**
 * B站页面元信息抽取（可单测的纯函数）。
 *
 * 背景：页面的 `window.aid` / `window.cid` 在新版 SPA 下并不总是存在，
 * 真正的来源是 `window.__INITIAL_STATE__`。旧实现只读前者，导致快照缺少 cid，
 * 后台判定“播放器信息不完整”，侧栏一直等待。
 *
 * 原则：只读取白名单字段，不触碰 Cookie、localStorage 或鉴权数据。
 */

export interface RawPageSnapshot {
  bvid?: string;
  aid?: string | number;
  cid?: string | number;
  title?: string;
  pageIndex?: number;
  durationMs?: number;
}

export interface NormalizedSnapshot {
  bvid: string;
  aid: string;
  cid: string;
  title: string;
  pageIndex: number;
  durationMs: number;
}

const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/;

function toIdString(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return String(Math.trunc(value));
  return '';
}

export function readPageIndexFromUrl(href: string): number {
  try {
    const url = new URL(href);
    const raw = url.searchParams.get('p');
    if (raw === null) return 1;
    const parsed = Number(raw);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 1;
  } catch {
    return 1;
  }
}

export function readBvidFromUrl(href: string): string {
  try {
    const url = new URL(href);
    const match = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/.exec(url.pathname);
    return match?.[1] ?? '';
  } catch {
    return '';
  }
}

interface InitialStateLike {
  aid?: unknown;
  bvid?: unknown;
  videoData?: {
    bvid?: unknown;
    aid?: unknown;
    title?: unknown;
    pages?: Array<{ cid?: unknown; page?: unknown; part?: unknown; duration?: unknown }>;
  };
}

/**
 * 从 `__INITIAL_STATE__` 结构推断当前分 P 的 cid。
 * 优先用 URL 的 p 序号匹配 pages[]，匹配不到时退回第一页。
 */
export function extractFromInitialState(
  state: unknown,
  href: string,
): { aid: string; bvid: string; cid: string; title: string; pageIndex: number; durationMs: number } | null {
  if (!state || typeof state !== 'object') return null;
  const typed = state as InitialStateLike;
  const videoData = typed.videoData;
  const pages = Array.isArray(videoData?.pages) ? videoData.pages : [];
  const pageIndex = readPageIndexFromUrl(href);
  const matched = pages[pageIndex - 1] ?? pages[0];
  const cid = toIdString(matched?.cid);
  const aid = toIdString(typed.aid ?? videoData?.aid);
  const bvidRaw = typeof videoData?.bvid === 'string' ? videoData.bvid : typeof typed.bvid === 'string' ? typed.bvid : '';
  const bvid = BV_PATTERN.test(bvidRaw) ? bvidRaw : '';
  const title = typeof videoData?.title === 'string' ? videoData.title.trim() : '';
  const durationSec = typeof matched?.duration === 'number' && Number.isFinite(matched.duration) ? matched.duration : 0;
  if (!cid || !aid || !bvid) return null;
  return { aid, bvid, cid, title, pageIndex, durationMs: Math.round(durationSec * 1000) };
}

/**
 * 合并多个来源的快照：依次尝试“主世界初始状态”“页面全局变量”“URL”，
 * 任一来源能补齐 cid 即可，避免某个字段缺失时整体失败。
 */
export function mergeSnapshot(input: {
  href: string;
  initial?: RawPageSnapshot | null;
  globalVars?: RawPageSnapshot | null;
  domTitle?: string;
  videoDurationMs?: number;
}): NormalizedSnapshot | null {
  const fromUrlBvid = readBvidFromUrl(input.href);
  const pageIndex = readPageIndexFromUrl(input.href);

  const bvid =
    pickBvid(input.initial?.bvid) || pickBvid(input.globalVars?.bvid) || fromUrlBvid;
  const aid = toIdString(input.initial?.aid) || toIdString(input.globalVars?.aid);
  const cid = toIdString(input.initial?.cid) || toIdString(input.globalVars?.cid);
  const title =
    (typeof input.initial?.title === 'string' && input.initial.title.trim()) ||
    (typeof input.globalVars?.title === 'string' && input.globalVars.title.trim()) ||
    (input.domTitle ?? '').trim();
  const durationMs =
    (typeof input.initial?.durationMs === 'number' ? input.initial.durationMs : 0) ||
    (typeof input.globalVars?.durationMs === 'number' ? input.globalVars.durationMs : 0) ||
    (typeof input.videoDurationMs === 'number' ? input.videoDurationMs : 0);

  if (!bvid || !aid || !cid) return null;
  return {
    bvid,
    aid,
    cid,
    title: title.slice(0, 300) || '未命名视频',
    pageIndex: typeof input.initial?.pageIndex === 'number' && input.initial.pageIndex > 0 ? input.initial.pageIndex : pageIndex,
    durationMs: Number.isFinite(durationMs) ? Math.round(durationMs) : 0,
  };
}

/** 快照失败的具体原因，用于向用户给出可操作提示，而不是统一报“请确认页面已加载”。 */
export type SnapshotFailure =
  | 'unsupported-url'
  | 'main-world-unavailable'
  | 'missing-aid'
  | 'missing-cid';

export interface SnapshotOutcome {
  ok: boolean;
  snapshot: NormalizedSnapshot | null;
  failure: SnapshotFailure | null;
  /** 已脱敏的诊断信息（不含 query / 鉴权数据）。 */
  diag: {
    pageIndex: number;
    hasBvid: boolean;
    hasAid: boolean;
    hasCid: boolean;
    initialStateReached: boolean;
  };
}

/** 与 mergeSnapshot 同逻辑，但保留失败原因，供界面给出区分化提示。 */
export function resolveSnapshot(input: Parameters<typeof mergeSnapshot>[0]): SnapshotOutcome {
  const pageIndex = readPageIndexFromUrl(input.href);
  const merged = mergeSnapshot(input);
  const bvid = pickBvid(input.initial?.bvid) || pickBvid(input.globalVars?.bvid) || readBvidFromUrl(input.href);
  const aid = toIdString(input.initial?.aid) || toIdString(input.globalVars?.aid);
  const cid = toIdString(input.initial?.cid) || toIdString(input.globalVars?.cid);
  const diag = {
    pageIndex,
    hasBvid: Boolean(bvid),
    hasAid: Boolean(aid),
    hasCid: Boolean(cid),
    initialStateReached: Boolean(input.initial),
  };
  if (merged) return { ok: true, snapshot: merged, failure: null, diag };
  if (!bvid) return { ok: false, snapshot: null, failure: 'unsupported-url', diag };
  if (!aid) {
    return {
      ok: false,
      snapshot: null,
      failure: diag.initialStateReached ? 'missing-aid' : 'main-world-unavailable',
      diag,
    };
  }
  return { ok: false, snapshot: null, failure: 'missing-cid', diag };
}

function pickBvid(value: unknown): string {
  return typeof value === 'string' && BV_PATTERN.test(value) ? value : '';
}
