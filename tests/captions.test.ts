import { describe, expect, it } from 'vitest';
import { parseYouTubeCaptionTracks } from '../src/domain/captions';
import { deriveWebVideoIdentity } from '../src/domain/video';

const playerResponse = {
  captions: {
    playerCaptionsTracklistRenderer: {
      captionTracks: [
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh', name: { simpleText: '中文（简体）' }, languageCode: 'zh' },
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=en', name: { runs: [{ text: 'English' }, { text: ' (auto)' }] }, languageCode: 'en', kind: 'asr' },
        // 重复地址要去重，空地址要跳过。
        { baseUrl: 'https://www.youtube.com/api/timedtext?v=abc&lang=zh', name: { simpleText: '中文（简体）' }, languageCode: 'zh' },
        { name: { simpleText: '没有地址' }, languageCode: 'ja' },
      ],
    },
  },
};

describe('YouTube 字幕轨道解析', () => {
  it('从 playerResponse 取出轨道，保留语言与自动生成标记', () => {
    const tracks = parseYouTubeCaptionTracks(playerResponse);
    expect(tracks.map((track) => track.language)).toEqual(['zh', 'en']);
    expect(tracks[0]?.label).toBe('中文（简体）');
    expect(tracks[1]?.label).toBe('English (auto)');
    expect(tracks[1]?.kind).toBe('asr');
    expect(tracks.every((track) => track.hasParsedCues === false)).toBe(true);
  });

  it('兼容外包 args.player_response 字符串的结构', () => {
    const wrapped = { args: { player_response: JSON.stringify(playerResponse) } };
    expect(parseYouTubeCaptionTracks(wrapped)).toHaveLength(2);
  });

  it('没有字幕或结构不符时返回空数组，不编造轨道', () => {
    expect(parseYouTubeCaptionTracks({ captions: {} })).toEqual([]);
    expect(parseYouTubeCaptionTracks(null)).toEqual([]);
    expect(parseYouTubeCaptionTracks('<html>not json</html>')).toEqual([]);
    expect(parseYouTubeCaptionTracks({ args: { player_response: 'not-json' } })).toEqual([]);
  });

  it('深层递归有上限，不会因为畸形数据死循环', () => {
    const nested: Record<string, unknown> = {};
    let cursor = nested;
    for (let i = 0; i < 12; i += 1) {
      const next: Record<string, unknown> = {};
      cursor.args = next;
      cursor = next;
    }
    expect(parseYouTubeCaptionTracks(nested)).toEqual([]);
  });
});

describe('同一视频的跨域名归一', () => {
  it('m./music. 子域与主站算同一个视频', () => {
    const main = deriveWebVideoIdentity('https://www.youtube.com/watch?v=abc123');
    const mobile = deriveWebVideoIdentity('https://m.youtube.com/watch?v=abc123');
    const music = deriveWebVideoIdentity('https://music.youtube.com/watch?v=abc123');
    expect(mobile?.origin).toBe(main?.origin);
    expect(music?.videoKey).toBe(main?.videoKey);
    expect(mobile?.canonicalUrl).toBe('https://www.youtube.com/watch?v=abc123');
  });

  it('不同视频 id 仍然区分', () => {
    const a = deriveWebVideoIdentity('https://www.youtube.com/watch?v=abc123');
    const b = deriveWebVideoIdentity('https://www.youtube.com/watch?v=zzz999');
    expect(a?.videoKey).not.toBe(b?.videoKey);
  });

  it('未登记的站点保持原主机，不做猜测性替换', () => {
    expect(deriveWebVideoIdentity('https://example.com/v/1')?.origin).toBe('https://example.com');
  });

  it('B站仍由适配器处理，通用层不接管', () => {
    expect(deriveWebVideoIdentity('https://m.bilibili.com/video/BV1GJ411x7h7')).toBeNull();
  });
});
