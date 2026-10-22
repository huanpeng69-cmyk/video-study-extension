/**
 * B站字幕适配器（技术方案第 3 节）。
 * - 只用固定域名与固定路径读取字幕元信息
 * - 字幕正文仅从白名单主机读取，未知主机直接拒绝
 * - 不读取、导出或存储 Cookie；请求是否携带登录态由浏览器自身决定
 */
import { appError, toAppError } from '../../domain/errors';
import { isAllowedSubtitleHost } from '../../domain/endpoint';
import { parseNativeSubtitleBody, type TranscriptParseResult } from '../../domain/transcript';
import { buildWatchUrl, type BilibiliPageInfo } from '../../domain/video';

export const PLAYER_INFO_ENDPOINT = 'https://api.bilibili.com/x/player/wbi/v2';

export interface SubtitleTrack {
  id: string;
  lan: string;
  lanDoc: string;
  url: string;
  aiStatus: number | null;
}

export interface SubtitleTrackList {
  tracks: SubtitleTrack[];
  needLogin: boolean;
}

interface PlayerInfoResponse {
  code?: number;
  message?: string;
  data?: {
    need_login_subtitle?: boolean;
    subtitle?: {
      subtitles?: Array<{
        id?: number | string;
        lan?: string;
        lan_doc?: string;
        subtitle_url?: string;
        ai_status?: number;
      }>;
    };
  };
}

function absoluteSubtitleUrl(raw: string): string {
  if (raw.startsWith('//')) return `https:${raw}`;
  return raw;
}

/**
 * 解析字幕轨道响应。
 * 关键区分：need_login_subtitle 与“列表为空”是两种状态，不能都报“无字幕”。
 */
export function parseTrackResponse(payload: unknown): SubtitleTrackList {
  const response = payload as PlayerInfoResponse | null;
  if (!response || typeof response !== 'object') {
    throw appError('SUBTITLE_UNKNOWN', '字幕信息响应结构无法识别');
  }
  if (typeof response.code === 'number' && response.code !== 0) {
    throw appError('SUBTITLE_UNKNOWN', '字幕信息接口返回错误', {
      detail: `code=${response.code}`,
      httpStatus: undefined,
    });
  }
  const needLogin = response.data?.need_login_subtitle === true;
  const rawList = response.data?.subtitle?.subtitles;
  const tracks: SubtitleTrack[] = [];
  if (Array.isArray(rawList)) {
    for (const item of rawList) {
      const url = typeof item.subtitle_url === 'string' ? absoluteSubtitleUrl(item.subtitle_url) : '';
      const lan = typeof item.lan === 'string' ? item.lan : '';
      if (!url || !lan) continue;
      tracks.push({
        id: String(item.id ?? lan),
        lan,
        lanDoc: typeof item.lan_doc === 'string' ? item.lan_doc : lan,
        url,
        aiStatus: typeof item.ai_status === 'number' ? item.ai_status : null,
      });
    }
  }
  return { tracks, needLogin };
}

/** 需要登录且没有可用轨道 → LOGIN_REQUIRED；确实没有轨道 → NO_SUBTITLE。 */
export function classifyTracks(list: SubtitleTrackList) {
  if (list.tracks.length > 0) return { kind: 'ok' as const, tracks: list.tracks };
  if (list.needLogin) return { kind: 'login' as const };
  return { kind: 'none' as const };
}

/** 构造字幕元信息请求：aid/cid 只作为数字参数，URL 其余部分固定。 */
export function buildPlayerInfoUrl(aid: string, cid: string): string {
  const params = new URLSearchParams({ aid, cid });
  return `${PLAYER_INFO_ENDPOINT}?${params.toString()}`;
}

/**
 * 读取字幕正文。只接受白名单主机，执行严格 HTTPS 与主机后缀校验。
 * 返回结构化的解析结果，包括被拒绝条目，便于 UI 明示。
 */
export async function fetchSubtitleBody(
  url: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 20_000,
): Promise<TranscriptParseResult> {
  if (!isAllowedSubtitleHost(url)) {
    throw appError('SUBTITLE_HOST_BLOCKED', '字幕来源域名不在允许列表内');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok) {
      throw appError('SUBTITLE_READ_FAILED', `字幕正文请求失败（HTTP ${response.status}）`);
    }
    const payload: unknown = await response.json();
    const body = (payload as { body?: unknown } | null)?.body;
    return parseNativeSubtitleBody(body);
  } catch (cause) {
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      throw appError('SUBTITLE_READ_FAILED', '字幕正文请求超时');
    }
    throw toAppError(cause, 'SUBTITLE_READ_FAILED', '字幕正文读取失败');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 把页面内的原始信息收敛为受信结构；任何缺失字段都视为尚未就绪，
 * 不生成不完整视频记录。
 */
export function normalizePageInfo(raw: unknown): BilibiliPageInfo | null {
  const record = raw as Record<string, unknown> | null;
  if (!record) return null;
  const bvid = typeof record.bvid === 'string' ? record.bvid : '';
  const cidRaw = record.cid;
  const aidRaw = record.aid;
  const cid = typeof cidRaw === 'string' ? cidRaw : typeof cidRaw === 'number' ? String(cidRaw) : '';
  const aid = typeof aidRaw === 'string' ? aidRaw : typeof aidRaw === 'number' ? String(aidRaw) : '';
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  const pageIndexRaw = record.pageIndex;
  const pageIndex =
    typeof pageIndexRaw === 'number' && Number.isInteger(pageIndexRaw) && pageIndexRaw > 0 ? pageIndexRaw : 1;
  const durationRaw = record.durationMs;
  const durationMs = typeof durationRaw === 'number' && Number.isFinite(durationRaw) && durationRaw >= 0 ? Math.round(durationRaw) : 0;
  if (!/^BV[0-9A-Za-z]{10}$/.test(bvid) || !cid || !aid || !title) return null;
  return {
    bvid,
    aid,
    cid,
    pageIndex,
    title: title.slice(0, 300),
    canonicalUrl: buildWatchUrl(bvid, pageIndex, 0),
    durationMs,
  };
}
