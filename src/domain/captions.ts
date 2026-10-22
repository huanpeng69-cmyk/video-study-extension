/**
 * 站点自有字幕数据的解析（纯函数，便于测试）。
 *
 * 背景：YouTube 这类站点不使用 `<track>` 元素，字幕清单放在页面脚本文本里
 * （`ytInitialPlayerResponse` / `ytplayer.config.args.player_response`）。
 * 该对象只在页面主世界可见，因此由主世界探针取回后再交给这里解析。
 *
 * 约束：只读取「字幕轨道清单」，不解析视频流、不碰鉴权字段；
 * 轨道地址仅用于取回字幕文本，不外发。
 */
import type { PageTrack } from './page-tracks';

interface CaptionTrackNode {
  baseUrl?: unknown;
  name?: unknown;
  languageCode?: unknown;
  kind?: unknown;
  vssId?: unknown;
}

/** 从 `{simpleText}` / `{runs:[{text}]}` 这类 YouTube 文本节点里取纯文本。 */
function readText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (!node || typeof node !== 'object') return '';
  const record = node as Record<string, unknown>;
  if (typeof record.simpleText === 'string') return record.simpleText;
  const runs = record.runs;
  if (Array.isArray(runs)) {
    return runs
      .map((run) => (run && typeof run === 'object' && typeof (run as { text?: unknown }).text === 'string'
        ? (run as { text: string }).text
        : ''))
      .join('');
  }
  return '';
}

/**
 * 解析 YouTube 播放器响应里的字幕清单。
 * 输入可以是 playerResponse 本身，也可以是外包一层 `args` 的对象。
 * 无法识别时返回空数组——绝不编造轨道。
 */
export function parseYouTubeCaptionTracks(input: unknown, depth = 0): PageTrack[] {
  if (depth > 6 || !input) return [];
  if (typeof input === 'string') {
    if (input.length > 2 * 1024 * 1024) return [];
    try {
      return parseYouTubeCaptionTracks(JSON.parse(input), depth + 1);
    } catch {
      return [];
    }
  }
  if (typeof input !== 'object') return [];
  const record = input as Record<string, unknown>;

  const list = (record.captions as Record<string, unknown> | undefined)
    ?.playerCaptionsTracklistRenderer as Record<string, unknown> | undefined;
  const rawTracks = list?.captionTracks;
  if (Array.isArray(rawTracks)) {
    const tracks: PageTrack[] = [];
    const seen = new Set<string>();
    const identities = new Map<string, number>();
    for (const raw of rawTracks.slice(0, 200)) {
      const node = raw as CaptionTrackNode | null;
      const url = typeof node?.baseUrl === 'string' ? node.baseUrl : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const label = readText(node?.name).trim() || (typeof node?.languageCode === 'string' ? node.languageCode : '');
      const language = typeof node?.languageCode === 'string' ? node.languageCode : '';
      const kind = typeof node?.kind === 'string' && node.kind ? node.kind : 'subtitles';
      // Metadata/vssId identifies a track, not its expiring/signed address.
      const identity = typeof node?.vssId === 'string' && node.vssId
        ? node.vssId : `${language}:${kind}:${label}`;
      const occurrence = (identities.get(identity) ?? 0) + 1;
      identities.set(identity, occurrence);
      tracks.push({
        id: `yt:${encodeURIComponent(identity.slice(0, 160))}:${occurrence}`,
        url,
        label: label.slice(0, 120) || '字幕',
        language,
        // kind === 'asr' 表示自动生成字幕，界面上要能区分。
        kind,
        hasParsedCues: false,
      });
    }
    return tracks;
  }

  // 兼容 `{args: {player_response: "<json 字符串>"}}` 这种旧结构。
  for (const key of ['args', 'player_response', 'playerResponse', 'ytInitialPlayerResponse']) {
    const tracks = parseYouTubeCaptionTracks(record[key], depth + 1);
    if (tracks.length > 0) return tracks;
  }
  return [];
}
