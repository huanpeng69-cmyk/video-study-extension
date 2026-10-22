/**
 * 主播放器选择（纯逻辑，不依赖 DOM 全局）。
 *
 * 为什么单独抽出来：页面脚本 `page-video.ts` 顶部有 `defineUnlistedScript`
 * 等副作用导入，无法在 node 测试环境直接引入。把纯判定逻辑放到这里，
 * 既能在页面里跑，也能被单元测试直接驱动。
 *
 * 历史缺陷：原先「可视面积最大者胜出」。YouTube 等站点会同时存在多个
 * `<video>`（主播放器、推荐位预览、迷你播放器），滚动页面后主播放器面积
 * 可能反而更小，于是选中一个暂停的预览 video → 上报 `paused: true` →
 * 界面显示「未在播放」，而视频其实正在播放。
 */

/** 只依赖这几个字段，便于测试与复用。 */
export interface VideoCandidate {
  clientWidth: number;
  clientHeight: number;
  paused: boolean;
  ended: boolean;
  muted: boolean;
  volume: number;
}

/**
 * 主播放器：**优先选正在播放的**，其次有声音的，最后才比面积。
 * 同分时保持文档顺序（取先出现者），保证结果稳定可复现。
 */
export function selectPrimaryVideo<T extends VideoCandidate>(candidates: T[]): T | null {
  if (candidates.length === 0) return null;
  const score = (video: T): number => {
    const area = Math.max(0, video.clientWidth) * Math.max(0, video.clientHeight);
    const playing = !video.paused && !video.ended ? 1_000_000_000 : 0;
    const audible = !video.muted && video.volume > 0 ? 1_000_000 : 0;
    return playing + audible + Math.min(area, 999_999);
  };
  let best: T | null = null;
  let bestScore = -1;
  for (const video of candidates) {
    const value = score(video);
    if (value > bestScore) { best = video; bestScore = value; }
  }
  return best ?? candidates[0] ?? null;
}
