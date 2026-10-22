/**
 * 回归：播放位置必须能真正送到后台，否则自动学习永远不触发。
 *
 * 来自真实自检结果（用户环境）：
 *   字幕版本 6 条 ✓、自动学习会话 存在 ✓、enabled=true ✓、error=null ✓
 *   但 node 数 = 0，且 session.playbackPaused = true、lastPositionMs = 0
 *
 * 说明配置、字幕、会话全都没问题，断点在「播放位置没送达」。
 * 两个具体阻塞点（均已修复）：
 *
 * A. 内容脚本 `reportPosition()` 把 `runtime.lastVideoKey` 当前置条件。
 *    该值由 emitContext 写入，页面重载 / SW 回收 / SPA 换片后为空，
 *    于是位置上报被整段跳过 → 后台永远停在 0 与 paused=true。
 *    修复：缺失时按当前地址自愈，不再直接 return。
 *
 * B. 后台收到 PLAYBACK_POSITION 时，若 `readContext()` 为空就直接丢弃。
 *    修复：用上报里的 videoKey + 页面 origin 补建上下文后继续处理。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pageVideo = readFileSync('src/entrypoints/page-video.ts', 'utf8');
const background = readFileSync('src/entrypoints/background.ts', 'utf8');
const playbackBar = readFileSync('src/ui/PlaybackBar.tsx', 'utf8');
const bridge = readFileSync('src/lib/bridge.ts', 'utf8');

describe('播放位置上报不能被身份/上下文缺失吞掉', () => {
  it('内容脚本不能因为 lastVideoKey 为空就放弃上报', () => {
    expect(pageVideo).not.toMatch(/if \(!video \|\| !runtime\.lastVideoKey\) return;/);
    // 必须能自愈：用当前地址重新推导身份。
    expect(pageVideo).toMatch(/if \(!runtime\.lastVideoKey\) \{/);
    expect(pageVideo).toMatch(/const identity = deriveWebVideoIdentity\(location\.href\)/);
  });

  it('后台在上下文缺失时要能补建，而不是直接丢位置', () => {
    expect(background).toMatch(/let existing = await readContext\(sender\.tab\.id\)/);
    expect(background).toMatch(/playback:context-rebuilt/);
    // 补建后仍走同一套身份校验，不是无条件放行。
    expect(background).toMatch(/if \(!isPlaybackForContext\(message\.payload, existing\)\) return \{ ok: true \};/);
  });

  it('补建上下文时不允许凭空造身份（必须有 videoKey）', () => {
    expect(background).toMatch(/const key = String\(message\.payload\?\.videoKey \?\? ''\)\.trim\(\);/);
    expect(background).toMatch(/if \(!key\) return \{ ok: true \};/);
  });
});

describe('播放控制不能谎报成功（源码级契约）', () => {
  it('play() 被拒绝时必须如实回传原因，不能吞掉', () => {
    // 只禁止「play() 直接挂 catch 吞掉」这一种写法，不要误伤文件里其他的 catch。
    expect(pageVideo).not.toMatch(/play\(\)\.catch\(/);
    expect(pageVideo).toMatch(/video\.play\(\)\.then\(/);
    expect(pageVideo).toMatch(/NotAllowedError/);
  });

  it('seek 必须等 seeked（或兜底超时）后才回答', () => {
    expect(pageVideo).toMatch(/video\.addEventListener\('seeked', onSeeked, \{ once: true \}\)/);
    expect(pageVideo).toMatch(/\}, 800\);/);
  });
});

describe('播放控制已删除，只保留状态识别与进度跳转', () => {
  it('播放按钮与播放控制链路彻底移除，不再名存实亡', () => {
    expect(playbackBar).not.toMatch(/onAction\('toggle'\)/);
    expect(playbackBar).not.toMatch(/onAction\('guide-play'\)/);
    expect(playbackBar).not.toMatch(/onAction\('rate'/);
    expect(playbackBar).not.toMatch(/onAction\('volume'/);
    expect(playbackBar).not.toMatch(/onAction\('mute'/);
    // 只显示状态，不渲染控制按钮。
    expect(playbackBar).toMatch(/role="status" aria-live="polite"/);
  });

  it('进度跳转保留（不需要用户手势，且拖动跟手）', () => {
    expect(playbackBar).toMatch(/onPointerUp=\{commitSeek\}/);
    expect(playbackBar).toMatch(/onKeyUp=\{commitSeek\}/);
  });

  it('暂停时给出明确说明，而不是给一个无效按钮', () => {
    expect(playbackBar).toMatch(/视频未在播放/);
    expect(playbackBar).toMatch(/自动播放策略要求先在视频页面上点一次播放/);
  });

  it('guide-* 动作类型已从协议中移除', () => {
    expect(bridge).not.toMatch(/guide-play/);
    expect(bridge).not.toMatch(/guide-mute/);
  });
});
