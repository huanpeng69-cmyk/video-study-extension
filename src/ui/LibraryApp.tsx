import { useCallback, useEffect, useState } from 'react';
import { describeError, toAppError } from '../domain/errors';
import { watchUrlFor } from '../domain/video';
import { countAll, deleteVideoCascade, listLibrary, updateVideoTags, type LibraryListItem } from '../storage/db';
import { createBackup, parseBackup, previewBackup, restoreBackup, serializeBackup, type BackupPreview } from '../export/backup';
import type { BackupEnvelope } from '../storage/types';

import { describeLibraryProgress } from './useStudyWorkflow';
import { summaryProgress, type SummaryProgressInfo } from '../lib/bridge';

/**
 * 列表行的总结状态。
 * 有后台进度时以进度为准（这是弹窗关闭、任务仍在跑时的查看入口）；
 * 否则退回列表已有的元数据，不额外发请求。
 */
function describeSummaryState(item: LibraryListItem, progress?: SummaryProgressInfo): string {
  if (progress) return describeLibraryProgress(progress);
  return item.hasSummary ? '有总结' : '无总结';
}

/** 资料库：搜索、打开、删除、备份与恢复（PRD F08、F12）。 */
export function LibraryApp() {
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<LibraryListItem[]>([]);
  const [counts, setCounts] = useState({ videos: 0, notes: 0 });
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<LibraryListItem | null>(null);
  const [backup, setBackup] = useState<{ envelope: BackupEnvelope; preview: BackupPreview } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (keyword?: string) => {
    try {
      const [list, totals] = await Promise.all([listLibrary(keyword), countAll()]);
      setItems(list);
      setCounts(totals);
    } catch (error) {
      const normalized = toAppError(error);
      setMessage({ kind: 'error', text: `${describeError(normalized).title}：${normalized.message}` });
    }
  }, []);

  const [progress, setProgress] = useState<Map<string, SummaryProgressInfo>>(new Map());

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * 轮询后台总结进度：弹窗关闭后任务仍在跑，资料库是查看它的地方。
   * 只查询当前列表里出现的视频，避免无谓的后台消息。
   */
  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      const ids = items.map((item) => item.video.id);
      if (ids.length === 0) return;
      const entries = await Promise.all(
        ids.slice(0, 30).map(async (videoId) => {
          const result = await summaryProgress(videoId);
          return result.ok && result.data ? ([videoId, result.data] as const) : null;
        }),
      );
      if (cancelled) return;
      const next = new Map<string, SummaryProgressInfo>();
      for (const entry of entries) if (entry) next.set(entry[0], entry[1]);
      setProgress(next);
    };
    void tick();
    const timer = window.setInterval(() => void tick(), 3000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [items]);
  const search = useCallback(() => {
    void refresh(query);
  }, [query, refresh]);

  const confirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setBusy(true);
    try {
      await deleteVideoCascade(pendingDelete.video.id);
      setPendingDelete(null);
      setMessage({ kind: 'ok', text: '已删除该资料（字幕、译文、总结与笔记）' });
      await refresh(query);
    } catch (error) {
      const normalized = toAppError(error);
      setMessage({ kind: 'error', text: `${describeError(normalized).title}：${normalized.message}` });
    } finally {
      setBusy(false);
    }
  }, [pendingDelete, query, refresh]);

  const exportBackup = useCallback(async () => {
    setBusy(true);
    try {
      const envelope = await createBackup();
      const text = serializeBackup(envelope);
      const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `video-study-backup-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.rel = 'noopener';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setMessage({ kind: 'ok', text: '备份已导出（不含 API Key）' });
    } catch (error) {
      const normalized = toAppError(error);
      setMessage({ kind: 'error', text: `${describeError(normalized).title}：${normalized.message}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const pickBackup = useCallback(async (file: File) => {
    setBusy(true);
    setMessage(null);
    try {
      const text = await file.text();
      const envelope = parseBackup(text);
      const preview = await previewBackup(envelope);
      setBackup({ envelope, preview });
    } catch (error) {
      const normalized = toAppError(error);
      setBackup(null);
      setMessage({ kind: 'error', text: `${describeError(normalized).title}：${normalized.message}` });
    } finally {
      setBusy(false);
    }
  }, []);

  const applyRestore = useCallback(async () => {
    if (!backup) return;
    setBusy(true);
    try {
      const result = await restoreBackup(backup.envelope, true);
      setBackup(null);
      setMessage({
        kind: 'ok',
        text: `已导入 ${result.importedNotes} 条笔记${result.conflictCopies > 0 ? `，另有 ${result.conflictCopies} 条冲突副本保留` : ''}`,
      });
      await refresh(query);
    } catch (error) {
      const normalized = toAppError(error);
      setMessage({ kind: 'error', text: `${describeError(normalized).title}：${normalized.message}` });
    } finally {
      setBusy(false);
    }
  }, [backup, query, refresh]);

  const editTags = useCallback(
    async (item: LibraryListItem) => {
      const input = window.prompt('标签（用逗号分隔）', item.video.tags.join(', '));
      if (input === null) return;
      try {
        await updateVideoTags(
          item.video.id,
          input.split(/[,，]/).map((tag) => tag.trim()),
        );
        await refresh(query);
      } catch (error) {
        setMessage({ kind: 'error', text: toAppError(error).message });
      }
    },
    [query, refresh],
  );

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>资料库</h1>
          <span className="hint">
            {counts.videos} 个视频 / {counts.notes} 份笔记
          </span>
        </div>
      </header>
      <main className="panel">
        <div className="stack">
          {message ? <div className={`notice ${message.kind}`}>{message.text}</div> : null}

          <div className="row">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') search();
              }}
              placeholder="搜索标题、标签或笔记正文"
              aria-label="搜索资料"
            />
            <button type="button" onClick={search} disabled={busy}>
              搜索
            </button>
          </div>

          {items.length === 0 ? (
            <div className="empty">还没有资料。在 B站视频页打开扩展并保存笔记后会出现在这里。</div>
          ) : (
            <ul className="cue-list" style={{ maxHeight: 'none' }}>
              {items.map((item) => (
                <li key={item.video.id} className="cue" style={{ cursor: 'default' }}>
                  <div className="cue-body">
                    <strong>{item.video.title}</strong>
                    <div className="meta-row">
                      <span>{item.video.bvid}</span>
                      <span>第 {item.video.pageIndex} P</span>
                      <span>{item.transcriptCount} 个字幕版本</span>
                      <span>{describeSummaryState(item, progress.get(item.video.id))}</span>
                      <span>{item.hasNote ? '有笔记' : '无笔记'}</span>
                      <span>更新 {new Date(item.video.updatedAt).toLocaleString()}</span>
                    </div>
                    {item.video.tags.length > 0 ? <div className="hint">标签：{item.video.tags.join('、')}</div> : null}
                    <div className="row" style={{ marginTop: 6 }}>
                      <a
                        href={watchUrlFor(item.video, 0)}
                        target="_blank"
                        rel="noreferrer noopener"
                        style={{ fontSize: 12, color: 'var(--accent)' }}
                      >
                        打开原视频
                      </a>
                      <button type="button" className="ghost" onClick={() => void editTags(item)}>
                        标签
                      </button>
                      <button type="button" className="ghost danger" onClick={() => setPendingDelete(item)}>
                        删除
                      </button>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <div className="section">
            <h2>备份与恢复</h2>
            <div className="row">
              <button type="button" onClick={() => void exportBackup()} disabled={busy}>
                导出 JSON 备份
              </button>
              <label className="checkbox" style={{ cursor: 'pointer' }}>
                <input
                  type="file"
                  accept="application/json,.json"
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    const file = event.target.files?.[0];
                    if (file) void pickBackup(file);
                    event.target.value = '';
                  }}
                  disabled={busy}
                />
                <span className="ghost" style={{ color: 'var(--accent)' }}>
                  导入备份
                </span>
              </label>
            </div>
            <p className="hint">备份只包含视频元信息、字幕、译文、总结与笔记，不包含 API Key。恢复前会先预览。</p>
            {backup ? (
              <div className="notice warn" style={{ marginTop: 8 }}>
                <strong>将导入以下内容</strong>
                视频 {backup.preview.videos} · 字幕版本 {backup.preview.transcripts} · 字幕条目 {backup.preview.cues} · 笔记{' '}
                {backup.preview.notes}
                {backup.preview.conflicts > 0
                  ? ` · 其中 ${backup.preview.conflicts} 条与现有笔记不同，将保留为冲突副本`
                  : ''}
                <div className="row" style={{ marginTop: 6 }}>
                  <button type="button" className="primary" onClick={() => void applyRestore()} disabled={busy}>
                    确认合并
                  </button>
                  <button type="button" onClick={() => setBackup(null)}>
                    取消
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {pendingDelete ? (
            <div className="notice error">
              <strong>删除「{pendingDelete.video.title}」？</strong>
              该视频的字幕、译文、总结和笔记都会被删除；已导出的外部文件不受影响。
              <div className="row" style={{ marginTop: 6 }}>
                <button type="button" className="danger" onClick={() => void confirmDelete()} disabled={busy}>
                  确认删除
                </button>
                <button type="button" onClick={() => setPendingDelete(null)}>
                  取消
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </div>
  );
}
