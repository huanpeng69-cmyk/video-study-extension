/**
 * 页内字幕轨道（通用层，不依赖任何站点接口）。
 *
 * 为什么走这条路径：站方字幕接口是平台专属能力，且常要求登录。
 * 通用做法是直接读取页面已经加载的 `<track>`：
 * - 若能拿到已解析的 `TextTrackCue`，直接转成 WebVTT 文本；
 * - 否则由内容脚本以页面身份取回字幕文件文本。
 * 两条路径最终都产出 WebVTT，交给既有的 `parseSubtitleText(text, 'vtt')` 统一校验，
 * 因此时间轴与无效条目处理规则和导入文件完全一致。
 */

export interface PageTrack {
  /** Opaque, document-local stable identity. A URL is never an authorization token. */
  id: string;
  /** 轨道地址（绝对 URL）；仅用于取回文本，不外发。 */
  url: string;
  /** 轨道标签，例如“中文（简体）”。 */
  label: string;
  /** 语言代码，可能为空。 */
  language: string;
  /** kind 属性：subtitles / captions 等。 */
  kind: string;
  /** 是否已由页面解析出 cue（此时无需再请求文件）。 */
  hasParsedCues: boolean;
}

export interface RawTrackCue {
  startTime: number;
  endTime: number;
  text: string;
}

/** 秒 → WebVTT 时间戳（hh:mm:ss.mmm）。 */
function toVttTimestamp(seconds: number): string {
  const total = Math.max(0, Math.round(seconds * 1000));
  const pad = (value: number, size = 2) => String(value).padStart(size, '0');
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const secs = Math.floor((total % 60_000) / 1000);
  const millis = total % 1000;
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}.${pad(millis, 3)}`;
}

/**
 * 把已解析的 cue 合成为 WebVTT。
 * 丢弃空文本与非正时长条目，保证下游「不静默接受无效数据」的既有约束。
 */
export function trackCuesToVttResult(cues: RawTrackCue[]): { text: string; rejected: number; warnings: string[] } {
  const lines = ['WEBVTT', ''];
  let index = 0;
  let rejected = 0;
  for (const cue of cues) {
    const text = typeof cue.text === 'string' ? cue.text.replace(/\u0000/g, '').replace(/\r\n?/g, '\n').trim() : '';
    const startMs = Math.round(cue.startTime * 1000);
    const endMs = Math.round(cue.endTime * 1000);
    if (!text || cue.startTime < 0 || !Number.isSafeInteger(startMs) || !Number.isSafeInteger(endMs) || endMs <= startMs) {
      rejected += 1;
      continue;
    }
    index += 1;
    // Blank lines inside a cue cannot create new, invented timing blocks when serialized.
    const body = text.replace(/\n(?:[\t ]*\n)+/g, '\n');
    lines.push(String(index), `${toVttTimestamp(cue.startTime)} --> ${toVttTimestamp(cue.endTime)}`, body, '');
  }
  return { text: lines.join('\n'), rejected, warnings: rejected ? [`已拒绝 ${rejected} 条时间或文本无效的字幕`] : [] };
}

export function trackCuesToVtt(cues: RawTrackCue[]): string {
  return trackCuesToVttResult(cues).text;
}

/** 从轨道列表里选一个默认轨道：优先中文字幕，其次第一条。 */
export function pickDefaultTrack<T extends { language: string; label: string }>(tracks: T[]): T | null {
  if (tracks.length === 0) return null;
  const chinese = tracks.find((track) => /^(zh|zh-|cmn|yue)/i.test(track.language) || /中文|简体|繁体/.test(track.label));
  return chinese ?? tracks[0] ?? null;
}

/**
 * 字幕候选排序（用于「优先使用视频已有字幕」）。
 *
 * 为什么要排序而不是直接用第一条：同一视频常同时有人工/官方字幕和自动生成字幕，
 * 自动字幕（YouTube 的 kind=asr、B站的 ai 字幕）错误明显更多。
 * 规则：人工/官方优先 → 目标语言优先 → 其余保持原顺序。
 */
export function rankCaptionTracks<T extends { language: string; label: string; kind?: string; generationKind?: string }>(
  tracks: T[],
  preferredLanguage = 'zh',
): T[] {
  const score = (track: T): number => {
    const language = (track.language || '').toLowerCase();
    const label = track.label || '';
    const kind = (track.kind || '').toLowerCase();
    const generation = (track.generationKind || '').toLowerCase();
    const isAutoKind = kind === 'asr' || generation === 'ai';
    const isAutoLabel = /自动生成|auto-?generated|自动翻译/i.test(label);
    // 人工/官方 = 0 分档，自动生成 = 1 分档。
    const kindRank = isAutoKind || isAutoLabel ? 1 : 0;
    const languageRank = language.startsWith(preferredLanguage) ||
      (preferredLanguage === 'zh' && /中文|简体|繁体/.test(label)) ? 0 : 1;
    return kindRank * 2 + languageRank;
  };
  // 稳定排序：同分保持站点给出的原始顺序。
  return tracks
    .map((track, index) => ({ track, index, score: score(track) }))
    .sort((a, b) => (a.score - b.score) || (a.index - b.index))
    .map((item) => item.track);
}
