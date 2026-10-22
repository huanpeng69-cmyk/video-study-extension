import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeLocalSegments } from '../src/asr/local-whisper';

afterEach(() => vi.restoreAllMocks());

const payload = (segments: unknown[]) => ({ segments });

describe('本地 Whisper 时间戳边界', () => {
  it('最后一句略超出墙钟估算时仍接受（真实语音，不是越界）', () => {
    // 30 秒片段，Whisper 因容器预填充给出到尾 30.4 秒。
    const result = normalizeLocalSegments(payload([
      { start: 0.2, end: 5.1, text: '第一句' },
      { start: 29.5, end: 30.4, text: '最后一句' },
    ]), 60_000, 30_000);
    expect(result.map((item) => item.text)).toEqual(['第一句', '最后一句']);
    // 绝对时间轴 = 分片偏移 + 片内时间。
    expect(result[1]).toMatchObject({ startMs: 89_500, endMs: 90_400 });
  });

  it('稍超出的结束时间被夹到本片上限，不越界到下一片', () => {
    const result = normalizeLocalSegments(payload([
      { start: 12, end: 30.4, text: '跨到尾' },
    ]), 0, 30_000);
    expect(result[0]!.endMs).toBeLessThanOrEqual(31_500);
  });

  it('明显越界仍然整片失败，不写入错误字幕', () => {
    expect(() => normalizeLocalSegments(payload([
      { start: 0, end: 5, text: 'ok' },
      { start: 40, end: 50, text: '错片' },
    ]), 0, 30_000)).toThrowError(/超出实际录音片段/);
  });

  it('倒序、负值、非数字与空文本的判定不变', () => {
    expect(() => normalizeLocalSegments(payload([{ start: 5, end: 4, text: '倒序' }]), 0, 30_000))
      .toThrowError(/无效时间戳或文本/);
    expect(() => normalizeLocalSegments(payload([{ start: -1, end: 4, text: '负值' }]), 0, 30_000))
      .toThrowError(/无效时间戳或文本/);
    expect(() => normalizeLocalSegments(payload([{ start: '0', end: 4, text: '字符串' }]), 0, 30_000))
      .toThrowError(/无效时间戳或文本/);
    // 空文本条目被跳过，而不是报错；全部为空时返回空数组。
    expect(normalizeLocalSegments(payload([{ start: 0, end: 1, text: '   ' }]), 0, 30_000)).toEqual([]);
  });

  it('有文本却没有分段时明确失败，不补造时间戳', () => {
    expect(() => normalizeLocalSegments({ text: '只有文字' }, 0, 30_000))
      .toThrowError(/缺少真实分段时间戳/);
  });
});
