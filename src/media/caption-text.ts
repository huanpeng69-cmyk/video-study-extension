import { trackCuesToVttResult, type RawTrackCue } from '../domain/page-tracks';
import { parseJson3Captions, parseTimedText } from '../domain/timedtext';
import { parseSubtitleText } from '../domain/transcript';

export type TrackTextResult = { ok: true; text: string; warnings: string[] } | { ok: false; reason: string };

function validate(text: string, warnings: string[] = []): TrackTextResult {
  try {
    // SRT is accepted by the existing parser as well; keep its original text and format.
    const parsed = parseSubtitleText(text, /^\uFEFF?WEBVTT(?:\s|$)/.test(text) || /^WEBVTT(?:\s|$)/.test(text) ? 'vtt' : 'srt');
    // Parser warnings can contain source lines / signed URLs. Report counts, not untrusted excerpts.
    if (parsed.rejected) warnings.push(`原格式解析已拒绝 ${parsed.rejected} 条无效字幕`);
    if (parsed.warnings.length > parsed.rejected) warnings.push('字幕存在重叠、逆序或其他格式警告');
    return { ok: true, text, warnings };
  } catch {
    return { ok: false, reason: '字幕解析失败：没有有效条目，或时间轴/大小超出支持范围' };
  }
}

export function normalizeTrackCues(cues: RawTrackCue[]): TrackTextResult {
  const result = trackCuesToVttResult(cues);
  return validate(result.text, result.warnings);
}

/** Header/structure detection, never `text.includes('-->')` (XML comments contain that too). */
export function normalizePageTrackText(raw: string): TrackTextResult {
  const text = raw.replace(/^\uFEFF/, '');
  const converted = parseJson3Captions(text) ?? parseTimedText(text);
  if (converted?.error) return { ok: false, reason: converted.error };
  if (converted) {
    if (!converted.cues.length) return { ok: false, reason: `字幕没有有效条目（已拒绝 ${converted.rejected} 条）` };
    const serialized = trackCuesToVttResult(converted.cues);
    const warnings = [...serialized.warnings];
    if (converted.rejected) warnings.push(`格式转换已拒绝 ${converted.rejected} 条时间或文本无效的字幕`);
    return validate(serialized.text, warnings);
  }
  // Unknown formats go through the existing parser, not a made-up conversion. Even a valid
  // XML/JSON wrapper containing VTT-looking lines must not be accepted as a subtitle file.
  const result = validate(text);
  return /^[\s]*[<{[]/.test(text) && result.ok
    ? { ok: false, reason: '字幕格式无法识别，不是受支持的 WebVTT/SRT/XML timedtext/JSON3' }
    : result;
}
