/**
 * 回归：自动学习必须能拿到 subtitles 版本 id，否则永远不出字。
 *
 * 真实故障链（用户侧表现：「字幕出来了，但自动学习不出字」）：
 * 1. 自动学习用 `useAutoSummary(videoId, transcriptId)` 订阅，`transcriptId` 来自 `state.transcript?.id`；
 * 2. 采集期间若只 `patch({ cues })` 而不落库，`state.transcript` 仍是 null；
 * 3. `useAutoSummary` 在 `!videoId || !transcriptId` 时直接 return，不建会话、不订阅；
 * 4. 结果：字幕列表有字，自动学习页永远「请先获取、导入或转写字幕」。
 *
 * 本测试直接断言这条链路的源码契约，防止有人再把「只更新 cues」的写法加回来。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const workflow = readFileSync('src/ui/useStudyWorkflow.ts', 'utf8');
const popup = readFileSync('src/ui/PopupApp.tsx', 'utf8');

describe('自动学习依赖真实字幕版本（源码级）', () => {
  it('边采边显示时必须同时落库并写入 transcript，不能只更新 cues', () => {
    // 采集进行中要落一个真实版本（sourceKind asr），并把 revision 写进 transcript。
    expect(workflow).toMatch(/liveTranscriptIdRef/);
    expect(workflow).toMatch(/trackLabel: `本地转写（进行中）/);
    expect(workflow).toMatch(/patch\(\{ transcript: revision, transcripts \}\)/);
  });

  it('自动学习订阅必须同时拿到视频与字幕两个 id', () => {
    expect(workflow).toMatch(/useAutoSummary\(state\.video\?\.id, state\.transcript\?\.id/);
  });

  it('面板的 ready 判定必须来自真实字幕列表，而不是「有 cues 就算就绪」', () => {
    // 保留 hasTranscript 用于展示，但自动学习就绪应由 transcript 存在决定。
    expect(popup).toMatch(/<AutoSummaryStatus[\s\S]*?ready=\{/);
    expect(popup).toMatch(/ready=\{Boolean\(state\.transcript\)\}/);
  });

  it('未配置 AI 时必须明确告知不会产生文字', () => {
    expect(popup).toMatch(/aiReady=\{Boolean\(state\.apiKeyPresent && state\.settings\?\.consentAcknowledged\)\}/);
  });
});
