import { useMemo, useState } from 'react';
import DOMPurify from 'dompurify';
import { marked } from 'marked';

interface Props {
  markdown: string;
  saveState: 'idle' | 'pending' | 'saved' | 'error';
  disabled: boolean;
  onChange: (markdown: string) => void;
  onExport: (options: { includeTranscript: boolean; includeSummary: boolean }) => void;
  onExportSrt: () => void;
}

marked.setOptions({ gfm: true, breaks: true });

/** 笔记面板：Markdown 编辑 + 安全预览 + 导出。 */
export function NotePanel({ markdown, saveState, disabled, onChange, onExport, onExportSrt }: Props) {
  const [showPreview, setShowPreview] = useState(false);
  const [includeTranscript, setIncludeTranscript] = useState(false);
  const [includeSummary, setIncludeSummary] = useState(true);

  // 预览只用本地解析器 + DOMPurify，不加载远程脚本，禁用危险协议。
  const safeHtml = useMemo(() => {
    if (!showPreview) return '';
    const raw = marked.parse(markdown, { async: false }) as string;
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [markdown, showPreview]);

  const saveLabel =
    saveState === 'saved'
      ? '已保存'
      : saveState === 'pending'
        ? '保存中…'
        : saveState === 'error'
          ? '未保存'
          : '尚未修改';

  return (
    <div className="stack">
      <div className="row">
        <span className="hint">Markdown 编辑，停止输入后自动保存</span>
        <span className="spacer" />
        <button type="button" className="ghost" onClick={() => setShowPreview((prev) => !prev)}>
          {showPreview ? '返回编辑' : '预览'}
        </button>
      </div>
      {showPreview ? (
        // safeHtml 已由 DOMPurify 过滤，仅展示本地内容。
        <div className="preview" dangerouslySetInnerHTML={{ __html: safeHtml }} />
      ) : (
        <textarea
          value={markdown}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          placeholder={'在这里写自己的理解。\n\n可以从字幕或总结里“加入笔记”，AI 生成结果不会覆盖这里的内容。'}
          aria-label="笔记内容"
        />
      )}
      <div className="row">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeSummary}
            onChange={(event) => setIncludeSummary(event.target.checked)}
          />
          导出含总结
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={includeTranscript}
            onChange={(event) => setIncludeTranscript(event.target.checked)}
          />
          导出含全文字幕
        </label>
      </div>
      <div className="row">
        <button type="button" onClick={() => onExport({ includeTranscript, includeSummary })} disabled={disabled}>
          导出 Markdown
        </button>
        <button type="button" onClick={onExportSrt} disabled={disabled}>
          导出 SRT
        </button>
        <span className="spacer" />
        <span className="hint" aria-live="polite">
          {saveLabel}
        </span>
      </div>
    </div>
  );
}
