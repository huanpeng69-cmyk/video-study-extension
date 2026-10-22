/**
 * 回归：进度/音量滑块必须「跟手」。
 *
 * 历史缺陷：滑块是受控输入，value 直接绑 props（1.5 秒轮询来的播放状态）。
 * 拖动时 onChange 只发出请求、props 没变，React 立刻用旧值重渲染，
 * 滑块被弹回原位——用户感受就是「怎么拉都拉不动」。
 *
 * 另外：durationMs 为 0 时 max 被兜底成 1 而 step 是 1000，
 * 轨道只剩一个步进点，几何上无处可拖。
 *
 * 这里直接断言 PlaybackBar 的源码契约（本仓库没有 DOM 测试依赖）。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/ui/PlaybackBar.tsx', 'utf8');

describe('滑块跟手（源码级）', () => {
  it('拖动期间用本地值渲染，而不是直接绑 props', () => {
    expect(source).toMatch(/const \[dragSeek, setDragSeek\] = useState<number \| null>\(null\)/);
    expect(source).toMatch(/const shownPositionMs = dragSeek \?\? state\.positionMs/);
    expect(source).toMatch(/value=\{seekValue\}/);
  });

  it('不能再把 value 直接绑到 state.positionMs / state.volume', () => {
    expect(source).not.toMatch(/value=\{Math\.min\(state\.positionMs, duration\)\}/);
  });

  it('进度拖动结束时才提交 seek，不是每次 onChange 都跳转', () => {
    expect(source).toMatch(/onChange=\{\(event\) => setDragSeek\(Number\(event\.target\.value\)\)\}/);
    expect(source).toMatch(/onPointerUp=\{commitSeek\}/);
    expect(source).toMatch(/onKeyUp=\{commitSeek\}/);
  });

  it('时长未知时禁用进度滑块并给出可读原因，而不是给假轨道', () => {
    expect(source).toMatch(/const knownDuration = state\.durationMs > 0/);
    expect(source).toMatch(/disabled=\{disabled \|\| !knownDuration\}/);
    expect(source).toMatch(/尚未取到视频时长/);
  });

  it('轮询追平后交还控制权，避免本地值长期压住真实状态', () => {
    expect(source).toMatch(/Math\.abs\(state\.positionMs - dragSeek\) < 1_000/);
  });
});
