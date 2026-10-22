import { useEffect, useState } from 'react';
import { describeError } from '../domain/errors';
import { formatTimecode } from '../domain/transcript';
import type { AutoSummarySnapshot, LiveSummaryNode } from '../lib/auto-summary';
import { openExtensionPage } from '../lib/bridge';
import { advanceTypewriter } from './typewriter';

export function AutoSummaryStatus({ snapshot, ready, busy, connectionError, onControl, aiReady }: {
  snapshot: AutoSummarySnapshot | null;
  ready: boolean;
  busy: boolean;
  connectionError: string | null;
  onControl: (enabled: boolean, retryFailed?: boolean) => void;
  /** AI 侧是否已配置（未配置时根本不会请求模型，必须直说）。 */
  aiReady?: boolean;
}) {
  return (
    <div className="section">
      <h2>SSE 自动学习 · 每 30 秒</h2>
      <p role="status">{snapshot?.message ?? (ready ? '正在连接后台…' : '请先获取、导入或转写字幕')}</p>
      {aiReady === false ? (
        <div className="notice warn" role="alert" style={{ marginTop: 8 }}>
          <strong>AI 尚未配置，自动学习不会产生文字</strong>
          字幕已就绪，但需要先在设置里填写服务地址、模型与 API Key 并确认发送范围，才会随时间轴请求模型。
          <div className="row" style={{ marginTop: 6 }}>
            <button type="button" className="ghost" onClick={() => openExtensionPage('options')}>前往设置</button>
          </div>
        </div>
      ) : null}
      <p className="hint">随播放追加独立小节。弹窗关闭仍继续，正文校验通过后自动保存，可在笔记中导出。</p>
      {snapshot ? <p className="hint">已保存 {snapshot.completed}/{snapshot.total} 个节点 · 排队 {snapshot.queued} · 失败 {snapshot.failed} · 无字幕 {snapshot.empty}</p> : null}
      <div className="row" style={{ marginTop: 8 }}>
        <button type="button" disabled={!ready || !snapshot || busy} onClick={() => onControl(!snapshot?.enabled)}>
          {snapshot?.enabled === false ? '继续自动学习' : '暂停自动学习'}
        </button>
        {snapshot && (snapshot.failed > 0 || snapshot.error) ? (
          <button type="button" disabled={busy} onClick={() => onControl(true, true)}>重试失败段</button>
        ) : null}
        <button type="button" className="ghost" onClick={() => openExtensionPage('options')}>设置与授权</button>
      </div>
      {snapshot?.error ? <div className="notice error" role="alert" style={{ marginTop: 8 }}>
        <strong>{describeError(snapshot.error).title}</strong>
        {snapshot.error.message}
        {snapshot.error.detail ? <div className="hint">{snapshot.error.detail}</div> : null}
        <div className="hint">{describeError(snapshot.error).action}</div>
      </div> : null}
      {snapshot && snapshot.failed > 0 ? <p className="hint">失败段未作为正式内容保存；重试可能再次计费，已完成段不会重发。</p> : null}
      {connectionError ? <div className="notice warn" role="alert" style={{ marginTop: 8 }}>{connectionError}</div> : null}
    </div>
  );
}

/** 只展示后台推来的正文预览，不创建请求，也不把草稿写入笔记。 */
export function StreamingSummaryDraft({ node, onSeek }: { node: LiveSummaryNode | null; onSeek: (ms: number) => void }) {
  const key = node ? `${node.id}:${node.attemptId}` : '';
  const target = node?.previewText ?? '';
  const [typed, setTyped] = useState({ key: '', text: '' });
  useEffect(() => {
    if (!key || !target) { setTyped({ key, text: '' }); return; }
    const timer = setInterval(() => {
      setTyped((previous) => {
        const text = advanceTypewriter(previous.key === key ? previous.text : '', target);
        if (text === target) clearInterval(timer);
        return previous.key === key && previous.text === text ? previous : { key, text };
      });
    }, 16);
    return () => clearInterval(timer);
  }, [key, target]);
  if (!node) return null;
  const text = typed.key === key ? typed.text : '';
  return (
    <div className={`section stream-draft${node.status === 'failed' ? ' stream-failed' : ''}`} data-testid="stream-draft">
      <h2>节点 {node.index} · <button type="button" className="cite" onClick={() => onSeek(node.startMs)}>
        {formatTimecode(node.startMs)}–{formatTimecode(node.endMs)}
      </button></h2>
      <p className="hint" role="status">
        {node.status === 'streaming' ? '流式草稿 · 正在接收，引用尚未校验' :
          node.status === 'queued' ? '等待后台读取此节点' : node.status === 'empty' ? '本时间段没有可用字幕，未请求模型' : '本节点失败 · 草稿未进入正式笔记'}
      </p>
      {text ? <div className="stream-text">{text}{node.status === 'streaming' ? <span aria-hidden="true">▍</span> : null}</div> : null}
      {node.error ? <div className="notice error" role="alert">
        <strong>{describeError(node.error).title}</strong>{node.error.message}
        {node.error.detail ? <div className="hint">{node.error.detail}</div> : null}
      </div> : null}
      {node.failureResponse ? <details style={{ marginTop: 8 }}>
        <summary>查看失败返回（仅本机）</summary>
        <p className="hint">这是模型原始正文，未通过校验。反馈前请隐去私密内容，不要发送 API Key；本扩展不会自动上传诊断。</p>
        <pre className="stream-text">{node.failureResponse.text}</pre>
        {node.failureResponse.truncated ? <p className="hint">仅显示前 8000 字符。</p> : null}
      </details> : null}
    </div>
  );
}
