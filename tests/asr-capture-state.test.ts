/**
 * 回归：插入耳机不是「页面静音」。
 *
 * 历史缺陷（本轮修复）：
 * 1. `captureDiscontinuity` 把 `volume <= 0` 与 `muted` 混为一谈，都判成「播放器已静音」；
 * 2. 任何一次不连续都 `stop(discard = true)`，把已经录到的真实语音一起丢掉；
 * 3. 一片字幕都没有时后台无条件报 `NO_SPEECH`，文案还写着「请确认播放未暂停或静音」。
 *
 * 三者叠加的结果：插拔耳机（Chrome 会因输出设备变化重建标签页音频输出，采集到的是数字静音）
 * 被显示成「未识别到语音 · 请确认没有静音」，看起来就像扩展把页面判成了静音。
 */
import { describe, expect, it } from 'vitest';
import {
  ASR_MUTE_CONFIRM_SAMPLES, ASR_SILENCE_LIMIT_MS, ASR_SILENCE_PEAK, ASR_STALL_LIMIT_MS, captureIssue,
  describeNoSpeech, isPlayerMuted, shouldStopForSilence, stopAdvice, type CaptureSample,
} from '../src/asr/tab-protocol';

const base: CaptureSample = { positionMs: 10_000, durationMs: 600_000, paused: false, muted: false, volume: 1, playbackRate: 1 };

describe('静音状态只由真实静音操作决定', () => {
  it('只有 video.muted === true 才算静音', () => {
    expect(isPlayerMuted({ ...base, muted: true })).toBe(true);
    expect(isPlayerMuted({ ...base, muted: false, volume: 1 })).toBe(false);
    // 音量 0 不是静音操作：页面可能只是把音量拉到最小，静音开关并没有打开。
    expect(isPlayerMuted({ ...base, muted: false, volume: 0 })).toBe(false);
  });

  it('只是插入耳机（播放状态毫无变化）不会被判成静音', () => {
    // 设备切换发生在浏览器音频层，不会改动 video.muted / volume / currentTime。
    const afterPluggingHeadphones: CaptureSample = { ...base, positionMs: 11_000 };
    expect(captureIssue(base, afterPluggingHeadphones, 1_000)).toBeNull();
    expect(isPlayerMuted(afterPluggingHeadphones)).toBe(false);
  });

  it('真实静音操作会停止采集，但保留已录分片', () => {
    const issue = captureIssue(base, { ...base, positionMs: 11_000, muted: true }, 1_000);
    expect(issue).toMatchObject({ kind: 'muted', discard: false, stop: true });
    expect(issue?.reason).toContain('已静音');
  });

  it('单次静音读数不足以结束整场录音（需要连续确认）', () => {
    // 播放器重置状态时会短暂读到 muted=true，这不是用户操作。
    expect(ASR_MUTE_CONFIRM_SAMPLES).toBeGreaterThanOrEqual(2);
  });

  it('音量为 0 只说明采集不到声音，不说「静音」，也不停止、不丢分片', () => {
    const issue = captureIssue(base, { ...base, positionMs: 11_000, volume: 0 }, 1_000);
    expect(issue).toMatchObject({ kind: 'silent-volume', discard: false, stop: false });
    // 关键：文案里不能出现「静音」——否则用户会以为扩展认定页面被静音了。
    expect(issue?.reason).not.toContain('静音');
  });

  it('暂停保留已录分片且不结束会话，倍速与跳转才丢弃', () => {
    expect(captureIssue(base, { ...base, positionMs: 11_000, paused: true }, 1_000))
      .toMatchObject({ kind: 'paused', discard: false, stop: false });
    expect(captureIssue(base, { ...base, positionMs: 11_000, playbackRate: 2 }, 1_000))
      .toMatchObject({ kind: 'rate', discard: true, stop: true });
    expect(captureIssue(base, { ...base, positionMs: 60_000 }, 1_000))
      .toMatchObject({ kind: 'seek', discard: true, stop: true });
  });

  it('正常推进不产生任何判定', () => {
    expect(captureIssue(base, { ...base, positionMs: 10_900 }, 1_000)).toBeNull();
  });
});

describe('没有字幕时按采集证据归因，而不是一律说「未识别到语音」', () => {
  const evidence = {
    chunks: 2, silentChunks: 0, emptyParts: 0, deviceChanged: false, trackEnded: false,
    peak: 0.3, contextRunning: true,
  };

  it('一个分片都没产出时，用录音器记录的停止原因说话（不再猜「暂停/静音/跳转」）', () => {
    const error = describeNoSpeech({
      ...evidence, chunks: 0, silentChunks: 0,
      stopKind: 'stall', stopReason: '播放位置超过 15 秒没有推进，采集已停止',
    });
    expect(error.code).toBe('CAPTURE_INTERRUPTED');
    expect(error.message).toBe('播放位置超过 15 秒没有推进，采集已停止');
    expect(error.detail).toContain('让视频真正播放起来');
  });

  it('每个停止原因都给出各自的建议，不压成一句话', () => {
    const advice = (kind: Parameters<typeof stopAdvice>[0]) => stopAdvice(kind);
    const all = (['stall', 'mute', 'volume', 'pause', 'timeline', 'track-ended',
      'queue-full', 'failed', 'requested', 'limit', 'closed', 'ended'] as const).map(advice);
    expect(new Set(all).size).toBe(all.length);
    expect(advice('mute')).toContain('静音');
    expect(advice('track-ended')).toContain('耳机');
    expect(advice('timeline')).toContain('倍速');
    expect(advice(undefined)).toContain('重新开始转写');
  });

  it('真正没拿到音频数据 → CAPTURE_UNAVAILABLE（与静音无关）', () => {
    const error = describeNoSpeech({ ...evidence, chunks: 0, emptyParts: 1, stopKind: 'stall' });
    expect(error.code).toBe('CAPTURE_UNAVAILABLE');
    expect(error.message).toContain('没有产出音频数据');
  });

  it('采集到的全是数字静音 → CAPTURE_SILENT，并明确页面并未静音', () => {
    const error = describeNoSpeech({ ...evidence, silentChunks: 2, peak: 0 });
    expect(error.code).toBe('CAPTURE_SILENT');
    expect(error.detail).toContain('页面未静音');
  });

  it('静音且期间切换过输出设备 → CAPTURE_SILENT，并点名耳机/设备变化', () => {
    const error = describeNoSpeech({ ...evidence, silentChunks: 2, peak: 0, deviceChanged: true });
    expect(error.code).toBe('CAPTURE_SILENT');
    expect(error.detail).toContain('音频输出设备');
    expect(error.detail).toContain('耳机');
  });

  it('有分片但全是静音，且停止原因是「没在播放」→ 用播放原因说明，不误报成数字静音', () => {
    const error = describeNoSpeech({
      ...evidence, silentChunks: 2, peak: 0,
      stopKind: 'stall', stopReason: '播放位置超过 15 秒没有推进，采集已停止',
    });
    expect(error.code).toBe('CAPTURE_INTERRUPTED');
    expect(error.message).toContain('没有推进');
  });

  it('有声音但采集中断 → CAPTURE_INTERRUPTED', () => {
    expect(describeNoSpeech({ ...evidence, trackEnded: true }).code).toBe('CAPTURE_INTERRUPTED');
    expect(describeNoSpeech({ ...evidence, deviceChanged: true }).code).toBe('CAPTURE_INTERRUPTED');
  });

  it('有声音、没有中断、也没有分段 → NO_SPEECH，且不再指责用户静音', () => {
    const error = describeNoSpeech(evidence);
    expect(error.code).toBe('NO_SPEECH');
    expect(error.message).toContain('采集到了声音');
    expect(error.detail ?? '').not.toContain('静音');
  });

  it('没有任何证据时如实说「没产出分片」，不冒充「没识别到语音」', () => {
    const error = describeNoSpeech(undefined);
    expect(error.code).toBe('CAPTURE_INTERRUPTED');
    expect(error.message).toContain('第一个分片前就结束');
    expect(error.message).not.toContain('未识别到语音');
  });

  it('静音阈值是一个可判定的正数', () => {
    expect(ASR_SILENCE_PEAK).toBeGreaterThan(0);
    expect(ASR_SILENCE_PEAK).toBeLessThan(0.01);
  });

  it('停滞判定窗口足够长，缓冲或短暂卡顿不会被当成「没在播放」', () => {
    // 曾经是 6 秒，和 5 秒基线兜底叠在一起，几乎必然误杀刚开始的会话。
    expect(ASR_STALL_LIMIT_MS).toBeGreaterThanOrEqual(10_000);
  });
});

describe('自动停止的判据：音频静音 + 位置冻结，两者同时成立', () => {
  it('位置冻结但音频还在响 → 不停止（本轮误停就是这种情形）', () => {
    // 页面上报链路断了/被 SW 回收，但标签页音频仍在正常采集。
    expect(shouldStopForSilence(1_000, 60_000)).toBe(false);
  });

  it('音频静音但位置在推进 → 不停止（视频里可能本来就有无人声片段）', () => {
    expect(shouldStopForSilence(60_000, 1_000)).toBe(false);
  });

  it('既没有声音、位置也没有推进 → 停止', () => {
    expect(shouldStopForSilence(ASR_SILENCE_LIMIT_MS + 1, ASR_STALL_LIMIT_MS + 1)).toBe(true);
  });

  it('静音窗口必须比停滞窗口更长，避免把短暂卡顿当成结束', () => {
    expect(ASR_SILENCE_LIMIT_MS).toBeGreaterThan(ASR_STALL_LIMIT_MS);
  });
});
