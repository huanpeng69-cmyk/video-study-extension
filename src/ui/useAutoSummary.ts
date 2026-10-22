import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTO_SUMMARY_PORT, type AutoSummaryEvent, type AutoSummarySnapshot } from '../lib/auto-summary';
import { autoSummaryState, controlAutoSummary, selectAutoTranscript } from '../lib/bridge';
import { toAppError } from '../domain/errors';
import type { SummaryRecord } from '../storage/types';

/** 生命周期仅管理显示订阅；cleanup 不发取消任务消息。 */
export function useAutoSummary(videoId: string | undefined, transcriptId: string | undefined,
  onSummary: (summary: SummaryRecord | null, videoId: string, transcriptId: string) => void) {
  const [snapshot, setSnapshot] = useState<AutoSummarySnapshot | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const summaryRef = useRef(onSummary);
  summaryRef.current = onSummary;
  const refreshRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    setSnapshot(null);
    setConnectionError(null);
    if (!videoId || !transcriptId) return;
    let disposed = false;
    let fetching = false;
    let needsRefresh = false;
    let port: chrome.runtime.Port | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let retries = 0;

    const refresh = async () => {
      if (disposed) return;
      if (fetching) { needsRefresh = true; return; }
      fetching = true;
      try {
        const reply = await autoSummaryState(videoId);
        if (disposed) return;
        if (!reply.ok || !reply.data) {
          setConnectionError(reply.error?.message ?? '后台状态暂不可用');
          return;
        }
        const next = reply.data;
        if (next.transcriptId !== transcriptId) return;
        setSnapshot((previous) => {
          // 重连快照可能比刚推送的 delta 略旧；同一尝试仅前进，不倒退打字机。
          const oldDraft = previous?.draft;
          const newDraft = next.draft;
          if (oldDraft?.status === 'streaming' && newDraft?.status === 'streaming' &&
            oldDraft.id === newDraft.id && oldDraft.attemptId === newDraft.attemptId &&
            oldDraft.previewText.length > newDraft.previewText.length) return { ...next, draft: oldDraft };
          return next;
        });
        summaryRef.current(next.summary, videoId, transcriptId);
      } catch (cause) {
        if (!disposed) setConnectionError(toAppError(cause).message);
      } finally {
        fetching = false;
        if (needsRefresh && !disposed) { needsRefresh = false; void refresh(); }
      }
    };
    refreshRef.current = () => { void refresh(); };

    const connect = () => {
      if (disposed) return;
      try {
        const connection = chrome.runtime.connect({ name: AUTO_SUMMARY_PORT });
        port = connection;
        connection.onMessage.addListener((event: AutoSummaryEvent) => {
          if (disposed || event.videoId !== videoId) return;
          if (event.type === 'changed') { void refresh(); return; }
          if (event.node.transcriptId !== transcriptId) return;
          setSnapshot((previous) => {
            if (!previous || previous.transcriptId !== transcriptId) return previous;
            const old = previous.draft;
            if (old && (old.index > event.node.index || (old.id === event.node.id && old.updatedAt > event.node.updatedAt))) return previous;
            return { ...previous, draft: event.node, message: `SSE 正在读取节点 ${event.node.index}（关闭弹窗仍继续）` };
          });
        });
        connection.onDisconnect.addListener(() => {
          // 读取 lastError，防止 Chrome 输出未处理的端口错误；不记录原始消息。
          void chrome.runtime.lastError;
          if (disposed || port !== connection) return;
          port = null;
          if (retries < 3) {
            retryTimer = setTimeout(connect, 500 * 2 ** retries++);
          } else {
            setConnectionError('实时订阅暂不可用，仍每 2 秒同步后台进度；可重开弹窗重新连接。');
          }
        });
        connection.postMessage({ type: 'subscribe', videoId });
        setConnectionError(null);
        void refresh();
      } catch (cause) {
        setConnectionError(toAppError(cause).message);
      }
    };

    // 注册所选字幕不是生成命令：只有真实播放跨过节点时才会请求模型。
    void selectAutoTranscript(videoId, transcriptId).then((result) => {
      if (disposed) return;
      if (!result.ok) { setConnectionError(result.error?.message ?? '无法选择自动学习字幕'); return; }
      connect();
    });
    // 兜底用于重连/休眠恢复；无模型调用，也不根据本地时钟伪造播放节点。
    const timer = setInterval(() => { void refresh(); }, 2000);
    return () => {
      disposed = true;
      refreshRef.current = null;
      clearInterval(timer);
      clearTimeout(retryTimer);
      port?.disconnect();
    };
  }, [videoId, transcriptId]);

  const control = useCallback(async (enabled: boolean, retryFailed = false) => {
    if (!videoId || !transcriptId) return;
    setControlBusy(true);
    try {
      const result = await controlAutoSummary(videoId, enabled, retryFailed);
      if (!result.ok) setConnectionError(result.error?.message ?? '自动学习开关未生效');
      else { setConnectionError(null); refreshRef.current?.(); }
    } finally { setControlBusy(false); }
  }, [videoId, transcriptId]);

  return { snapshot, connectionError, controlBusy, control };
}
