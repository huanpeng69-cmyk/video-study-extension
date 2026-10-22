import { useEffect, useState } from 'react';
import { formatTimecode } from '../domain/transcript';
import type { PlaybackAction, VideoState } from '../lib/messages';

interface Props {
  state: VideoState;
  disabled: boolean;
  onAction: (action: PlaybackAction, value?: number | boolean) => void;
}

/**
 * 播放状态显示 + 进度跳转。
 *
 * 已删除播放/暂停、静音、倍速、音量控制按钮：这些动作都依赖
 * 「页面内的用户手势」，扩展按钮必然被浏览器自动播放策略拒绝，
 * 留着只会给用户「名存实亡」的挫败感。这里只如实显示状态，
 * 进度跳转（currentTime）不需要手势，保留为可用功能。
 */
export function PlaybackBar({ state, disabled, onAction }: Props) {
  const knownDuration = state.durationMs > 0;
  const duration = knownDuration ? state.durationMs : 1;
  /** 拖动中的临时值；null 表示未在拖动，直接跟随真实状态。 */
  const [dragSeek, setDragSeek] = useState<number | null>(null);

  // 真实状态追平后交还控制权，避免本地值长期压住真实状态。
  useEffect(() => {
    if (dragSeek !== null && Math.abs(state.positionMs - dragSeek) < 1_000) setDragSeek(null);
  }, [state.positionMs, dragSeek]);

  const shownPositionMs = dragSeek ?? state.positionMs;
  const seekValue = Math.min(shownPositionMs, duration);
  const percent = Math.min(100, Math.max(0, (shownPositionMs / duration) * 100));

  const commitSeek = () => {
    if (dragSeek === null) return;
    onAction('seek', dragSeek);
  };

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 6 }}>
        {/* 播放状态只做识别，不再提供控制按钮：
            浏览器自动播放策略要求页面内用户手势，扩展按钮必然被拒绝，
            留着只会误导用户。暂停时给一句明确说明。 */}
        <span className="hint" role="status" aria-live="polite">
          {state.paused ? '⏸ 未在播放' : '▶ 播放中'}
        </span>
        <span className="hint" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {formatTimecode(shownPositionMs)} / {formatTimecode(state.durationMs)}
        </span>
        <span className="spacer" />
        <span className="hint">音量 {Math.round(state.volume * 100)}%{state.muted ? '（静音）' : ''}</span>
      </div>

      <div className="row" style={{ gap: 8 }}>
        <input
          type="range"
          min={0}
          max={duration}
          step={1_000}
          value={seekValue}
          onChange={(event) => setDragSeek(Number(event.target.value))}
          onPointerUp={commitSeek}
          onPointerCancel={commitSeek}
          onKeyUp={commitSeek}
          onBlur={commitSeek}
          disabled={disabled || !knownDuration}
          aria-label="播放进度"
          style={{ flex: 1, padding: 0 }}
        />
      </div>
      <div className="progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
      {state.paused ? (
        <p className="hint">视频未在播放。浏览器自动播放策略要求先在视频页面上点一次播放，扩展按钮无法代替。</p>
      ) : null}
      {!state.ready ? <p className="hint">等待播放器状态…（在视频页播放一下即可同步）</p> : null}
      {state.ready && !knownDuration ? (
        <p className="hint">尚未取到视频时长，进度暂不可拖动；播放几秒后会自动就绪。</p>
      ) : null}
    </div>
  );
}
