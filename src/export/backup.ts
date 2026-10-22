/**
 * 备份与恢复（技术方案 7.3、PRD F12）。
 * - 备份使用白名单序列化，绝不含 API Key / 配置中的密钥
 * - 导入先校验再预览，最后在事务中合并；失败不清空现有资料
 * - 相同 ID 不同内容保留冲突副本
 */
import { appError, toAppError } from '../domain/errors';
import { getDb, nowIso } from '../storage/db';
import { BACKUP_SCHEMA_VERSION, type BackupEnvelope, type NoteRecord, type VideoRecord } from '../storage/types';

export interface BackupPreview {
  videos: number;
  transcripts: number;
  cues: number;
  notes: number;
  summaries: number;
  translations: number;
  conflicts: number;
  schemaVersion: number;
  exportedAt: string;
}

export async function createBackup(): Promise<BackupEnvelope> {
  const db = getDb();
  const [videos, transcripts, cues, translations, summaries, notes] = await Promise.all([
    db.videos.toArray(),
    db.transcripts.toArray(),
    db.cues.toArray(),
    db.translations.toArray(),
    db.summaries.toArray(),
    db.notes.toArray(),
  ]);
  return {
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: nowIso(),
    app: 'video-study-notes',
    videos,
    transcripts,
    cues,
    translations,
    summaries,
    notes,
  };
}

/** 导出为文件前把序列化结果再检查一次：不得出现密钥字段。 */
export function serializeBackup(envelope: BackupEnvelope): string {
  const text = JSON.stringify(envelope, null, 2);
  if (/"(?:apiKey|api_key|authorization|sessdata)"\s*:/i.test(text) || /Bearer\s+[A-Za-z0-9]/i.test(text)) {
    throw appError('STORAGE_FAILED', '备份内容包含敏感字段，已被阻止导出');
  }
  return text;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function parseBackup(raw: string): BackupEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw appError('BACKUP_INVALID', '备份文件不是合法 JSON');
  }
  if (!isRecord(parsed)) throw appError('BACKUP_INVALID', '备份文件结构不正确');
  if (parsed.app !== 'video-study-notes') throw appError('BACKUP_INVALID', '这不是本扩展的备份文件');
  const version = typeof parsed.schemaVersion === 'number' ? parsed.schemaVersion : NaN;
  if (!Number.isFinite(version)) throw appError('BACKUP_INVALID', '备份缺少 schemaVersion');
  if (version > BACKUP_SCHEMA_VERSION) {
    throw appError('BACKUP_INVALID', `备份版本 ${version} 高于当前支持的 ${BACKUP_SCHEMA_VERSION}`);
  }
  const arrays = ['videos', 'transcripts', 'cues', 'translations', 'summaries', 'notes'] as const;
  for (const key of arrays) {
    if (!Array.isArray(parsed[key])) throw appError('BACKUP_INVALID', `备份缺少 ${key} 数组`);
  }
  return parsed as unknown as BackupEnvelope;
}

export async function previewBackup(envelope: BackupEnvelope): Promise<BackupPreview> {
  const db = getDb();
  let conflicts = 0;
  for (const note of envelope.notes) {
    const existing = await db.notes.get(note.id);
    if (existing && existing.markdown !== note.markdown) conflicts += 1;
  }
  return {
    videos: envelope.videos.length,
    transcripts: envelope.transcripts.length,
    cues: envelope.cues.length,
    notes: envelope.notes.length,
    summaries: envelope.summaries.length,
    translations: envelope.translations.length,
    conflicts,
    schemaVersion: envelope.schemaVersion,
    exportedAt: envelope.exportedAt,
  };
}

/**
 * 合并导入：在单个事务中执行，任何异常回滚。
 * 冲突笔记另存副本，不改动当前版本。
 */
export async function restoreBackup(envelope: BackupEnvelope, allowConflicts = true): Promise<{ importedNotes: number; conflictCopies: number }> {
  const db = getDb();
  try {
    return await db.transaction(
      'rw',
      [db.videos, db.transcripts, db.cues, db.translations, db.summaries, db.notes],
      async () => {
        const stamp = nowIso();
        let importedNotes = 0;
        let conflictCopies = 0;

        for (const video of envelope.videos) {
          await db.videos.put(video as VideoRecord);
        }
        for (const transcript of envelope.transcripts) {
          await db.transcripts.put(transcript);
        }
        for (const cue of envelope.cues) {
          await db.cues.put(cue);
        }
        for (const translation of envelope.translations) {
          await db.translations.put(translation);
        }
        for (const summary of envelope.summaries) {
          await db.summaries.put(summary);
        }

        for (const note of envelope.notes) {
          const existing = await db.notes.get(note.id);
          if (!existing) {
            await db.notes.put(note);
            importedNotes += 1;
            continue;
          }
          if (existing.markdown === note.markdown) continue;
          if (!allowConflicts) {
            throw appError('BACKUP_INVALID', '存在同名但内容不同的笔记，已取消导入');
          }
          const copy: NoteRecord = {
            ...note,
            id: `${note.id}#conflict-${Date.now().toString(36)}`,
            revision: 1,
            updatedAt: stamp,
          };
          await db.notes.put(copy);
          conflictCopies += 1;
        }
        return { importedNotes, conflictCopies };
      },
    );
  } catch (cause) {
    throw toAppError(cause, 'STORAGE_FAILED', '恢复备份失败，已有资料未改动');
  }
}
