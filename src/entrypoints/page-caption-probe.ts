/**
 * 主世界字幕探针（按需注入，MAIN world）。
 *
 * 为什么需要它：YouTube 等站点不用 `<track>`，字幕清单只存在于页面脚本的
 * 全局对象里（`ytInitialPlayerResponse`）。隔离世界读不到该全局，因此必须由
 * 主世界读取后经 `window.postMessage` 交回隔离世界的页面脚本。
 *
 * 只做两件事：报告字幕轨道清单、按请求取回某条轨道文本。
 * 不读取播放流、不读 Cookie、不接触任何鉴权字段。
 */
import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { parseYouTubeCaptionTracks } from '../domain/captions';

const CHANNEL = 'video-study-caption-probe';

interface ProbeRequest {
  source?: string;
  type?: string;
  requestId?: string;
  url?: string;
}

function readGlobals(): unknown[] {
  const scope = globalThis as unknown as Record<string, unknown>;
  const values: unknown[] = [];
  // 站点会随版本改名，按常见位置逐个探测；命中即止。
  for (const key of ['ytInitialPlayerResponse', 'playerResponse']) {
    const value = scope[key];
    if (value) values.push(value);
  }
  const player = scope.ytplayer as Record<string, unknown> | undefined;
  const args = player?.config as Record<string, unknown> | undefined;
  const inner = args?.args as Record<string, unknown> | undefined;
  for (const value of [inner?.player_response, args?.player_response]) {
    if (value) values.push(value);
  }
  const data = scope.__INITIAL_STATE__ as Record<string, unknown> | undefined;
  if (data) values.push(data);
  return values;
}

/**
 * 优先请求 JSON3 字幕格式：站点默认返回 XML timedtext，JSON3 少一层容错。
 * 只改写 `fmt` 参数，其余查询参数原样保留；失败时下游仍会按 XML 归一兜底。
 */
function withPreferredFormat(raw: string): string {
  try {
    const url = new URL(raw);
    url.searchParams.set('fmt', 'json3');
    return url.toString();
  } catch {
    return raw;
  }
}

export function load(): void {
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope.__videoStudyCaptionProbe) return;
  scope.__videoStudyCaptionProbe = true;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as ProbeRequest | null;
    if (!data || data.source !== CHANNEL || typeof data.requestId !== 'string') return;

    if (data.type === 'tracks') {
      const tracks = readGlobals().flatMap((value) => parseYouTubeCaptionTracks(value));
      // 去重后回报；没有字幕就如实回空数组。
      const seen = new Set<string>();
      const unique = tracks.filter((track) => {
        if (seen.has(track.url)) return false;
        seen.add(track.url);
        return true;
      });
      window.postMessage({ source: CHANNEL, type: 'tracks', requestId: data.requestId, tracks: unique }, window.location.origin);
      return;
    }

    if (data.type === 'read' && typeof data.url === 'string') {
      // 站点常默认返回 XML timedtext；显式请求 JSON3 更省解析，失败再由下游归一兜底。
      const url = withPreferredFormat(data.url);
      void (async () => {
        try {
          const response = await fetch(url, { credentials: 'same-origin' });
          if (!response.ok) {
            window.postMessage({ source: CHANNEL, type: 'read', requestId: data.requestId, ok: false, reason: `字幕请求失败（HTTP ${response.status}）` }, window.location.origin);
            return;
          }
          const buffer = await response.arrayBuffer();
          if (buffer.byteLength > 2 * 1024 * 1024) {
            window.postMessage({ source: CHANNEL, type: 'read', requestId: data.requestId, ok: false, reason: '字幕文件超过 2 MB' }, window.location.origin);
            return;
          }
          window.postMessage({
            source: CHANNEL, type: 'read', requestId: data.requestId, ok: true,
            text: new TextDecoder('utf-8').decode(buffer),
          }, window.location.origin);
        } catch (cause) {
          window.postMessage({
            source: CHANNEL, type: 'read', requestId: data.requestId, ok: false,
            reason: `字幕读取失败：${cause instanceof Error ? cause.message : '未知原因'}`,
          }, window.location.origin);
        }
      })();
    }
  });
}

export default defineUnlistedScript(load);
