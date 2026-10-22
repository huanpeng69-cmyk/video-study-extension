/**
 * 视频身份与 URL 校验。
 *
 * 两层模型（关键改动）：
 * 1. **通用层**：任何 http(s) 页面上的 HTML5 `<video>` 都能识别，身份 = 站点源 + 由 URL 推导的稳定键。
 *    不依赖任何站点 API、登录态或专用字段。
 * 2. **适配器层**：B站等站点可在通用身份之外**额外**提供分 P、字幕接口等能力；
 *    适配器缺失时功能降级，而不是整体不可用。
 *
 * 兼容约束：B站主键仍然是 `bilibili:bvid:cid`（含 cid），旧记录与旧链接不失效。
 */

import { applyVideoSiteRules } from '../adapters/site-rules';

export type VideoPlatform = 'bilibili' | 'web';

export interface BilibiliPageInfo {
  bvid: string;
  /** 数值可能很大，统一按字符串处理，避免精度问题。 */
  aid: string;
  cid: string;
  /** 1 起的分 P 序号，仅用于显示与构造回看链接。 */
  pageIndex: number;
  title: string;
  canonicalUrl: string;
  durationMs: number;
}

export const VIDEO_ID_PREFIX = 'bilibili';
export const WEB_VIDEO_ID_PREFIX = 'web';

export function videoRecordId(bvid: string, cid: string): string {
  return `${VIDEO_ID_PREFIX}:${bvid}:${cid}`;
}

/** Short identities retain their historic keys; long suffixes are hashed, never just discarded. */
function boundedIdentity(value: string, limit: number): string {
  if (value.length <= limit) return value;
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  const suffix = `${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}`;
  return `${value.slice(0, limit - suffix.length - 1)}~${suffix}`;
}

export function webVideoRecordId(origin: string, videoKey: string): string {
  return `${WEB_VIDEO_ID_PREFIX}:${boundedIdentity(origin, 120)}:${boundedIdentity(videoKey, 200)}`;
}

const BV_PATTERN = /^BV[0-9A-Za-z]{10}$/;
const PAGE_URL_PATTERN = /^\/video\/(BV[0-9A-Za-z]{10})\/?$/;

/** 只接受 B站普通视频页：/video/BVxxxxxxxxxx 可选尾斜线。 */
export function parseBilibiliVideoUrl(rawUrl: string): { bvid: string; pageParam: number | null } | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  // 移动版 m.bilibili.com 与主站是同一套视频页与分 P 语义，一并接受。
  if (url.hostname !== 'www.bilibili.com' && url.hostname !== 'm.bilibili.com') return null;
  const match = PAGE_URL_PATTERN.exec(url.pathname);
  if (!match || !match[1]) return null;
  const bvid = match[1];
  if (!BV_PATTERN.test(bvid)) return null;
  const pageRaw = url.searchParams.get('p');
  let pageParam: number | null = null;
  if (pageRaw !== null) {
    const parsed = Number(pageRaw);
    if (!Number.isInteger(parsed) || parsed < 1) return null;
    pageParam = parsed;
  }
  return { bvid, pageParam };
}

/** B站适配器是否适用（不满足时仍可走通用层，不再直接判定「不支持」）。 */
export function isSupportedVideoPage(rawUrl: string): boolean {
  return parseBilibiliVideoUrl(rawUrl) !== null;
}

export interface WebVideoIdentity {
  /** 站点源，例如 https://example.com。 */
  origin: string;
  /** URL 推导的稳定视频键，同一视频多次打开保持一致。 */
  videoKey: string;
  /** 用于导出与回看的页面地址（去掉追踪参数）。 */
  canonicalUrl: string;
}

export interface WebVideoIdentityOptions {
  /** Only enable when a real media element was discovered (home pages may host video). */
  allowRoot?: boolean;
  /** Use generic identity when a site adapter cannot provide its stronger identity. */
  allowAdapterFallback?: boolean;
  /** Known URL aliases are optional; never needed for generic discovery. */
  siteRules?: boolean;
}

const VIDEO_KEY_PARAMS = [
  'v', 'vi', 'video_id', 'vid', 'videos', 'id', 'video', 'videoid',
  'episode', 'episode_id', 'episodeid', 'ep', 'lesson', 'lesson_id', 'lessonid',
  'chapter', 'chapter_id', 'chapterid', 'course', 'course_id', 'courseid', 'part', 'p',
];

function contentParams(params: URLSearchParams): [string, string][] {
  return Array.from(params.entries())
    .filter(([name, value]) => VIDEO_KEY_PARAMS.includes(name.toLowerCase()) && value.trim() !== '')
    .sort(([a], [b]) => VIDEO_KEY_PARAMS.indexOf(a.toLowerCase()) - VIDEO_KEY_PARAMS.indexOf(b.toLowerCase()) || a.localeCompare(b));
}

/** Decode readable segments only; encoded delimiters must not become structural URL syntax. */
function readablePath(path: string): string {
  return path.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment).replace(/[%/\\?#]/g, (char) => encodeURIComponent(char));
    } catch {
      return segment;
    }
  }).join('/');
}

function trimPath(path: string): string {
  return path.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';
}

function keyQuery(params: [string, string][]): string {
  return params.length ? `?${params.map(([name, value]) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`).join('&')}` : '';
}

/** URL shape only, with opt-in root/adapter fallback after actual video discovery. */
export function deriveWebVideoIdentity(rawUrl: string, options: WebVideoIdentityOptions = {}): WebVideoIdentity | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
  if (!options.allowAdapterFallback && parseBilibiliVideoUrl(rawUrl)) return null;
  if (options.siteRules !== false) url = applyVideoSiteRules(url);

  const path = trimPath(url.pathname);
  const params = contentParams(url.searchParams);
  // Hash routes are content, unlike ordinary anchors or #t= playback positions.
  const hash = url.hash.replace(/^#!/, '#').slice(1);
  let route = '';
  let routeParams: [string, string][] = [];
  if (hash.startsWith('/')) {
    const separator = hash.indexOf('?');
    route = trimPath(separator < 0 ? hash : hash.slice(0, separator));
    routeParams = contentParams(new URLSearchParams(separator < 0 ? '' : hash.slice(separator + 1)));
  }
  if (path === '/' && !params.length && (!route || (route === '/' && !routeParams.length)) && !options.allowRoot) return null;
  const key = `${readablePath(path)}${keyQuery(params)}${route ? `#${readablePath(route)}${keyQuery(routeParams)}` : ''}`;

  // Set components on a trusted origin: decoded // or backslashes never get reparsed as a host.
  const canonical = new URL(url.origin);
  canonical.pathname = path;
  for (const [name, value] of params) canonical.searchParams.append(name, value);
  if (route) canonical.hash = `${route}${keyQuery(routeParams)}`;
  return { origin: url.origin, videoKey: boundedIdentity(key, 200), canonicalUrl: canonical.href };
}

/** 由页面上下文计算自动学习用的视频主键；B站走适配器主键，其余走通用主键。 */
export function videoIdOf(platform: VideoPlatform, values: { bvid?: string; cid?: string; origin?: string; videoKey?: string }): string | null {
  if (platform === 'bilibili') {
    if (!values.bvid || !values.cid) return null;
    return videoRecordId(values.bvid, values.cid);
  }
  if (!values.origin || !values.videoKey) return null;
  return webVideoRecordId(values.origin, values.videoKey);
}

/** 由应用自身构造回看链接（技术方案 3.5），绝不采用模型返回的链接。 */
export function buildWatchUrl(bvid: string, pageIndex: number, startMs: number): string {
  const page = pageIndex > 0 ? Math.floor(pageIndex) : 1;
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  return `https://www.bilibili.com/video/${bvid}/?p=${page}&t=${seconds}`;
}

/**
 * 统一回看链接：B站带分 P 与秒数；通用站点返回原始页面地址。
 * 通用站点不做 `?t=` 拼装——不同站点的秒数参数名不同，乱拼会得到无效链接。
 */
export function watchUrlFor(video: { platform: VideoPlatform; bvid: string; pageIndex: number; canonicalUrl: string }, startMs: number): string {
  if (video.platform === 'bilibili') return buildWatchUrl(video.bvid, video.pageIndex, startMs);
  return video.canonicalUrl || 'about:blank';
}

export interface PageBinding {
  tabId: number;
  /** 页面实例标识：站内导航后必须变化，防止旧响应写入新页面。 */
  documentEpoch: string;
  bvid: string;
  cid: string;
  pageIndex: number;
  /** Unified record identity takes precedence over the legacy Bilibili fields. */
  videoId?: string;
  frameId?: number;
}

export function isSameBinding(a: PageBinding, b: PageBinding): boolean {
  if (a.tabId !== b.tabId || a.documentEpoch !== b.documentEpoch || (a.frameId ?? 0) !== (b.frameId ?? 0)) return false;
  if (a.videoId || b.videoId) {
    const idA = a.videoId || (a.bvid && a.cid ? videoRecordId(a.bvid, a.cid) : '');
    const idB = b.videoId || (b.bvid && b.cid ? videoRecordId(b.bvid, b.cid) : '');
    return Boolean(idA && idA === idB);
  }
  return a.bvid === b.bvid && a.cid === b.cid;
}

/** 播放进度校验：有限数、非负、且在可用时长内。 */
export function sanitizeSeekMs(value: unknown, durationMs: number): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return null;
  if (Number.isFinite(durationMs) && durationMs > 0 && value > durationMs) return null;
  return Math.round(value);
}
