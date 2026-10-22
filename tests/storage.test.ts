import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StudyDatabase, getCues, getNote, listLibrary, replaceTranscriptCues, saveNote, saveTranscript, saveTranslation, setDbForTests, upsertVideo } from '../src/storage/db';
import type { VideoRecord } from '../src/storage/types';

const video: VideoRecord = {
  id: 'bilibili:BV1GJ411x7h7:111',
  platform: 'bilibili',
  bvid: 'BV1GJ411x7h7',
  aid: '1001',
  cid: '111',
  pageIndex: 1,
  title: '测试视频',
  canonicalUrl: 'https://www.bilibili.com/video/BV1GJ411x7h7/?p=1',
  durationMs: 60_000,
  tags: [],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const cues = [
  { cueId: 'native-0', sequence: 0, startMs: 0, endMs: 1000, text: '第一句', sourceIndex: 0 },
  { cueId: 'native-1', sequence: 1, startMs: 1000, endMs: 2000, text: '第二句', sourceIndex: 1 },
];

let db: StudyDatabase;
let counter = 0;

beforeEach(async () => {
  counter += 1;
  db = new StudyDatabase(`test-db-${counter}`);
  setDbForTests(db);
  await db.open();
  await upsertVideo(video);
});

afterEach(async () => {
  await db.delete();
  setDbForTests(null);
});

describe('本地仓储', () => {
  it('相同视频重复打开不会创建两条记录', async () => {
    await upsertVideo({ ...video, title: '更新后的标题' });
    expect(await db.videos.count()).toBe(1);
    expect((await db.videos.get(video.id))?.title).toBe('更新后的标题');
  });

  it('相同 sourceHash 复用字幕版本，内容变化新建版本', async () => {
    const first = await saveTranscript({
      videoId: video.id,
      language: 'zh-CN',
      sourceKind: 'native',
      generationKind: 'human',
      trackLabel: '中文',
      sourceHash: 'hash-a',
      cues,
    });
    expect(first.reused).toBe(false);

    const again = await saveTranscript({
      videoId: video.id,
      language: 'zh-CN',
      sourceKind: 'native',
      generationKind: 'human',
      trackLabel: '中文',
      sourceHash: 'hash-a',
      cues,
    });
    expect(again.reused).toBe(true);
    expect(again.revision.id).toBe(first.revision.id);

    const changed = await saveTranscript({
      videoId: video.id,
      language: 'zh-CN',
      sourceKind: 'native',
      generationKind: 'human',
      trackLabel: '中文',
      sourceHash: 'hash-b',
      cues,
    });
    expect(changed.revision.id).not.toBe(first.revision.id);
    expect(await db.transcripts.count()).toBe(2);
  });

  it('保存的字幕条目按顺序读回', async () => {
    const { revision } = await saveTranscript({
      videoId: video.id,
      language: 'zh-CN',
      sourceKind: 'srt',
      generationKind: 'unknown',
      trackLabel: 'import.srt',
      sourceHash: 'hash-c',
      cues,
    });
    const stored = await getCues(revision.id);
    expect(stored.map((cue) => cue.text)).toEqual(['第一句', '第二句']);
  });

  it('笔记使用乐观并发，旧版本写入被拒绝且不覆盖新内容', async () => {
    const first = await saveNote(video.id, '我的笔记', 0);
    expect(first.revision).toBe(1);
    await expect(saveNote(video.id, '覆盖', 0)).rejects.toThrowError(/其他窗口更新/);
    expect((await getNote(video.id))?.markdown).toBe('我的笔记');
    const second = await saveNote(video.id, '更新后的笔记', 1);
    expect(second.revision).toBe(2);
  });

  it('资料库搜索覆盖标题与笔记正文', async () => {
    await saveNote(video.id, '这是一条关于闭包的笔记', 0);
    expect((await listLibrary('闭包')).map((item) => item.video.id)).toEqual([video.id]);
    expect(await listLibrary('不存在')).toHaveLength(0);
  });

  it('译文与原文分开保存', async () => {
    await saveTranslation({
      id: 'tr-1',
      videoId: video.id,
      transcriptId: 'tr-x',
      targetLanguage: '简体中文',
      cacheKey: 'key-1',
      items: [{ cueId: 'native-0', translatedText: '译一' }],
      status: 'complete',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    const originals = await db.cues.count();
    expect(originals).toBe(0);
    expect(await db.translations.count()).toBe(1);
  });
  it('边采边显示时原地扩充同一版本，后续时间段能读到新字幕', async () => {
    const { revision } = await saveTranscript({
      videoId: video.id, language: 'auto', sourceKind: 'asr', generationKind: 'ai',
      trackLabel: '本地转写（进行中）', sourceHash: 'hash-live', cues: cues.slice(0, 1),
    });
    const grown = [
      ...cues,
      { cueId: 'asr-2', sequence: 2, startMs: 130_000, endMs: 131_000, text: '两分多钟的一句', sourceIndex: 2 },
    ];
    const updated = await replaceTranscriptCues(revision.id, grown);
    expect(updated.id).toBe(revision.id);
    expect(updated.cueCount).toBe(3);
    expect((await getCues(revision.id)).map((cue) => cue.startMs)).toEqual([0, 1000, 130_000]);
    // 旧版本不能被复制成第二个版本：库里仍只有这一版。
    expect(await db.transcripts.count()).toBe(1);
  });

  it('版本不存在时明确失败，不静默写入孤儿字幕', async () => {
    await expect(replaceTranscriptCues('tr-missing', cues)).rejects.toThrowError(/已不存在/);
    expect(await db.cues.count()).toBe(0);
  });
});
