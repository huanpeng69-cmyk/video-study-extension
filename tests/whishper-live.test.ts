/**
 * 真实 Whishper 集成测试（可选执行）。
 *
 * 只有本机 `http://127.0.0.1:8082` 上确实跑着 Whishper 容器时才执行，
 * 否则整组 skip——不把「没有 Docker」当成通过，也不在 CI 里制造假失败。
 *
 * 运行前准备（一次性）：
 *   docker cp whishper:/tmp/probe.wav <项目>\Temp\probe.wav
 * 或把任意一段 1–3 秒的 wav 放到 `Temp/probe.wav`。
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkWhishper, transcribeWhishper } from '../src/asr/whishper';
import type { LocalWhisperConfig } from '../src/asr/local-whisper';

const BASE = 'http://127.0.0.1:8082';
const PROBE = 'Temp/probe.wav';
const config: LocalWhisperConfig = { baseUrl: BASE, language: '', backend: 'whishper', model: 'tiny' };

async function reachable(): Promise<boolean> {
  try {
    const response = await fetch(`${BASE}/api/transcriptions`, { signal: AbortSignal.timeout(3_000) });
    return response.ok;
  } catch {
    return false;
  }
}

const alive = await reachable();
const hasProbe = existsSync(PROBE);

describe.skipIf(!alive)('真实 Whishper 服务', () => {
  it('健康检查能确认服务在线', async () => {
    await expect(checkWhishper(config)).resolves.toMatchObject({ model: 'tiny' });
  });

  it.skipIf(!hasProbe)('上传真实音频并取回带时间戳的 segments', async () => {
    const bytes = readFileSync(PROBE);
    const audio = new Blob([new Uint8Array(bytes)], { type: 'audio/wav' });
    const segments = await transcribeWhishper({
      config, audio, offsetMs: 60_000, durationMs: 2_000, timeoutMs: 180_000,
    });
    // 真实识别结果不可预知具体文字，但时间轴必须落在本分片区间内且单调。
    expect(Array.isArray(segments)).toBe(true);
    for (const segment of segments) {
      expect(segment.startMs).toBeGreaterThanOrEqual(60_000);
      expect(segment.endMs).toBeLessThanOrEqual(62_000);
      expect(segment.endMs).toBeGreaterThan(segment.startMs);
      expect(segment.text.length).toBeGreaterThan(0);
    }
    const sorted = [...segments].sort((a, b) => a.startMs - b.startMs);
    expect(segments).toEqual(sorted);
  }, 200_000);
});
