/**
 * 回归：优先使用视频已有字幕时的候选排序。
 *
 * 为什么不直接用第一条：同一视频常同时存在人工/官方字幕与自动生成字幕，
 * 自动字幕（YouTube `kind=asr`、B站 ai 字幕）错字明显更多，
 * 若顺序取错，用户会以为「转写质量差」，其实是选错了来源。
 */
import { describe, expect, it } from 'vitest';
import { pickDefaultTrack, rankCaptionTracks } from '../src/domain/page-tracks';

const manualEn = { language: 'en', label: 'English', kind: 'subtitles' };
const autoEn = { language: 'en', label: 'English (auto-generated)', kind: 'asr' };
const manualZh = { language: 'zh-Hans', label: '中文（简体）', kind: 'subtitles' };
const autoZh = { language: 'zh-Hans', label: '中文（自动生成）', kind: 'asr' };
const biliAi = { language: 'zh', label: '中文（自动）', generationKind: 'ai' };

describe('字幕候选排序：人工优先，其次语言', () => {
  it('人工字幕排在任何自动字幕之前', () => {
    const ranked = rankCaptionTracks([autoZh, manualEn, autoEn, manualZh]);
    expect(ranked[0]).toBe(manualZh);
    // 前两位必须都是人工字幕。
    expect([ranked[0]!.kind, ranked[1]!.kind]).toEqual(['subtitles', 'subtitles']);
  });

  it('同为人造字幕时优先中文', () => {
    const ranked = rankCaptionTracks([manualEn, manualZh]);
    expect(ranked[0]).toBe(manualZh);
  });

  it('自动生成字幕按 kind=asr 与 generationKind=ai 都能识别', () => {
    const ranked = rankCaptionTracks([autoZh, biliAi, manualEn]);
    expect(ranked[0]).toBe(manualEn);
  });

  it('只有自动字幕时仍然可用，不返回空', () => {
    const ranked = rankCaptionTracks([autoEn, autoZh]);
    expect(ranked).toHaveLength(2);
    expect(ranked[0]).toBe(autoZh);
  });

  it('没有更好候选时保持站点原始顺序（稳定排序）', () => {
    const ranked = rankCaptionTracks([manualEn, manualZh]);
    expect(ranked.map((track) => track.label)).toEqual(['中文（简体）', 'English']);
    const sameRank = rankCaptionTracks([autoEn, { language: 'ja', label: '日本語', kind: 'asr' }]);
    expect(sameRank[0]).toBe(autoEn);
  });

  it('空列表返回空，不编造轨道', () => {
    expect(rankCaptionTracks([])).toEqual([]);
  });

  it('pickDefaultTrack 仍然可用（旧路径不受影响）', () => {
    expect(pickDefaultTrack([manualEn, manualZh])).toBe(manualZh);
    expect(pickDefaultTrack([])).toBeNull();
  });
});
