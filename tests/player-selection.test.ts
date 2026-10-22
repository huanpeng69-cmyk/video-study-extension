/**
 * 回归：主播放器必须优先选「正在播放」的那个。
 *
 * 用户实报现象：视频明明在播放，弹窗却显示「‖ 未在播放」。
 *
 * 根因（已被测试证实）：旧实现是「可视面积最大者胜出」。
 * YouTube 等站点会同时存在多个 `<video>`（主播放器、推荐位预览、迷你播放器），
 * 滚动页面后主播放器的可视面积可能反而更小，于是选中一个**暂停的预览 video**，
 * 上报 `paused: true` → 界面显示「未在播放」，而视频其实正在播放。
 *
 * 修复：`domain/primary-video.ts` 的 `selectPrimaryVideo()`
 * 改为「正在播放 > 有声音 > 面积」，页面脚本 `page-video.ts` 直接复用它。
 */
import { describe, expect, it } from 'vitest';
import { selectPrimaryVideo } from '../src/domain/primary-video';

function video(init: Partial<{ w: number; h: number; paused: boolean; ended: boolean; muted: boolean; volume: number; id: string }>) {
  return {
    id: init.id ?? 'v',
    clientWidth: init.w ?? 0,
    clientHeight: init.h ?? 0,
    paused: init.paused ?? true,
    ended: init.ended ?? false,
    muted: init.muted ?? false,
    volume: init.volume ?? 1,
  };
}

describe('主播放器选择：优先正在播放的', () => {
  it('面积更大的暂停预览 video 不能盖过正在播放的主播放器', () => {
    // 这正是用户遇到的场景：滚动后主播放器变小，预览 video 更大。
    const main = video({ id: 'main', w: 640, h: 360, paused: false });
    const preview = video({ id: 'preview', w: 1280, h: 720, paused: true });
    expect(selectPrimaryVideo([main, preview])?.id).toBe('main');
    expect(selectPrimaryVideo([preview, main])?.id).toBe('main');
  });

  it('选中的播放器必须处于播放状态，而不是暂停状态', () => {
    const list = [
      video({ id: 'a', w: 300, h: 200, paused: true }),
      video({ id: 'b', w: 800, h: 500, paused: false }),
      video({ id: 'c', w: 400, h: 300, paused: true }),
    ];
    expect(selectPrimaryVideo(list)?.id).toBe('b');
  });

  it('全部暂停时退回面积最大者（保持旧行为的合理部分）', () => {
    const list = [
      video({ id: 'small', w: 100, h: 100, paused: true }),
      video({ id: 'big', w: 900, h: 600, paused: true }),
    ];
    expect(selectPrimaryVideo(list)?.id).toBe('big');
  });

  it('已结束的视频不算「正在播放」', () => {
    const ended = video({ id: 'ended', w: 1280, h: 720, paused: false, ended: true });
    const paused = video({ id: 'paused', w: 320, h: 180, paused: true });
    // 两者都不在播放，退回面积更大者。
    expect(selectPrimaryVideo([ended, paused])?.id).toBe('ended');
  });

  it('静音但正在播放 > 未静音但暂停', () => {
    const mutedPlaying = video({ id: 'muted-play', w: 100, h: 100, paused: false, muted: true, volume: 0 });
    const loudPaused = video({ id: 'loud-pause', w: 2000, h: 1200, paused: true, muted: false, volume: 1 });
    expect(selectPrimaryVideo([loudPaused, mutedPlaying])?.id).toBe('muted-play');
  });

  it('面积相同时保持文档顺序，结果稳定可复现', () => {
    const first = video({ id: 'first', w: 100, h: 100, paused: true });
    const second = video({ id: 'second', w: 100, h: 100, paused: true });
    expect(selectPrimaryVideo([first, second])?.id).toBe('first');
    expect(selectPrimaryVideo([second, first])?.id).toBe('second');
  });

  it('没有任何 video 时返回 null', () => {
    expect(selectPrimaryVideo([])).toBeNull();
  });

  it('负/异常尺寸不会导致选择错误', () => {
    const bad = video({ id: 'bad', w: -10, h: -10, paused: true });
    const good = video({ id: 'good', w: 100, h: 100, paused: true });
    expect(selectPrimaryVideo([bad, good])?.id).toBe('good');
  });
});
