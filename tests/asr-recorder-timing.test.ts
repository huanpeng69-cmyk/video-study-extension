/**
 * 可执行的录音器时序诊断：真实驱动 TabAudioRecorder（假 MediaRecorder / 假 AudioContext / 假时钟），
 * 观察「播放正常 65 秒」时是否真的产出 chunk 事件。
 *
 * 为什么需要这个夹具：之前只能靠读代码推断，而「进度停在 0/1、一个字都不出」
 * 既可能是分片没产出，也可能是产出但 segments 为空。只有真跑一遍才能区分。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const transcribe = vi.hoisted(() => vi.fn());
vi.mock('../src/asr/local-whisper', () => ({
  transcribeLocalAudio: transcribe,
  normalizeLocalSegments: vi.fn(),
}));

import { TabAudioRecorder } from '../src/asr/tab-recorder';
import { ASR_CAPTURE_CHUNK_MS, ASR_FIRST_CHUNK_MS, type CaptureEvent } from '../src/asr/tab-protocol';

class FakeRecorder {
  static isTypeSupported = (type: string) => type === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  private listeners = new Map<string, ((event: unknown) => void)[]>();

  constructor(private stream: unknown, public options: unknown) {}

  addEventListener(type: string, fn: (event: unknown) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(fn);
    this.listeners.set(type, list);
  }

  private fire(type: string, event: unknown): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }

  start(): void { this.state = 'recording'; }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    // 模拟浏览器在 stop 时吐出整段数据。
    this.fire('dataavailable', { data: new Blob([new Uint8Array(4096)], { type: this.mimeType }) });
    this.fire('stop', {});
  }
}

function makeStream() {
  const track = { stop: vi.fn(), addEventListener: vi.fn() };
  return { getAudioTracks: () => [track], getTracks: () => [track] };
}

class FakeAudioContext {
  state = 'running';
  destination = {};
  createMediaStreamSource() { return { connect: vi.fn(), disconnect: vi.fn() }; }
  createAnalyser() {
    return {
      fftSize: 2048,
      connect: vi.fn(),
      disconnect: vi.fn(),
      // 返回非零电平：模拟「确实有声音」，排除静音判定干扰。
      getFloatTimeDomainData: (buffer: Float32Array) => buffer.fill(0.25),
    };
  }
  addEventListener(): void {}
  removeEventListener(): void {}
  resume = vi.fn(async () => {});
  close = vi.fn(async () => {});
}

const sample = (positionMs: number) => ({
  positionMs, durationMs: 600_000, paused: false, muted: false, volume: 1, playbackRate: 1,
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'clearTimeout', 'clearInterval', 'Date', 'performance'] });
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => makeStream()),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
  transcribe.mockReset();
  transcribe.mockImplementation(async () => [{ startMs: 0, endMs: 1_000, text: '测试文字' }]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function run(seconds: number, options: { pausedAfter?: number } = {}) {
  const events: CaptureEvent[] = [];
  const recorder = new TabAudioRecorder(
    { id: 'asr-test', streamId: 'stream-1', config: { backend: 'whisper' as never } as never, sample: sample(10_000) },
    async (event) => { events.push(event); },
  );
  const started = recorder.start();
  await vi.advanceTimersByTimeAsync(0);
  recorder.updateSample(sample(10_000));
  await vi.advanceTimersByTimeAsync(0);
  await started;
  for (let t = 1; t <= seconds; t += 1) {
    await vi.advanceTimersByTimeAsync(1_000);
    const paused = options.pausedAfter !== undefined && t > options.pausedAfter;
    recorder.updateSample({ ...sample(10_000 + t * 1_000), paused });
  }
  await vi.advanceTimersByTimeAsync(0);
  return { events, chunks: events.filter((event) => event.kind === 'chunk') };
}

describe('录音器时序：播放正常时是否真的产出分片', () => {
  it('播放 65 秒应至少产出 2 个分片，且每个都带转写结果', async () => {
    const { chunks } = await run(65);
    expect(transcribe).toHaveBeenCalled();
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.kind === 'chunk' && chunk.segments.length).toBe(1);
    }
  });

  it('首片约 8 秒就产出，后续分片约 30 秒（保证几秒内看到第一批文字）', async () => {
    await run(65);
    const durations = transcribe.mock.calls.map((call) => (call[0] as { durationMs: number }).durationMs);
    expect(durations.length).toBeGreaterThanOrEqual(2);
    // 首片更短是刻意设计：如果首片也要等满 30 秒，用户在前 30 秒只会看到进度条。
    expect(durations[0]).toBeLessThanOrEqual(ASR_FIRST_CHUNK_MS + 1_500);
    expect(durations[0]).toBeGreaterThan(ASR_FIRST_CHUNK_MS - 1_500);
    // 后续分片回到常规间隔，不能因为首片短就一直碎切。
    expect(durations[1]).toBeGreaterThan(ASR_FIRST_CHUNK_MS + 5_000);
  });

  it('中途暂停只挂起，不应结束整场会话', async () => {
    const { events } = await run(40, { pausedAfter: 20 });
    const done = events.filter((event) => event.kind === 'done');
    expect(done).toHaveLength(0);
  });
});
