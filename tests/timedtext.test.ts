import { describe, expect, it } from 'vitest';
import { parseJson3Captions, parseTimedText } from '../src/domain/timedtext';
import { parseSubtitleText } from '../src/domain/transcript';
import { trackCuesToVtt } from '../src/domain/page-tracks';

describe('XML timedtext 解析', () => {
  it('解析 v1/v2 的 <text start dur>', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<transcript>
  <text start="0.5" dur="1.25">第一句</text>
  <text start="1.75" dur="2">第二句</text>
</transcript>`;
    const result = parseTimedText(xml);
    expect(result?.cues).toEqual([
      { startTime: 0.5, endTime: 1.75, text: '第一句' },
      { startTime: 1.75, endTime: 3.75, text: '第二句' },
    ]);
    expect(result?.rejected).toBe(0);
  });

  it('解析 srv3 的 <p t d>（毫秒）并解出内嵌 <s> 文本', () => {
    const xml = `<timedtext format="3"><body>
  <p t="500" d="1200"><s>你好</s></p>
  <p t="1700" d="800"><s>世界</s></p>
</body></timedtext>`;
    const result = parseTimedText(xml);
    expect(result?.cues).toEqual([
      { startTime: 0.5, endTime: 1.7, text: '你好' },
      { startTime: 1.7, endTime: 2.5, text: '世界' },
    ]);
  });

  it('解码实体，并把转义的 <br> 变成换行', () => {
    const xml = '<transcript><text start="0" dur="1">A &amp; B&lt;br&gt;C</text></transcript>';
    const result = parseTimedText(xml);
    expect(result?.cues[0]?.text).toBe('A & B\nC');
  });

  it('缺时长时用下一条真实起点收尾；末条无时长则丢弃并计入 rejected', () => {
    const xml = '<transcript><text start="0">甲</text><text start="2">乙</text></transcript>';
    const result = parseTimedText(xml);
    expect(result?.cues).toEqual([{ startTime: 0, endTime: 2, text: '甲' }]);
    expect(result?.rejected).toBe(1);
  });

  it('不是 XML timedtext 时返回 null，不误判普通字幕', () => {
    expect(parseTimedText('WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n你好')).toBeNull();
    expect(parseTimedText('1\n00:00:00,000 --> 00:00:01,000\n你好')).toBeNull();
  });
});

describe('JSON3 字幕解析', () => {
  it('拼接 segs 并换算毫秒', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: '你' }, { utf8: '好' }] },
        { tStartMs: 1500, dDurationMs: 500, segs: [{ utf8: '世界' }] },
      ],
    });
    const result = parseJson3Captions(json);
    expect(result?.cues).toEqual([
      { startTime: 0, endTime: 1.5, text: '你好' },
      { startTime: 1.5, endTime: 2, text: '世界' },
    ]);
  });

  it('跳过空文本事件，缺时长用下一条起点收尾', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, segs: [{ utf8: '\n' }] },
        { tStartMs: 100, segs: [{ utf8: '甲' }] },
        { tStartMs: 900, dDurationMs: 100, segs: [{ utf8: '乙' }] },
      ],
    });
    const result = parseJson3Captions(json);
    expect(result?.cues).toEqual([
      { startTime: 0.1, endTime: 0.9, text: '甲' },
      { startTime: 0.9, endTime: 1, text: '乙' },
    ]);
    expect(result?.rejected).toBe(1);
  });

  it('非 JSON3 返回 null', () => {
    expect(parseJson3Captions('WEBVTT')).toBeNull();
    expect(parseJson3Captions('{"foo":1}')).toBeNull();
    expect(parseJson3Captions('{ 不是 json')).toBeNull();
  });
});

describe('回归：YouTube 字幕能真正落成 cue', () => {
  // 修复前的真实缺陷：轨道能列出来，但 baseUrl 默认返回 XML timedtext，
  // 下游只按 VTT 解析 → 0 条。这里把整条链路钉死。
  it('XML timedtext 经归一后产出可解析的 WebVTT', () => {
    const xml = '<transcript><text start="0" dur="2">第一句</text><text start="2" dur="2">第二句</text></transcript>';
    const converted = parseTimedText(xml);
    expect(converted).not.toBeNull();
    const vtt = trackCuesToVtt(converted!.cues);
    const parsed = parseSubtitleText(vtt, 'vtt');
    expect(parsed.cues).toHaveLength(2);
    expect(parsed.cues[0]?.text).toBe('第一句');
    expect(parsed.cues[1]?.startMs).toBe(2000);
  });

  it('JSON3 经归一后同样产出可解析的 WebVTT', () => {
    const json = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: '第一句' }] }] });
    const converted = parseJson3Captions(json);
    const parsed = parseSubtitleText(trackCuesToVtt(converted!.cues), 'vtt');
    expect(parsed.cues).toHaveLength(1);
    expect(parsed.cues[0]?.endMs).toBe(2000);
  });
});
