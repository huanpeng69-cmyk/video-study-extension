/**
 * 回归：音频采集失败不能被压成同一句话。
 *
 * 真实缺陷：`getMediaStreamId(...).catch(() => null)` 把浏览器的失败原因全吞了，
 * 界面永远只显示「无法获取标签页音频 · 点扩展图标并确认 116+」。
 * 用户照着提示点了图标仍然失败，却看不到真正原因是「未调用」「页面不可采集」
 * 还是「标签页已关闭」。这里锁定分类函数与后台的调用方式。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const background = readFileSync('src/entrypoints/background.ts', 'utf8');

describe('标签页音频采集的失败原因（源码级）', () => {
  it('不再用 .catch(() => null) 吞掉 getMediaStreamId 的错误', () => {
    expect(background).not.toMatch(/getMediaStreamId\(\{ targetTabId: asrTabId \}\)\s*\n?\s*\.catch\(\(\) => null\)/);
    expect(background).toMatch(/streamId = await chrome\.tabCapture\.getMediaStreamId\(\{ targetTabId: asrTabId \}\);/);
  });

  it('按浏览器真实文案归类，并各自给出下一步', () => {
    expect(background).toMatch(/function describeTabCaptureFailure\(/);
    for (const kind of ['not-invoked', 'uncapturable-page', 'tab-gone', 'permission', 'unknown']) {
      expect(background).toContain(`kind: '${kind}'`);
    }
    expect(background).toMatch(/text\.includes\('invoked'\)/);
  });

  it('失败原因进入日志，便于用户反馈时定位', () => {
    expect(background).toMatch(/asr:stream-id-failed/);
    expect(background).toMatch(/asr:stream-id-empty/);
  });

  it('拿不到标识时说明要重新点扩展图标，而不是笼统报错', () => {
    expect(background).toMatch(/浏览器没有返回标签页音频标识/);
  });

  it('前端不再用统一的概括标题覆盖后台给出的具体原因', () => {
    const workflow = readFileSync('src/ui/useStudyWorkflow.ts', 'utf8');
    expect(workflow).toMatch(/title: actionable\?\.title \?\? described\.title/);
    expect(workflow).toMatch(/if \(error\.code !== 'CAPTURE_UNAVAILABLE'\) return null;/);
  });
});
