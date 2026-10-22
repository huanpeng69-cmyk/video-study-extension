import { describe, expect, it } from 'vitest';
import { isPlaybackForContext, type TabContext } from '../src/lib/messages';

/**
 * 回归：播放位置的身份校验必须在「通用站点」和「B站」两条路径下都正确。
 *
 * 用户实报：字幕已转写完成，但自动学习未启动；同时进度条不随播放更新。
 * 两者同源：都依赖 `PLAYBACK_POSITION`，而它被 `isPlaybackForContext` 静默丢弃。
 *
 * 历史缺陷：比较用 `` `${context.bvid}:${context.cid}` ``，
 * 通用站点 `bvid` 存的是 `webKey`、`cid` 为空，期望值成了
 * `"/watch?v=xxx:"`（多一个冒号），与实际上报的 `"/watch?v=xxx"` 永不匹配。
 * B站 `videoKey` 恰好就是 `bvid:cid`，所以 B站正常、通用站点全断。
 */
const base: TabContext = {
  tabId: 1, documentEpoch: 'epoch-1', bvid: '', aid: '', cid: '',
  pageIndex: 1, title: '', durationMs: 600_000, positionMs: 0, updatedAt: Date.now(),
  platform: 'web',
};

describe('isPlaybackForContext：通用站点身份必须匹配', () => {
  it('通用站点用 videoKey（URL 键）匹配，而非 bvid:cid 拼接', () => {
    const context: TabContext = {
      ...base,
      bvid: '/watch?v=TNZq4-GkIO4',
      cid: '',
      videoKey: '/watch?v=TNZq4-GkIO4',
      videoId: 'web:https://www.youtube.com:/watch?v=TNZq4-GkIO4',
    };
    const payload = { documentEpoch: 'epoch-1', videoKey: '/watch?v=TNZq4-GkIO4' };
    expect(isPlaybackForContext(payload, context)).toBe(true);
  });

  it('通用站点：旧实现会因多出的冒号而误拒（反向钉住根因）', () => {
    const context: TabContext = {
      ...base,
      bvid: '/watch?v=TNZq4-GkIO4',
      cid: '',
      videoKey: '/watch?v=TNZq4-GkIO4',
    };
    const payload = { documentEpoch: 'epoch-1', videoKey: '/watch?v=TNZq4-GkIO4' };
    // 旧实现期望 `/watch?v=TNZq4-GkIO4:`，与上报值不相等。
    expect(`${context.bvid}:${context.cid}`).toBe('/watch?v=TNZq4-GkIO4:');
    expect(payload.videoKey).not.toBe(`${context.bvid}:${context.cid}`);
    // 新实现必须放行。
    expect(isPlaybackForContext(payload, context)).toBe(true);
  });

  it('B站身份仍用 bvid:cid 匹配，不受本次改动影响', () => {
    const context: TabContext = {
      ...base,
      platform: 'bilibili',
      bvid: 'BV1GJ411x7h7',
      cid: '111',
      videoKey: 'BV1GJ411x7h7:111',
    };
    expect(isPlaybackForContext({ documentEpoch: 'epoch-1', videoKey: 'BV1GJ411x7h7:111' }, context)).toBe(true);
    expect(isPlaybackForContext({ documentEpoch: 'epoch-1', videoKey: 'BV1GJ411x7h7:999' }, context)).toBe(false);
  });

  it('documentEpoch 不匹配仍必须拒绝（防止旧文档误触）', () => {
    const context: TabContext = {
      ...base,
      bvid: '/watch?v=TNZq4-GkIO4',
      cid: '',
      videoKey: '/watch?v=TNZq4-GkIO4',
    };
    expect(isPlaybackForContext({ documentEpoch: 'epoch-OLD', videoKey: '/watch?v=TNZq4-GkIO4' }, context)).toBe(false);
  });

  it('videoKey 为空时回退到 bvid:cid（兼容旧上下文）', () => {
    const context: TabContext = {
      ...base,
      platform: 'bilibili',
      bvid: 'BV1GJ411x7h7',
      cid: '111',
      videoKey: undefined,
    };
    expect(isPlaybackForContext({ documentEpoch: 'epoch-1', videoKey: 'BV1GJ411x7h7:111' }, context)).toBe(true);
  });
});
