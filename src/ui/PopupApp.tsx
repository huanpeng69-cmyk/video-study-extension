import { useCallback, useEffect, useMemo, useState } from 'react';
import { buildMarkdown, buildSrt, safeFileName, sanitizeMarkdown } from '../export/markdown';
import { formatTimecode, type Cue } from '../domain/transcript';
import { openExtensionPage } from '../lib/bridge';
import type { PlaybackAction } from '../lib/messages';
import { NotePanel } from './NotePanel';
import { PlaybackBar } from './PlaybackBar';
import { SummaryPanel } from './SummaryPanel';
import { AutoSummaryStatus, StreamingSummaryDraft } from './AutoSummaryPanel';
import { TranscriptPanel } from './TranscriptPanel';
import { cueAtCapture } from './followCue';
import { useStudyWorkflow } from './useStudyWorkflow';

type TabKey = 'transcript' | 'summary' | 'note';

/** 弹窗主界面：收听控制 + 字幕 / 总结 / 笔记。 */
export function PopupApp() {
  const { state, cuesById, actions } = useStudyWorkflow();
  const [tab, setTab] = useState<TabKey>('transcript');
  const [fileInputKey, setFileInputKey] = useState(0);

  const hasTranscript = state.cues.length > 0;
  // 转写/翻译任务的进度条不等于全局锁：只用 busy 锁住会互相干扰的操作，
  // 否则后台转写进行中会把「收听与画面」整块一起锁死，看起来像界面卡住。
  const busy = state.busy;

  useEffect(() => {
    if (state.summary && !hasTranscript) setTab('summary');
  }, [hasTranscript, state.summary]);

  const download = useCallback((content: string, filename: string, mime: string) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }, []);

  const handleExport = useCallback(
    async (options: { includeTranscript: boolean; includeSummary: boolean }) => {
      if (!state.video) return;
      await actions.flushNote();
      const markdown = buildMarkdown({
        video: state.video,
        cues: state.cues,
        translations: state.translations,
        summary: state.summary ?? undefined,
        noteMarkdown: state.noteMarkdown,
        includeTranscript: options.includeTranscript,
        includeSummary: options.includeSummary && Boolean(state.summary),
        generatedAt: new Date().toISOString(),
      });
      download(sanitizeMarkdown(markdown), `${safeFileName(state.video.title)}.md`, 'text/markdown;charset=utf-8');
    },
    [actions, download, state.cues, state.noteMarkdown, state.summary, state.translations, state.video],
  );

  const handleExportSrt = useCallback(async () => {
    if (!state.video || state.cues.length === 0) return;
    download(buildSrt(state.cues), `${safeFileName(state.video.title)}.srt`, 'text/plain;charset=utf-8');
  }, [download, state.cues, state.video]);

  const insertCues = useCallback(
    (cues: Cue[]) => {
      const block = cues
        .map((cue) => {
          const translation = state.translations.get(cue.cueId);
          const head = `> [${formatTimecode(cue.startMs)}] ${cue.text}`;
          return translation ? `${head}\n> ${translation}` : head;
        })
        .join('\n>\n');
      actions.updateNote(`${state.noteMarkdown.trimEnd()}\n\n${block}\n`.trimStart());
      setTab('note');
    },
    [actions, state.noteMarkdown, state.translations],
  );

  const insertSummary = useCallback(
    (markdown: string) => {
      actions.updateNote(`${state.noteMarkdown.trimEnd()}\n\n${markdown}\n`.trimStart());
      setTab('note');
    },
    [actions, state.noteMarkdown],
  );

  /**
   * 把截图以 Markdown 图片 + 时间戳写入笔记。
   *
   * 借鉴 Tangentry：截图通常发生在“刚说完那句值得记的话”之后，因此自动带上
   * 当前（或刚结束 4 秒内）的字幕原文，免去再手动选一遍。取不到就只写时间戳，
   * 绝不编造字幕内容。
   */
  const insertFrame = useCallback(() => {
    const frame = state.frame;
    if (!frame) return;
    const stamp = formatTimecode(frame.positionMs);
    const cue = cueAtCapture(state.cues, frame.positionMs);
    const lines = [`![${stamp}](${frame.dataUrl})`, '', `> 截图于 ${stamp}`];
    if (cue) {
      const translation = state.translations.get(cue.cueId);
      lines.push(`> [${formatTimecode(cue.startMs)}] ${cue.text}`);
      if (translation) lines.push(`> ${translation}`);
    }
    actions.updateNote(`${state.noteMarkdown.trimEnd()}\n\n${lines.join('\n')}\n`.trimStart());
    actions.clearFrame();
    setTab('note');
  }, [actions, state.cues, state.frame, state.noteMarkdown, state.translations]);

  const onPlayback = useCallback(
    (action: PlaybackAction, value?: number | boolean) => {
      void actions.playback(action, value);
    },
    [actions],
  );

  const summaryCueIndex = useMemo(() => cuesById, [cuesById]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>视频学习笔记</h1>
          <div className="row" style={{ gap: 2 }}>
            <button type="button" className="ghost" onClick={() => openExtensionPage('library')}>
              资料库
            </button>
            <button type="button" className="ghost" onClick={() => void openExtensionPage('options')}>
              设置
            </button>
            <button type="button" className="ghost" onClick={() => void openExtensionPage('selfcheck')} title="逐步检查字幕与自动学习的真实状态">
              自检
            </button>
          </div>
        </div>

        {state.video ? (
          <div className="video-card">
            <p className="video-title">{state.video.title}</p>
            <div className="meta-row">
              <span>{state.video.bvid}</span>
              <span>第 {state.video.pageIndex} P</span>
              <span className="spacer" />
              <button type="button" className="ghost" onClick={() => { actions.resetTask?.(); void actions.capture(); }}>
                重新识别
              </button>
            </div>
          </div>
        ) : (
          <div className="notice">
            <strong>请在视频页面打开本扩展</strong>
            打开任意含 HTML5 视频的页面后点工具栏图标；也可先查看资料库。
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" onClick={() => { actions.resetTask?.(); void actions.capture(); }}>
                重新识别当前页
              </button>
            </div>
          </div>
        )}

        <div className="section" style={{ marginTop: 10, marginBottom: 0 }}>
          <h2>播放状态与画面</h2>
          <PlaybackBar
            state={state.playback}
            disabled={false}
            onAction={onPlayback}
          />
          <p className="hint" style={{ marginTop: 6 }}>
            播放状态自动识别（每 2 秒同步）；进度跳转可直接拖动。播放/静音请在视频页面上操作——浏览器自动播放策略要求页面内用户手势，扩展按钮无法代替。
          </p>
          <div className="row" style={{ marginTop: 8 }}>
            <button type="button" onClick={() => void actions.screenshot()} disabled={!state.video}>
              截图当前画面
            </button>
            {state.frame ? (
              <>
                <button type="button" onClick={insertFrame}>
                  插入笔记
                </button>
                <button type="button" className="ghost" onClick={actions.downloadFrame}>
                  下载 PNG
                </button>
                <button type="button" className="ghost" onClick={actions.clearFrame}>
                  放弃
                </button>
              </>
            ) : (
              <span className="hint">截取视频画面（不含弹幕）</span>
            )}
          </div>
          {state.frame ? (
            <img
              src={state.frame.dataUrl}
              alt={`当前画面 ${formatTimecode(state.frame.positionMs)}`}
              style={{ marginTop: 8, width: '100%', borderRadius: 8, border: '1px solid var(--border)' }}
            />
          ) : null}
        </div>
      </header>

      <nav className="tabs" role="tablist" aria-label="学习内容">
        <button type="button" role="tab" className="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')}>
          字幕
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === 'summary'} onClick={() => setTab('summary')}>
          自动学习
        </button>
        <button type="button" role="tab" className="tab" aria-selected={tab === 'note'} onClick={() => setTab('note')}>
          笔记
        </button>
      </nav>

      <main className="panel">
        {state.notice ? (
          <div className={`notice ${state.notice.kind === 'info' ? '' : state.notice.kind}`} style={{ marginBottom: 10 }}>
            <strong>{state.notice.title}</strong>
            {state.notice.detail ? <span>{state.notice.detail}</span> : null}
            {state.notice.action ? <div className="hint">{state.notice.action}</div> : null}
          </div>
        ) : null}
        {state.settings && !state.settings.consentAcknowledged ? (
          <div className="notice" style={{ marginBottom: 10 }}>
            自动学习需要允许按播放进度发送字幕到你配置的模型服务（可能计费）。
            <button type="button" className="ghost" onClick={() => openExtensionPage('options')}>前往设置确认</button>
          </div>
        ) : null}
        {state.sitePermission ? (
          <div className="notice warn" role="alert" style={{ marginBottom: 10 }}>
            <strong>需要在 {state.sitePermission} 上启用识别</strong>
            授权后会在该站点按需注入识别脚本：只读取播放器状态与页面自身的字幕轨道，不读取页面业务数据。
            <div className="row" style={{ marginTop: 6 }}>
              <button type="button" className="primary" onClick={() => void actions.grantSiteAccess(state.sitePermission as string)}>
                允许访问此网站
              </button>
            </div>
          </div>
        ) : null}

        {tab === 'transcript' ? (
          <div className="stack">
            <div className="section">
              <h2>字幕来源</h2>
              <div className="row">
                {state.video?.platform === 'bilibili' || !state.video ? (
                  <button type="button" onClick={() => void actions.fetchTracks()} disabled={!state.context || busy}>
                    获取站方字幕轨道
                  </button>
                ) : null}
                <button type="button" onClick={() => void actions.readPageTracks()} disabled={!state.video || busy}>
                  读取页内字幕
                </button>
                <button
                  type="button"
                  onClick={() => void actions.transcribeAudio()}
                  disabled={!state.video || busy}
                  title="浏览器只能实时录制音频，需与视频时长相当的时间，期间会正常播放声音"
                >
                  从音频转写
                </button>
                <label className="checkbox" style={{ cursor: 'pointer' }}>
                  <input
                    key={fileInputKey}
                    type="file"
                    accept=".srt,.vtt,text/plain"
                    style={{ display: 'none' }}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) void actions.importSubtitleFile(file);
                      setFileInputKey((prev) => prev + 1);
                    }}
                    disabled={!state.video || busy}
                  />
                  <span className="ghost" style={{ color: 'var(--accent)' }}>
                    导入 SRT / VTT
                  </span>
                </label>
              </div>
              <p className="hint" style={{ marginTop: 6 }}>
                点「从音频转写」时会先自动尝试页面已有字幕（站方/人工字幕最准且无需录
                音）；只有都没有时才实时采集音频——10 分钟视频约需 10 分钟，期间视频会按 1
                倍速播放并出声。中途暂停不会丢掉已转写内容，恢复播放会自动续录。
              </p>
              {state.video?.platform === 'bilibili' && state.tracks.length > 0 ? (
                <div className="row" style={{ marginTop: 6 }}>
                  {state.tracks.map((track) => (
                    <button
                      key={track.id}
                      type="button"
                      className={state.track?.id === track.id ? 'primary' : ''}
                      onClick={() => void actions.loadTrack(track)}
                      disabled={busy}
                    >
                      {track.lanDoc}
                      {track.generationKind === 'ai' ? '（AI）' : ''}
                    </button>
                  ))}
                </div>
              ) : null}
              {state.transcripts.length > 1 ? (
                <div className="row" style={{ marginTop: 6 }}>
                  <span className="hint">版本：</span>
                  <select
                    value={state.transcript?.id ?? ''}
                    onChange={(event) => void actions.selectTranscript(event.target.value)}
                    aria-label="选择字幕版本"
                  >
                    {state.transcripts.map((revision) => (
                      <option key={revision.id} value={revision.id}>
                        {revision.trackLabel || revision.language} · {revision.cueCount} 条
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
              {state.transcript ? (
                <p className="hint" style={{ marginTop: 6 }}>
                  当前：{state.transcript.trackLabel || state.transcript.language} · {state.transcript.cueCount} 条 · 来源{' '}
                  {state.transcript.sourceKind} / {state.transcript.generationKind}
                </p>
              ) : null}
            </div>

            <TranscriptPanel
              cues={state.cues}
              translations={state.translations}
              disabled={busy}
              positionMs={state.playback.ready ? state.playback.positionMs : null}
              onSeek={(positionMs) => void actions.seek(positionMs)}
              onInsert={insertCues}
            />

            <div className="row">
              <button type="button" className="primary" onClick={() => void actions.translateAll()} disabled={!hasTranscript || busy}>
                {state.translations.size > 0 ? '重新翻译' : '翻译字幕'}
              </button>
              <span className="hint">
                {state.translations.size > 0 ? `已译 ${state.translations.size} 条` : '需先在设置中填写自己的 API Key'}
              </span>
            </div>
          </div>
        ) : null}

        {tab === 'summary' ? (
          <div className="stack">
            <AutoSummaryStatus
              snapshot={state.autoSummary}
              ready={Boolean(state.transcript)}
              busy={state.autoControlBusy}
              connectionError={state.autoConnectionError}
              aiReady={Boolean(state.apiKeyPresent && state.settings?.consentAcknowledged)}
              onControl={(enabled, retryFailed) => void actions.controlAutoLearning(enabled, retryFailed)}
            />
            <div className="row">
              <button
                type="button"
                className="primary"
                onClick={() => void actions.summarizeAll()}
                disabled={!hasTranscript || busy}
              >
                从字幕直接总结（全部 {state.cues.length} 条）
              </button>
              <span className="hint">按字幕多少全部总结，结果写入总结并追加到笔记。</span>
            </div>
            <SummaryPanel
              summary={state.summary}
              cueIndex={summaryCueIndex}
              onSeek={(positionMs) => void actions.seek(positionMs)}
              onInsert={insertSummary}
              live={state.autoSummary?.draft?.status === 'streaming'}
            />
            <StreamingSummaryDraft node={state.autoSummary?.draft ?? null} onSeek={(ms) => void actions.seek(ms)} />
          </div>
        ) : null}

        {tab === 'note' ? (
          <NotePanel
            markdown={state.noteMarkdown}
            saveState={state.saveState}
            disabled={!state.video}
            onChange={actions.updateNote}
            onExport={(options) => void handleExport(options)}
            onExportSrt={() => void handleExportSrt()}
          />
        ) : null}
      </main>

      <footer className="footer-bar">
        {state.task.state === 'running' ? (
          <>
            <span>
              {state.task.label} {state.task.completed}/{state.task.total}
            </span>
            <div className="progress" style={{ flex: 1, margin: '0 8px' }}>
              <span style={{ width: `${state.task.total > 0 ? (state.task.completed / state.task.total) * 100 : 0}%` }} />
            </div>
            <button type="button" onClick={actions.cancelTask}>
              取消
            </button>
          </>
        ) : (
          <>
            <span>{state.autoSummary?.draft?.status === 'streaming' ? 'SSE 后台读取中 · 可关闭弹窗' : state.apiKeyPresent ? 'AI 已配置' : 'AI 未配置，本地功能可用'}</span>
            <span className="spacer" />
            <span>{state.video ? `${state.transcripts.length} 个字幕版本` : ''}</span>
          </>
        )}
      </footer>
    </div>
  );
}
