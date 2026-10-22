import { describe, expect, it } from 'vitest';
import {
  MAX_CUES,
  formatTimecode,
  hashTranscript,
  inferGenerationKind,
  parseNativeSubtitleBody,
  parseSubtitleText,
  parseTimestamp,
} from '../src/domain/transcript';

const srt = [
  '1',
  '00:00:01,000 --> 00:00:03,500',
  '第一行',
  '第二行',
  '',
  '2',
  '00:00:04,000 --> 00:00:06,000',
  '第二条',
].join('\r\n');

const vtt = [
  'WEBVTT',
  '',
  'NOTE 这是注释，不应被当成字幕',
  '',
  'cue-1',
  '00:01.000 --> 00:03.000 align:start position:0%',
  'hello',
].join('\n');

describe('字幕解析', () => {
  it('解析毫秒、逗号小数点与多小时时间', () => {
    expect(parseTimestamp('00:01.000')).toBe(1000);
    expect(parseTimestamp('00:00:01,250')).toBe(1250);
    expect(parseTimestamp('01:02:03.500')).toBe(((1 * 60 + 2) * 60 + 3) * 1000 + 500);
    expect(parseTimestamp('00:99:00')).toBeNull();
    expect(parseTimestamp('abc')).toBeNull();
  });

  it('SRT 支持 CRLF 与多行正文', () => {
    const result = parseSubtitleText(srt, 'srt');
    expect(result.cues).toHaveLength(2);
    expect(result.cues[0]?.text).toBe('第一行\n第二行');
    expect(result.cues[0]?.startMs).toBe(1000);
    expect(result.cues[0]?.endMs).toBe(3500);
    expect(result.rejected).toBe(0);
  });

  it('VTT 跳过 WEBVTT 头与 NOTE 控制块', () => {
    const result = parseSubtitleText(vtt, 'vtt');
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.text).toBe('hello');
    expect(result.cues[0]?.startMs).toBe(1000);
  });

  it('无效条目被拒绝而不是静默丢弃后声称成功', () => {
    const broken = ['1', '00:00:05,000 --> 00:00:02,000', '逆序时间', '', '2', '00:00:06,000 --> 00:00:07,000', '有效'].join('\n');
    const result = parseSubtitleText(broken, 'srt');
    expect(result.cues).toHaveLength(1);
    expect(result.rejected).toBe(1);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('完全不可解析时抛出明确错误', () => {
    expect(() => parseSubtitleText('完全不是字幕', 'srt')).toThrowError(/未解析到任何有效字幕条目/);
    expect(() => parseSubtitleText('   ', 'srt')).toThrowError(/字幕文件为空/);
  });

  it('B站原始正文解析为毫秒时间轴', () => {
    const result = parseNativeSubtitleBody([
      { from: 1.5, to: 3.25, content: '你好&lt;br&gt;世界' },
      { from: 3, to: 2, content: '无效' },
    ]);
    expect(result.cues).toHaveLength(1);
    expect(result.cues[0]?.startMs).toBe(1500);
    expect(result.cues[0]?.endMs).toBe(3250);
    expect(result.cues[0]?.text).toBe('你好\n世界');
    expect(result.rejected).toBe(1);
  });

  it('超出条目上限时明确拒绝', () => {
    const body = Array.from({ length: MAX_CUES + 1 }, (_, index) => ({
      from: index,
      to: index + 1,
      content: 'x',
    }));
    expect(() => parseNativeSubtitleBody(body)).toThrowError(/超过上限/);
  });

  it('相同内容哈希稳定，内容变化则哈希变化', () => {
    const first = parseSubtitleText(srt, 'srt').cues;
    const second = parseSubtitleText(srt, 'srt').cues;
    expect(hashTranscript(first)).toBe(hashTranscript(second));
    const changed = [...first];
    changed[0] = { ...changed[0]!, text: '改动' };
    expect(hashTranscript(changed)).not.toBe(hashTranscript(first));
  });

  it('无法判断字幕来源时标记 unknown，不凭轨道名猜测', () => {
    expect(inferGenerationKind('中文（中国）')).toBe('unknown');
    expect(inferGenerationKind('AI 生成')).toBe('ai');
    expect(inferGenerationKind('人工字幕')).toBe('human');
    expect(inferGenerationKind(undefined)).toBe('unknown');
  });

  it('时间码格式化', () => {
    expect(formatTimecode(65_000)).toBe('01:05');
    expect(formatTimecode(3_725_000)).toBe('1:02:05');
  });
});
