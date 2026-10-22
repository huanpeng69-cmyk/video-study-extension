/**
 * 回归：调整音量/倍速/静音时，播放状态必须上报。
 *
 * 历史缺陷：`page-video.ts` 的 `reportPosition` 只用「位置变化不足 1 秒就跳过」去重，
 * 而调音量／倍速时 `currentTime` 几乎不动 → 被去重拦掉 → 后台 `TAB_STATES` 不更新
 * → 弹窗里的音量条/倍速选择永远显示旧值，用户以为「播放设置改不好」。
 *
 * 修复：去重条件改为「位置没变 **且** 状态组合也没变」才跳过。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/entrypoints/page-video.ts', 'utf8');

describe('播放状态上报的去重条件（源码级）', () => {
  it('去重必须同时考虑位置与其它播放状态', () => {
    // 必须存在状态快照，并把 volume/muted/playbackRate 纳入其中。
    expect(source).toMatch(/const snapshot = .*volume.*muted.*playbackRate/);
    expect(source).toMatch(/const stateChanged = snapshot !== runtime\.lastState/);
  });

  it('不能保留「只看位置」的旧去重写法', () => {
    expect(source).not.toMatch(
      /if \(!force && Math\.abs\(positionMs - runtime\.lastPositionMs\) < 1000\) return;/,
    );
  });

  it('状态变化时必须放行上报', () => {
    expect(source).toMatch(/if \(!force && !stateChanged && Math\.abs\(positionMs - runtime\.lastPositionMs\) < 1000\) return;/);
  });
});
