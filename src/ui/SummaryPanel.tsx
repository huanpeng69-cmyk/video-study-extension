import type { SummaryRecord } from '../storage/types';
import type { SummaryBlock, SummarySection } from '../domain/aiResult';
import type { Cue } from '../domain/transcript';
import { formatTimecode } from '../domain/transcript';
import { sectionOrdinal } from '../export/markdown';

interface Props {
  summary: SummaryRecord | null;
  cueIndex: Map<string, Cue>;
  onSeek: (positionMs: number) => void;
  onInsert: (markdown: string) => void;
  /** 正在生成中：显示「仍在继续」，而不是「这是未完成的总结」。 */
  live?: boolean;
}

function citedTime(ids: string[], cueIndex: Map<string, Cue>): number | null {
  const first = ids.map((id) => cueIndex.get(id)).find(Boolean);
  return first ? first.startMs : null;
}

/** 段落与条目共用：都带可点击的时间引用（引用来自原字幕，不由模型生成）。 */
function Block({
  block,
  cueIndex,
  onSeek,
  kind,
}: {
  block: SummaryBlock;
  cueIndex: Map<string, Cue>;
  onSeek: (positionMs: number) => void;
  kind: 'paragraph' | 'bullet';
}) {
  const start = citedTime(block.sourceCueIds, cueIndex);
  const cite =
    start !== null ? (
      <button type="button" className="cite" onClick={() => onSeek(start)}>
        [{formatTimecode(start)}]
      </button>
    ) : (
      <span className="cite" style={{ color: 'var(--text-soft)' }}>
        [无可用原文]
      </span>
    );
  if (kind === 'bullet') {
    return (
      <p className="summary-point">
        · {block.text} {cite}
      </p>
    );
  }
  return (
    <p className="summary-para">
      {block.text} {cite}
    </p>
  );
}

function SectionView({
  section,
  index,
  cueIndex,
  onSeek,
}: {
  section: SummarySection;
  index: number;
  cueIndex: Map<string, Cue>;
  onSeek: (positionMs: number) => void;
}) {
  return (
    <div className="section">
      <h2>
        {sectionOrdinal(index)}
        {section.title}
      </h2>
      {section.paragraphs.map((block, blockIndex) => (
        <Block key={`p-${blockIndex}`} block={block} cueIndex={cueIndex} onSeek={onSeek} kind="paragraph" />
      ))}
      {section.bullets.map((block, blockIndex) => (
        <Block key={`b-${blockIndex}`} block={block} cueIndex={cueIndex} onSeek={onSeek} kind="bullet" />
      ))}
    </div>
  );
}

/**
 * 总结面板：按「一、二、三……」编号章节展示，章节内混排正文段落与列表条目。
 * 结构与导出的 Markdown 完全一致，避免界面与导出两套排版。
 */
export function SummaryPanel({ summary, cueIndex, onSeek, onInsert, live = false }: Props) {
  if (!summary) {
    return <div className="empty">还没有通过校验的学习小节。字幕就绪并完成服务授权后，播放每到达 30 秒节点会自动读取。</div>;
  }
  const payload = summary.payload;
  const sections: SummarySection[] = [payload.opening, ...payload.sections];
  /** 导出与「复制到笔记」使用同一份 Markdown 结构。 */
  const toMarkdown = (): string => {
    const lines: string[] = [];
    sections.forEach((section, index) => {
      lines.push(`### ${sectionOrdinal(index)}${section.title}`, '');
      for (const block of section.paragraphs) {
        const start = citedTime(block.sourceCueIds, cueIndex);
        lines.push(start !== null ? `${block.text}（${formatTimecode(start)}）` : block.text, '');
      }
      for (const block of section.bullets) {
        const start = citedTime(block.sourceCueIds, cueIndex);
        lines.push(start !== null ? `- ${block.text}（${formatTimecode(start)}）` : `- ${block.text}`);
      }
      lines.push('');
    });
    return lines.join('\n').trimEnd();
  };

  return (
    <div className="stack">
      {summary.coverage === 'partial' ? (
        <div className={live ? 'notice info' : 'notice warn'}>
          <strong>{summary.autoStream ? '按播放节点累计的学习小节' : live ? '正在生成中' : '这是未完成的总结'}</strong>
          {summary.autoStream
            ? '仅展示已通过引用校验的节点；未观看、无字幕或失败的区间不代表视频没有讲。后续内容独立追加，不再整片合并重写。'
            : '只覆盖部分字幕，未覆盖的内容不代表视频没有讲。'}
        </div>
      ) : null}
      {sections.map((section, index) => (
        <SectionView key={`${index}-${section.title}`} section={section} index={index} cueIndex={cueIndex} onSeek={onSeek} />
      ))}

      <div className="row">
        <span className="hint">
          基于字幕整理 · {summary.providerSnapshot.modelId} · {new Date(summary.createdAt).toLocaleString()}
        </span>
        <span className="spacer" />
        <button type="button" onClick={() => onInsert(toMarkdown())}>
          复制到笔记
        </button>
      </div>
    </div>
  );
}
