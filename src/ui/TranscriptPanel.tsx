import { useEffect, useMemo, useRef, useState } from 'react';
import { formatTimecode } from '../domain/transcript';
import type { Cue } from '../domain/transcript';
import { activeCueAt, cueAtCapture, cueExcerpt, type ExcerptRadius } from './followCue';

interface Props {
  cues: Cue[];
  translations: Map<string, string>;
  disabled: boolean;
  onSeek: (positionMs: number) => void;
  onInsert: (cues: Cue[]) => void;
  /** 当前播放位置；缺省时不做跟随，行为与旧版一致。 */
  positionMs?: number | null;
}

/** 字幕列表：时间戳跳转、搜索、选段加入笔记、跟随播放。 */
export function TranscriptPanel({ cues, translations, disabled, onSeek, onInsert, positionMs = null }: Props) {
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  /** 用户滚动或搜索时暂停跟随，避免抢走阅读位置。 */
  const [paused, setPaused] = useState(false);
  const [radius, setRadius] = useState<ExcerptRadius>(1);
  const listRef = useRef<HTMLUListElement | null>(null);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return cues;
    return cues.filter((cue) => {
      const translation = translations.get(cue.cueId) ?? '';
      return cue.text.toLowerCase().includes(keyword) || translation.toLowerCase().includes(keyword);
    });
  }, [cues, query, translations]);

  const toggle = (cueId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(cueId)) next.delete(cueId);
      else next.add(cueId);
      return next;
    });
  };

  const insertSelected = () => {
    const chosen = cues.filter((cue) => selected.has(cue.cueId));
    if (chosen.length === 0) return;
    // 摘录半径：把选中段前后各扩几条，保留上下文；顺序仍按原文。
    const wanted = new Set(chosen.map((cue) => cue.cueId));
    const excerpt = cues.filter((cue) => wanted.has(cue.cueId) ||
      chosen.some((anchor) => cueExcerpt(cues, anchor, radius).some((near) => near.cueId === cue.cueId)));
    onInsert(excerpt.length > 0 ? excerpt : chosen);
    setSelected(new Set());
  };

  const active = useMemo(() => activeCueAt(cues, positionMs), [cues, positionMs]);
  /** 截图通常发生在“刚说完”之后：按钮上显示当前或刚结束的那条。 */
  const captureCue = useMemo(() => cueAtCapture(cues, positionMs), [cues, positionMs]);

  // 跟随播放：未暂停且未搜索时，把当前字幕滚入可视区。
  useEffect(() => {
    if (paused || query || !active || !listRef.current) return;
    const node = listRef.current.querySelector(`[data-cue-id="${CSS.escape(active.cueId)}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, paused, query]);
  if (cues.length === 0) {
    return <div className="empty">还没有字幕。获取字幕轨道，或导入 SRT / VTT 文件。</div>;
  }

  return (
    <div className="stack">
      <div className="row">
        <input
          type="search"
          placeholder="搜索字幕或译文"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="搜索字幕"
        />
      </div>
      <div className="row">
        <span className="hint">
          共 {cues.length} 条{query ? `，匹配 ${filtered.length} 条` : ''}
          {active ? ` · 当前 ${formatTimecode(active.startMs)}` : ''}
        </span>
        <span className="spacer" />
        {paused && active ? (
          <button type="button" className="ghost" onClick={() => setPaused(false)}>继续跟随</button>
        ) : null}
        <label className="hint" title="加入笔记时额外带上前后各几条字幕">
          上下文
          <select
            value={radius}
            onChange={(event) => setRadius(Number(event.target.value) as ExcerptRadius)}
            aria-label="加入笔记时附带的上下文条数"
          >
            <option value={0}>不带</option>
            <option value={1}>±1 条</option>
            <option value={2}>±2 条</option>
          </select>
        </label>
        <button type="button" className="ghost" onClick={insertSelected} disabled={selected.size === 0}>
          加入笔记（{selected.size}）
        </button>
      </div>
      {captureCue ? (
        <p className="hint">
          截图会附上 [{formatTimecode(captureCue.startMs)}] 这一句的字幕。
        </p>
      ) : null}
      <ul
        className="cue-list"
        ref={listRef}
        onWheel={() => { if (active && !paused) setPaused(true); }}
      >
        {filtered.slice(0, 400).map((cue) => {
          const translation = translations.get(cue.cueId);
          const isSelected = selected.has(cue.cueId);
          const isActive = active?.cueId === cue.cueId;
          return (
            <li
              key={cue.cueId}
              data-cue-id={cue.cueId}
              aria-current={isActive ? 'true' : undefined}
              className={`cue${isSelected ? ' selected' : ''}${isActive ? ' active' : ''}`}
              onClick={() => toggle(cue.cueId)}
              onDoubleClick={() => onSeek(cue.startMs)}
              title="单击选择，双击跳转到该时间"
            >
              <button
                type="button"
                className="cue-time"
                style={{ border: 'none', background: 'none', padding: 0, cursor: 'pointer' }}
                onClick={(event) => {
                  event.stopPropagation();
                  onSeek(cue.startMs);
                }}
                disabled={disabled}
                aria-label={`跳转到 ${formatTimecode(cue.startMs)}`}
              >
                {formatTimecode(cue.startMs)}
              </button>
              <span className="cue-body">
                {cue.text}
                {translation ? <span className="cue-translation">{translation}</span> : null}
              </span>
            </li>
          );
        })}
      </ul>
      {filtered.length > 400 ? (
        <p className="hint">仅显示前 400 条匹配结果，请用搜索缩小范围。</p>
      ) : null}
    </div>
  );
}
