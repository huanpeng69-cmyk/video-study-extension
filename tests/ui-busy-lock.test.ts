/**
 * 回归：转写进行中不能把「收听与画面」整块锁死。
 *
 * 历史缺陷：`PopupApp` 里 `busy = state.busy || state.task.state === 'running'`，
 * 而转写轮询会长时间保持 `task.state === 'running'`，于是转写一开始
 * 收听控制与截图按钮全部变灰，看起来像界面卡住；轮询也不会因关弹窗退出。
 *
 * 这里直接读真实源码断言，而不是复制一份判定逻辑自说自话。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const popup = readFileSync('src/ui/PopupApp.tsx', 'utf8');
const workflow = readFileSync('src/ui/useStudyWorkflow.ts', 'utf8');

describe('任务进度不等于全局锁（源码级）', () => {
  it('全局 busy 不再被任务进度放大', () => {
    expect(popup).not.toMatch(/state\.busy\s*\|\|\s*state\.task\.state\s*===\s*'running'/);
    expect(popup).toMatch(/const busy = state\.busy;/);
  });

  it('收听与画面不再依赖 context / busy，只依赖是否识别到视频', () => {
    expect(popup).not.toMatch(/disabled=\{!state\.context\}/);
    expect(popup).toMatch(/disabled=\{!state\.video\}/);
  });

  it('转写轮询可被取消，避免关弹窗后一直占着状态', () => {
    expect(workflow).toMatch(/pollCancelledRef\.current = true/);
    expect(workflow).toMatch(/if \(pollCancelledRef\.current\) return;/);
  });

  it('重开弹窗时会把已完成的转写结果落进界面（字幕不再空白）', () => {
    expect(workflow).toMatch(/view\.status === 'completed' && view\.transcriptId/);
    expect(workflow).toMatch(/transcript: saved, cues, transcripts/);
  });
});
