import { describe, expect, it } from 'vitest';
import {
  extractFromInitialState,
  mergeSnapshot,
  readBvidFromUrl,
  readPageIndexFromUrl,
} from '../src/adapters/bilibili/snapshot';

const HREF = 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=2';

describe('页面元信息抽取', () => {
  it('从 URL 读取 bvid 与分 P 序号', () => {
    expect(readBvidFromUrl(HREF)).toBe('BV1GJ411x7h7');
    expect(readPageIndexFromUrl(HREF)).toBe(2);
    expect(readPageIndexFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7/')).toBe(1);
    expect(readPageIndexFromUrl('https://www.bilibili.com/video/BV1GJ411x7h7/?p=0')).toBe(1);
    expect(readPageIndexFromUrl('not a url')).toBe(1);
    expect(readBvidFromUrl('https://www.bilibili.com/bangumi/play/ep1')).toBe('');
  });

  it('从 __INITIAL_STATE__ 取当前分 P 的 cid，而不是永远取第一页', () => {
    const state = {
      aid: 1001,
      videoData: {
        bvid: 'BV1GJ411x7h7',
        title: '测试视频',
        pages: [
          { cid: 111, page: 1, duration: 60 },
          { cid: 222, page: 2, duration: 90 },
        ],
      },
    };
    const first = extractFromInitialState(state, 'https://www.bilibili.com/video/BV1GJ411x7h7/');
    const second = extractFromInitialState(state, HREF);
    expect(first?.cid).toBe('111');
    expect(second?.cid).toBe('222');
    expect(second?.aid).toBe('1001');
    expect(second?.durationMs).toBe(90_000);
  });

  it('缺少必要字段时返回 null，不生成半成品快照', () => {
    expect(extractFromInitialState(null, HREF)).toBeNull();
    expect(extractFromInitialState({ aid: 1, videoData: { bvid: 'BV1GJ411x7h7', pages: [] } }, HREF)).toBeNull();
    expect(extractFromInitialState({ aid: 1, videoData: { bvid: 'bad', pages: [{ cid: 1 }] } }, HREF)).toBeNull();
  });

  it('merges 主世界快照、全局变量与 URL 三路来源', () => {
    const merged = mergeSnapshot({
      href: HREF,
      initial: { bvid: 'BV1GJ411x7h7', aid: '1001', cid: '222', title: '来自初始状态', durationMs: 90_000 },
      globalVars: null,
      domTitle: '来自 DOM',
      videoDurationMs: 0,
    });
    expect(merged).toEqual({
      bvid: 'BV1GJ411x7h7',
      aid: '1001',
      cid: '222',
      title: '来自初始状态',
      pageIndex: 2,
      durationMs: 90_000,
    });
  });

  it('初始状态缺 cid 时退回全局变量', () => {
    const merged = mergeSnapshot({
      href: HREF,
      initial: { bvid: 'BV1GJ411x7h7', aid: '1001' },
      globalVars: { cid: 333, aid: 1001 },
      domTitle: 'DOM 标题',
      videoDurationMs: 5000,
    });
    expect(merged?.cid).toBe('333');
    expect(merged?.title).toBe('DOM 标题');
    expect(merged?.durationMs).toBe(5000);
  });

  it('三路都拿不到 cid 时返回 null（侧栏应明确提示，而不是永久等待）', () => {
    expect(
      mergeSnapshot({ href: HREF, initial: { bvid: 'BV1GJ411x7h7', aid: '1001' }, globalVars: null, domTitle: 'x' }),
    ).toBeNull();
  });
});
