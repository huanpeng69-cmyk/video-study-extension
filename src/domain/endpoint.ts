/**
 * 对外部 URL 的严格校验与按需权限（技术方案 4.3）。
 * 关键：模型 Base URL 与字幕 CDN 都用 URL 解析后的 hostname 边界判断，不用字符串 contains。
 */
import { appError } from './errors';

/** 可信的字幕 CDN 候选：仅接受这些后缀，具体域名由真实样本再核对。 */
export const SUBTITLE_HOST_SUFFIXES = ['hdslb.com', 'bilibili.com'] as const;

export function isAllowedSubtitleHost(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  return matchesSuffix(url.hostname, SUBTITLE_HOST_SUFFIXES);
}

function matchesSuffix(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export interface NormalizedEndpoint {
  /** 规范化后的基地址，保留用户路径前缀，不含尾斜线。 */
  baseUrl: string;
  /** 实际请求地址，始终显示给用户确认。 */
  requestUrl: string;
  origin: string;
  hostPermissionPattern: string;
}

/**
 * 只接受 HTTPS 基地址；拒绝凭据、query、fragment。
 * 规则（技术方案 4.3 第 2–3 条）：去掉尾部斜线后追加固定 endpoint，不再补 /v1。
 */
export function normalizeEndpoint(baseUrlInput: string): NormalizedEndpoint {
  const trimmed = baseUrlInput.trim();
  if (!trimmed) throw appError('PROVIDER_NOT_CONFIGURED', '请填写 API 基地址');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw appError('BAD_REQUEST', 'API 基地址不是合法 URL');
  }
  if (url.protocol !== 'https:') throw appError('BAD_REQUEST', 'API 基地址必须使用 HTTPS');
  if (url.username || url.password) throw appError('BAD_REQUEST', 'API 基地址不能包含账号或密码');
  if (url.search || url.hash) throw appError('BAD_REQUEST', 'API 基地址不能包含查询参数或片段');
  if (!url.hostname) throw appError('BAD_REQUEST', 'API 基地址缺少主机名');

  const path = url.pathname.replace(/\/+$/, '');
  const baseUrl = `${url.origin}${path}`;
  if (/\/chat\/completions$/i.test(path)) {
    throw appError('BAD_REQUEST', '请填写基地址，不要包含 /chat/completions');
  }
  return {
    baseUrl,
    requestUrl: `${baseUrl}/chat/completions`,
    origin: url.origin,
    hostPermissionPattern: `${url.protocol}//${url.hostname}/*`,
  };
}

/** 预置 Agnes 的官方文档值；模型 ID 由用户确认实际可用性。 */
export const AGNES_PRESET = {
  name: 'Agnes APIHub',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  modelId: 'agnes-2.5-flash',
} as const;

export const SUBTITLE_SOURCE_HOSTS_NOTE =
  '字幕正文只从已审核的 B站域名读取；未知主机直接报错并提示导入文件。';
