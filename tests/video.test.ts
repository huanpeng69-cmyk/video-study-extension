import { describe, expect, it } from 'vitest';
import { buildWatchUrl, deriveWebVideoIdentity, isSameBinding, parseBilibiliVideoUrl, sanitizeSeekMs, videoRecordId } from '../src/domain/video';

describe('视频身份', () => {
  it('只接受 B站普通视频页', () => {
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7')).toEqual({
      bvid: 'BV1GJ411x7h7',
      pageParam: null,
    });
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2')).toEqual({
      bvid: 'BV1GJ411x7h7',
      pageParam: 2,
    });
  });

  it('拒绝非 B站、非视频页与非法分 P', () => {
    expect(parseBilibiliVideoUrl('https://evil.example/video/BV1GJ411x7h7')).toBeNull();
    expect(parseBilibiliVideoUrl('http://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/bangumi/play/ep1')).toBeNull();
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=0')).toBeNull();
    expect(parseBilibiliVideoUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=abc')).toBeNull();
    expect(parseBilibiliVideoUrl('not a url')).toBeNull();
  });

  it('主键包含 cid，bvid 相同不同分 P 不会混淆', () => {
    expect(videoRecordId('BV1GJ411x7h7', '111')).toBe('bilibili:BV1GJ411x7h7:111');
    expect(videoRecordId('BV1GJ411x7h7', '222')).not.toBe(videoRecordId('BV1GJ411x7h7', '111'));
  });

  it('回看链接由应用构造，包含分 P 与秒数', () => {
    expect(buildWatchUrl('BV1GJ411x7h7', 2, 65_000)).toBe('https://www.bilibili.com/video/BV1GJ411x7h7/?p=2&t=65');
  });

  it('页面绑定必须同时匹配标签页、页面实例与视频', () => {
    const base = { tabId: 1, documentEpoch: 'a', bvid: 'BV1GJ411x7h7', cid: '111', pageIndex: 1 };
    expect(isSameBinding(base, { ...base })).toBe(true);
    expect(isSameBinding(base, { ...base, documentEpoch: 'b' })).toBe(false);
    expect(isSameBinding(base, { ...base, cid: '222' })).toBe(false);
  });

  it('跳转时间必须合法且不超出时长', () => {
    expect(sanitizeSeekMs(1500, 10_000)).toBe(1500);
    expect(sanitizeSeekMs(-1, 10_000)).toBeNull();
    expect(sanitizeSeekMs(11_000, 10_000)).toBeNull();
    expect(sanitizeSeekMs(Number.NaN, 10_000)).toBeNull();
    expect(sanitizeSeekMs('1000', 10_000)).toBeNull();
  });
});

describe('通用站点身份归一', () => {
  it('youtu.be 短链与 watch?v= 落到同一身份', () => {
    const short = deriveWebVideoIdentity('https://youtu.be/dQw4w9WgXcQ');
    const long = deriveWebVideoIdentity('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    expect(short).not.toBeNull();
    expect(long).not.toBeNull();
    expect(short?.origin).toBe('https://www.youtube.com');
    expect(short?.videoKey).toBe(long?.videoKey);
    expect(short?.canonicalUrl).toBe(long?.canonicalUrl);
  });

  it('m./music. 子域与主站落到同一身份', () => {
    const main = deriveWebVideoIdentity('https://www.youtube.com/watch?v=abc123');
    const mobile = deriveWebVideoIdentity('https://m.youtube.com/watch?v=abc123');
    const music = deriveWebVideoIdentity('https://music.youtube.com/watch?v=abc123');
    expect(mobile?.origin).toBe(main?.origin);
    expect(music?.origin).toBe(main?.origin);
    expect(mobile?.videoKey).toBe(main?.videoKey);
  });

  it('短链只接受单段 ID，不把频道页当视频', () => {
    expect(deriveWebVideoIdentity('https://youtu.be/')).toBeNull();
    // 多段路径不是短链形态，仍按普通路径处理，但不会误展开成 watch?v=。
    const channel = deriveWebVideoIdentity('https://youtu.be/user/abc');
    expect(channel?.videoKey).not.toContain('watch?v=');
  });

  it('站点首页与 B站页面不产生通用身份', () => {
    expect(deriveWebVideoIdentity('https://www.youtube.com/')).toBeNull();
    expect(deriveWebVideoIdentity('https://example.com/')).toBeNull();
    expect(deriveWebVideoIdentity('https://www.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
  });
});
