/**
 * 回归：字幕页必须有「不配置 AI 也能用」的直接出口。
 *
 * 背景：改造前字幕只能「加入笔记」，复制/下载要绕到笔记页；
 * 用户想只要一份字幕文本时被迫配置模型或翻页。
 * 对照成熟产品的做法（字幕下拉 + 下载字幕 + 复制 Markdown 都在同一页），
 * 这里锁定：字幕页自带复制与下载，未选中时作用于全部，且失败不报假成功。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const popup = readFileSync('src/ui/PopupApp.tsx', 'utf8');
const panel = readFileSync('src/ui/TranscriptPanel.tsx', 'utf8');

describe('字幕页的直接出口（源码级）', () => {
  it('字幕面板自带复制与下载，并接到弹窗', () => {
    expect(panel).toMatch(/onCopy: \(cues: Cue\[\]\) => void;/);
    expect(panel).toMatch(/onDownload: \(cues: Cue\[\]\) => void;/);
    expect(panel).toMatch(/onClick=\{\(\) => onCopy\(chosen\)\}/);
    expect(panel).toMatch(/onClick=\{\(\) => onDownload\(chosen\)\}/);
    expect(popup).toMatch(/onCopy=\{copyCues\}/);
    expect(popup).toMatch(/onDownload=\{exportCues\}/);
  });

  it('未选中任何条目时作用于全部，而不是禁用按钮', () => {
    expect(panel).toMatch(/const chosen = useMemo\(\(\) => cues\.filter\(\(cue\) => selected\.has\(cue\.cueId\)\), \[cues, selected\]\)/);
    expect(panel).not.toMatch(/onClick=\{\(\) => onCopy\(chosen\)\} disabled=/);
    expect(popup).toMatch(/const source = selected\.length > 0 \? selected : state\.cues;/);
  });

  it('复制失败如实提示，不静默当成成功', () => {
    expect(popup).toMatch(/actions\.setNotice\(\{ kind: 'warn', title: '复制失败'/);
    expect(popup).toMatch(/title: `已复制 \$\{source\.length\} 条字幕`/);
  });

  it('字幕导出不依赖 AI 配置或字幕版本', () => {
    expect(popup).not.toMatch(/const exportCues[\s\S]{0,240}apiKeyPresent/);
  });
});
