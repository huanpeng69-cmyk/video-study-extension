/**
 * 音频转写单元测试。
 *
 * 重点覆盖三件事（都是这次修复的实际风险点）：
 * 1. 段内相对时间必须加上分段偏移，否则字幕会全部挤在 0 秒。
 * 2. 主世界 postMessage 与后台消息是两套通道，事件必须按 channel 与 type 区分。
 * 3. HTTP 状态必须映射成可区分的错误码，不能都变成“转写失败”。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AUDIO_CHUNK,
  AUDIO_DONE,
  AUDIO_ERROR,
  AUDIO_PROGRESS,
  AUDIO_START,
  isAudioEventFor,
  makeAudioCancel,
  makeAudioStart,
} from '../src/asr/bridge-protocol';
import { buildTranscriptionUrl, mapAsrError, normalizeTranscription } from '../src/asr/client';
import { cuesFromAsrSegments } from '../src/domain/transcript';
import { base64ToBlob, fileNameForMime, isFatal } from '../src/asr/orchestrator';
import { extensionForMime, pickRecorderMime } from '../src/asr/extract';

describe('normalizeTranscription', () => {
  it('把段内秒级时间加上分段偏移转成绝对毫秒', () => {
    const result = normalizeTranscription(
      { text: 'hello world', language: 'en', segments: [{ start: 0.5, end: 1.25, text: 'hello' }] },
      60_000,
      10_000,
    );
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]?.startMs).toBe(60_500);
    expect(result.segments[0]?.endMs).toBe(61_250);
    expect(result.language).toBe('en');
  });

  it('缺少 segments 时退化为整段一条，用分段时长兜底', () => {
    const result = normalizeTranscription({ text: ' 整段文本 ' }, 30_000, 15_000);
    expect(result.segments).toHaveLength(1);
    expect(result.segments[0]).toEqual({ startMs: 30_000, endMs: 45_000, text: '整段文本' });
  });

  it('end 缺失或倒序时不会产生负区间', () => {
    const result = normalizeTranscription({ segments: [{ start: 2, text: 'x' }, { start: 5, end: 3, text: 'y' }] }, 0, 1000);
    expect(result.segments[0]).toEqual({ startMs: 2000, endMs: 2000, text: 'x' });
    expect(result.segments[1]).toEqual({ startMs: 5000, endMs: 5000, text: 'y' });
  });

  it('空响应抛错而不是返回空字幕', () => {
    expect(() => normalizeTranscription({ text: '   ' }, 0, 1000)).toThrowError(/转写返回为空/);
  });

  it('跳过无文本或无起始时间的条目', () => {
    const result = normalizeTranscription(
      { segments: [{ start: 1, end: 2, text: '  ' }, { end: 3, text: 'no start' }, { start: 4, end: 5, text: 'keep' }] },
      0,
      1000,
    );
    expect(result.segments.map((s) => s.text)).toEqual(['keep']);
  });
});

describe('mapAsrError', () => {
  it('区分鉴权、额度、缺失、过大、限流与服务端错误', () => {
    expect(mapAsrError(401, '').code).toBe('AUTH_FAILED');
    expect(mapAsrError(403, '').code).toBe('AUTH_FAILED');
    expect(mapAsrError(402, '').code).toBe('QUOTA_EXCEEDED');
    expect(mapAsrError(404, '').code).toBe('NOT_FOUND');
    expect(mapAsrError(413, '').code).toBe('TOO_LARGE');
    expect(mapAsrError(429, '').code).toBe('RATE_LIMITED');
    expect(mapAsrError(400, '').code).toBe('BAD_REQUEST');
    expect(mapAsrError(422, '').code).toBe('BAD_REQUEST');
    expect(mapAsrError(503, '').code).toBe('SERVER_ERROR');
  });

  it('脱敏 detail 中的 Bearer 令牌', () => {
    const error = mapAsrError(401, 'invalid Authorization: Bearer sk-abcdef123456');
    expect(error.detail).not.toContain('sk-abcdef123456');
    expect(error.detail).toContain('[redacted]');
  });

  it('鉴权与额度类错误被视为致命（不继续重试）', () => {
    expect(isFatal(mapAsrError(401, ''))).toBe(true);
    expect(isFatal(mapAsrError(402, ''))).toBe(true);
    expect(isFatal(mapAsrError(500, ''))).toBe(false);
  });
});

describe('buildTranscriptionUrl', () => {
  it('在基地址后追加固定 endpoint，不重复 /v1', () => {
    expect(buildTranscriptionUrl('https://apihub.agnes-ai.com/v1')).toBe(
      'https://apihub.agnes-ai.com/v1/audio/transcriptions',
    );
    expect(buildTranscriptionUrl('https://apihub.agnes-ai.com/v1/')).toBe(
      'https://apihub.agnes-ai.com/v1/audio/transcriptions',
    );
  });
});

describe('bridge-protocol', () => {
  it('只接受匹配 channel 且带 type 的事件', () => {
    const chunk = { type: AUDIO_CHUNK, channel: 'c1', index: 0, offsetMs: 0, durationMs: 1000, base64: 'AA==' };
    expect(isAudioEventFor(chunk, 'c1')).toBe(true);
    expect(isAudioEventFor(chunk, 'c2')).toBe(false);
    expect(isAudioEventFor({ channel: 'c1' }, 'c1')).toBe(false);
    expect(isAudioEventFor(null, 'c1')).toBe(false);
  });

  it('请求与事件类型不同，不会自我回环', () => {
    const start = makeAudioStart('c1', { chunkMs: 60_000 });
    const cancel = makeAudioCancel('c1');
    expect(start.type).toBe(AUDIO_START);
    expect(cancel.type).not.toBe(AUDIO_START);
    // 请求不应被当成任何一种事件类型。
    expect([AUDIO_CHUNK, AUDIO_PROGRESS, AUDIO_DONE, AUDIO_ERROR]).not.toContain(start.type);
  });
});

describe('cuesFromAsrSegments', () => {
  it('生成 asr 前缀的 cueId 并保持时间轴单调', () => {
    const cues = cuesFromAsrSegments([
      { startMs: 0, endMs: 2000, text: '第一句' },
      { startMs: 1500, endMs: 3000, text: '有重叠的第二句' },
    ]);
    expect(cues[0]?.cueId).toBe('asr-0');
    expect(cues[1]?.cueId).toBe('asr-1');
    // 第二条起点被抬到上一条结束处，避免重叠。
    expect(cues[1]?.startMs).toBe(2000);
    expect(cues[1]?.endMs).toBe(3000);
  });

  it('折叠空白并跳过空文本', () => {
    const cues = cuesFromAsrSegments([
      { startMs: 0, endMs: 1000, text: '  a   b  ' },
      { startMs: 1000, endMs: 2000, text: '   ' },
    ]);
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('a b');
  });

  it('全部为空时抛错，不产生空字幕', () => {
    expect(() => cuesFromAsrSegments([{ startMs: 0, endMs: 1, text: ' ' }])).toThrowError(/转写没有产生可用文本/);
  });
});

describe('音频编码辅助', () => {
  it('按 MIME 选择文件名扩展名', () => {
    expect(extensionForMime('audio/webm;codecs=opus')).toBe('webm');
    expect(extensionForMime('audio/ogg;codecs=opus')).toBe('ogg');
    expect(extensionForMime('audio/mp4')).toBe('mp4');
    expect(fileNameForMime('audio/webm', 7)).toBe('chunk-007.webm');
  });

  it('不支持 MediaRecorder 时返回空 MIME 而不是抛错', () => {
    vi.stubGlobal('MediaRecorder', undefined);
    expect(pickRecorderMime()).toBe('');
    vi.unstubAllGlobals();
  });

  it('base64 还原为同字节的 Blob', async () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const base64 = btoa(String.fromCharCode(...bytes));
    const blob = base64ToBlob(base64, 'audio/webm');
    expect(blob.type).toBe('audio/webm');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(bytes);
  });

  it('空 MIME 时退回 audio/webm 而不是产生无类型 Blob', () => {
    const blob = base64ToBlob(btoa('x'), '');
    expect(blob.type).toBe('audio/webm');
  });
});
