import { describe, expect, it } from 'vitest';
import { deriveWebVideoIdentity, videoIdOf, watchUrlFor, webVideoRecordId } from '../src/domain/video';
import { pickDefaultTrack, trackCuesToVtt } from '../src/domain/page-tracks';

describe('通用视频身份（不依赖平台接口）', () => {
  it('用路径与视频参数推导稳定键，忽略追踪参数', () => {
    const first = deriveWebVideoIdentity('https://example.com/watch?v=abc123&t=42&utm_source=x');
    const second = deriveWebVideoIdentity('https://example.com/watch?v=abc123&t=999');
    expect(first).not.toBeNull();
    expect(first?.origin).toBe('https://example.com');
    expect(first?.videoKey).toBe('/watch?v=abc123');
    expect(first?.videoKey).toBe(second?.videoKey);
    expect(first?.canonicalUrl).toBe('https://example.com/watch?v=abc123');
  });

  it('路径式视频页按路径区分，尾斜线不影响身份', () => {
    const plain = deriveWebVideoIdentity('https://courses.example.org/lesson/42/');
    const noSlash = deriveWebVideoIdentity('https://courses.example.org/lesson/42');
    expect(plain?.videoKey).toBe('/lesson/42');
    expect(plain?.videoKey).toBe(noSlash?.videoKey);
    expect(deriveWebVideoIdentity('https://courses.example.org/lesson/43')?.videoKey).not.toBe(plain?.videoKey);
  });

  it('不同站点即便路径相同也是不同视频', () => {
    expect(deriveWebVideoIdentity('https://a.example.com/v/1')?.origin).not.toBe(
      deriveWebVideoIdentity('https://b.example.com/v/1')?.origin,
    );
  });

  it.each([
    'https://example.com/',
    'https://example.com',
    'ftp://example.com/video/1',
    'javascript:alert(1)',
    'not a url',
    'https://user:pass@example.com/v/1',
  ])('不把这类地址当作视频页：%s', (url) => {
    expect(deriveWebVideoIdentity(url)).toBeNull();
  });

  it('B站地址交给适配器，不产生第二套主键', () => {
    expect(deriveWebVideoIdentity('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
  });

  it('超长路径被截断，主键长度有界', () => {
    const long = `https://example.com/${'a'.repeat(500)}`;
    expect((deriveWebVideoIdentity(long)?.videoKey ?? '').length).toBeLessThanOrEqual(200);
  });

  it('主键带平台前缀且与源、键一一对应', () => {
    const id = webVideoRecordId('https://example.com', '/watch?v=1');
    expect(id.startsWith('web:')).toBe(true);
    expect(id).not.toBe(webVideoRecordId('https://example.com', '/watch?v=2'));
    expect(id).not.toBe(webVideoRecordId('https://other.com', '/watch?v=1'));
    expect(webVideoRecordId('https://example.com', 'k'.repeat(500)).length).toBeLessThanOrEqual(330);
  });

  it('videoIdOf 按平台要求字段，缺字段不猜', () => {
    expect(videoIdOf('bilibili', { bvid: 'BV1GJ411x7h7', cid: '111' })).toBe('bilibili:BV1GJ411x7h7:111');
    expect(videoIdOf('bilibili', { bvid: 'BV1GJ411x7h7' })).toBeNull();
    expect(videoIdOf('web', { origin: 'https://example.com', videoKey: '/v/1' })).toBe('web:https://example.com:/v/1');
    expect(videoIdOf('web', { videoKey: '/v/1' })).toBeNull();
  });
});

describe('回看链接', () => {
  const bilibili = { platform: 'bilibili' as const, bvid: 'BV1GJ411x7h7', pageIndex: 2, canonicalUrl: 'x' };
  const web = { platform: 'web' as const, bvid: '/watch?v=1', pageIndex: 1, canonicalUrl: 'https://example.com/watch?v=1' };

  it('B站保留分 P 与秒数', () => {
    expect(watchUrlFor(bilibili, 65_000)).toBe('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=65');
  });

  it('通用站点返回原页面地址，不拼可能无效的秒数参数', () => {
    expect(watchUrlFor(web, 65_000)).toBe('https://example.com/watch?v=1');
  });
});

describe('页内字幕（通用层）', () => {
  it('已解析 cue 转成 WebVTT，时间戳补齐到毫秒', () => {
    const vtt = trackCuesToVtt([
      { startTime: 0, endTime: 1.5, text: '第一句' },
      { startTime: 61.25, endTime: 63, text: '第二句' },
    ]);
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    expect(vtt).toContain('00:00:00.000 --> 00:00:01.500');
    expect(vtt).toContain('00:01:01.250 --> 00:01:03.000');
    expect(vtt).toContain('第一句');
  });

  it('空文本、非法时间与非正时长被丢弃，不伪造条目', () => {
    const vtt = trackCuesToVtt([
      { startTime: 0, endTime: 1, text: '   ' },
      { startTime: 2, endTime: 2, text: '零时长' },
      { startTime: Number.NaN, endTime: 6, text: '非法' },
      { startTime: 5, endTime: 4, text: '反向' },
      { startTime: 7, endTime: 8, text: '有效' },
    ]);
    expect(vtt).toContain('有效');
    expect(vtt).not.toContain('零时长');
    expect(vtt).not.toContain('反向');
    expect(vtt).not.toContain('非法');
    // 只有一条有效条目，因此只应有 1 个序号
    expect(vtt.match(/^1$/m)).not.toBeNull();
    expect(vtt).not.toMatch(/^2$/m);
  });

  it('默认轨道优先中文，其次第一条', () => {
    const tracks = [
      { url: 'a', label: 'English', language: 'en', kind: 'subtitles', hasParsedCues: false },
      { url: 'b', label: '中文（简体）', language: 'zh-CN', kind: 'subtitles', hasParsedCues: true },
    ];
    expect(pickDefaultTrack(tracks)?.url).toBe('b');
    expect(pickDefaultTrack([tracks[0]!])?.url).toBe('a');
    expect(pickDefaultTrack([])).toBeNull();
  });
});
