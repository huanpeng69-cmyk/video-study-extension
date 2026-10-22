import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { liveNode } from '../src/lib/auto-summary';
import { StreamingSummaryDraft } from '../src/ui/AutoSummaryPanel';
import type { SummaryNodeRecord } from '../src/storage/types';

const node: SummaryNodeRecord = {
  id: 'fixture-node', videoId: 'fixture-video', transcriptId: 'fixture-transcript', index: 0, startMs: 0, endMs: 30_000,
  status: 'failed', attempts: 1, attemptId: 'fixture-attempt', rawText: '<script>test-only</script>', previewText: '',
  result: null, providerSnapshot: null, language: 'zh', createdAt: '', updatedAt: '',
  error: { code: 'BAD_RESPONSE', message: '模型未按 JSON 输出', detail: 'phase=model-json; kind=non-json; stream=complete', retryable: false },
};

describe('失败正文的本机诊断显示', () => {
  it('仅失败节点携带有界正文，正常流式订阅不重复携带原始 JSON', () => {
    expect(liveNode({ ...node, status: 'streaming' }).failureResponse).toBeUndefined();
    expect(liveNode({ ...node, status: 'done' }).failureResponse).toBeUndefined();
    const failed = liveNode({ ...node, rawText: 'x'.repeat(9000) });
    expect(failed.failureResponse?.text).toHaveLength(8000);
    expect(failed.failureResponse?.truncated).toBe(true);
  });
  it('显示阶段诊断，原始返回默认折叠且按纯文本转义', () => {
    const html = renderToStaticMarkup(createElement(StreamingSummaryDraft, { node: liveNode(node), onSeek: () => {} }));
    expect(html).toContain('kind=non-json'); expect(html).toContain('stream=complete');
    expect(html).toContain('查看失败返回（仅本机）'); expect(html).not.toMatch(/<details[^>]*\bopen\b/);
    expect(html).not.toContain('<script>'); expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('不会自动上传诊断');
  });
});
