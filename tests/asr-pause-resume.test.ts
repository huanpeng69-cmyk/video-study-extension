/**
 * 回归：暂停不应该结束整场采集。
 *
 * 历史缺陷：`captureIssue` 对 `paused` 返回 `stop: true`，于是
 * 「打开弹窗时视频是暂停的 → 点从音频转写 → 第一个真实采样就判暂停 → 会话立刻结束」，
 * 用户看到的是「没有采集到可转写的音频片段」，而视频根本没有坏。
 */
import { describe, expect, it } from 'vitest';
import { captureIssue, type CaptureSample } from '../src/asr/tab-protocol';

const playing: CaptureSample = {
  positionMs: 10_000, durationMs: 600_000, paused: false, muted: false, volume: 1, playbackRate: 1,
};

describe('暂停只是挂起，不是结束会话', () => {
  it('暂停不要求停止采集（stop=false），且保留已录分片', () => {
    const issue = captureIssue(playing, { ...playing, positionMs: 10_400, paused: true }, 1_000);
    expect(issue).toMatchObject({ kind: 'paused', discard: false, stop: false });
  });

  it('暂停时位置不前进也不应被判成跳转', () => {
    // 暂停期间 currentTime 冻结，progress=0、elapsed=1000，差值在容差内。
    const issue = captureIssue(playing, { ...playing, positionMs: 10_000, paused: true }, 1_000);
    expect(issue?.kind).toBe('paused');
    expect(issue?.stop).toBe(false);
  });

  it('恢复播放后不再报任何问题，录音器据此续录', () => {
    const paused = { ...playing, positionMs: 10_000, paused: true };
    const resumed = { ...playing, positionMs: 11_000, paused: false };
    expect(captureIssue(paused, resumed, 1_000)).toBeNull();
  });

  it('真正的跳转仍然要丢弃当前分片', () => {
    const issue = captureIssue(playing, { ...playing, positionMs: 90_000 }, 1_000);
    expect(issue).toMatchObject({ kind: 'seek', discard: true, stop: true });
  });

  it('倍速仍然停止并丢弃（时间轴不可信）', () => {
    const issue = captureIssue(playing, { ...playing, positionMs: 11_000, playbackRate: 2 }, 1_000);
    expect(issue).toMatchObject({ kind: 'rate', discard: true, stop: true });
  });
});
