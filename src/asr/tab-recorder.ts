/** 在扩展 offscreen 文档中采集标签页音频，绝不连接网页的 MediaElementSource。 */
import { appError, toAppError, type AppError } from '../domain/errors';
import { transcribeLocalAudio } from './local-whisper';
import { ASR_CAPTURE_CHUNK_MS, ASR_FIRST_CHUNK_MS, ASR_MAX_QUEUED, ASR_MAX_RECORD_MS, ASR_MUTE_CONFIRM_SAMPLES, ASR_SILENCE_PEAK,
  ASR_STALL_LIMIT_MS, ASR_SILENCE_LIMIT_MS, captureIssue, shouldStopForSilence, type CaptureEvent,
  type CaptureEvidence, type CaptureSample, type CaptureStart, type CaptureStopKind } from './tab-protocol';

interface Part {
  recorder: MediaRecorder; blobs: Blob[]; offsetMs: number; startedAt: number; discard: boolean;
  endMs?: number;
  /** 本片采集到的最大峰值，用来事后判断「这片是不是数字静音」。 */
  peak: number;
}

/** 峰值采样间隔：200ms 足够发现「整片都是静音」，开销可以忽略。 */
const SILENCE_PROBE_MS = 200;
/** 音量持续为 0 超过这个时间才停止采集，期间自动等待恢复。 */
const VOLUME_ZERO_LIMIT_MS = 60_000;
const DEVICE_CHANGE_WARNING = '检测到音频输出设备变化（例如插入或拔出耳机）；这不是页面静音，采集仍在继续';

/**
 * 读出这一片音频的**真实时长**（毫秒）。
 *
 * 为什么需要：录音端的 durationMs 是墙钟估算，Opus 容器预填充与编码缓冲会让
 * 实际音频比估算略长，导致 Whisper 的时间戳被判成「超出录音片段」。
 * 用解码得到的真实时长做校验上限，才能既拒绝真正错片的越界，又不丢真实语音。
 *
 * 解码失败时返回 0：调用方会退回墙钟估算，不伪造时长、不吞掉错误。
 */
async function measureAudioMs(blob: Blob): Promise<number> {
  const Ctx = globalThis.AudioContext ?? (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx || !blob.size) return 0;
  const context = new Ctx();
  try {
    const buffer = await blob.arrayBuffer();
    const decoded = await context.decodeAudioData(buffer);
    return Number.isFinite(decoded.duration) && decoded.duration > 0 ? decoded.duration * 1000 : 0;
  } catch {
    return 0;
  } finally {
    void context.close().catch(() => undefined);
  }
}

export class TabAudioRecorder {
  private stream: MediaStream | null = null;
  private audio: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private probe: Float32Array<ArrayBuffer> | null = null;
  private part: Part | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private watchdog?: ReturnType<typeof setInterval>;
  private silenceProbe?: ReturnType<typeof setInterval>;
  private sample: CaptureSample;
  private sampleAt = performance.now();
  private startedAt = performance.now();
  /** 最近一次「播放位置真的往前走了」的时刻。注意：这只是页面上报，不等于视频在播。 */
  private lastProgressAt = performance.now();
  /** 最近一次「采集到的音频不是静音」的时刻。这才是判断「有没有东西可转写」的直接证据。 */
  private lastAudibleAt = performance.now();
  /**
   * 时间轴锚点：最近一次已知的媒体位置 + 当时的墙钟时刻。
   * 页面上报中断或位置冻结时，仍按墙钟推进时间轴，避免整段音频被压成 0 秒。
   */
  private anchor = { mediaMs: 0, wallMs: performance.now() };
  private stopping = false;
  private finished = false;
  private pending = 0;
  private completed = 0;
  private nextIndex = 0;
  private recordedMs = 0;
  private tail: Promise<void> = Promise.resolve();
  private error?: AppError;
  private warnings: string[] = [];
  /** 是否已收到第一条真实播放采样；未收到前不做连续性判断。 */
  private hasBaseline = false;
  private resolveBaseline?: () => void;
  /** 基线是否来自真实采样；5 秒兜底基线为 false，第一条真实采样只做校准。 */
  private baselineFromSample = false;
  /** 连续读到「真实静音操作」的次数，用于过滤单次读取抖动。 */
  private mutedSamples = 0;
  /** 音量读到 0 的起始时刻；恢复非 0 时清零。 */
  private volumeZeroSince = 0;
  /** 采集证据：只记录事实，不参与静音判定。 */
  private chunks = 0;
  private silentChunks = 0;
  private deviceChanged = false;
  private trackEnded = false;
  private peak = 0;
  private lastContextState = 'unknown';
  /** 完成但没有产出任何音频数据的分片数（真正的采集故障）。 */
  private emptyParts = 0;
  /** 结构化停止原因：只记第一次，后面不覆盖。 */
  private stopKind?: CaptureStopKind;
  private stopReason?: string;
  /** 暂停挂起中：当前没有正在录制的分片，等恢复播放再续录。 */
  private suspended = false;

  constructor(private input: CaptureStart, private emit: (event: CaptureEvent) => Promise<void>) {
    this.sample = input.sample;
  }

  async start(): Promise<void> {
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) throw appError('CAPTURE_UNAVAILABLE', '浏览器不支持 WebM 音频录制');
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: this.input.streamId } } as MediaTrackConstraints,
        video: false,
      });
      if (this.stopping) { await this.release(); return; }
      if (!this.stream.getAudioTracks().length) throw appError('CAPTURE_UNAVAILABLE', '标签页没有可采集音轨');
      this.audio = new AudioContext();
      this.source = this.audio.createMediaStreamSource(this.stream);
      // 串成 source → analyser → destination：analyser 必须在到 destination 的通路上才会被拉取，
      // 否则读不到真实电平；AnalyserNode 原样透传，不会改变用户听到的声音。
      this.analyser = this.audio.createAnalyser();
      this.analyser.fftSize = 2048;
      this.probe = new Float32Array(this.analyser.fftSize);
      this.source.connect(this.analyser);
      this.analyser.connect(this.audio.destination); // tabCapture 停止原生播放输出，必须回放给用户。
      this.audio.addEventListener('statechange', this.onStateChange);
      this.lastContextState = String(this.audio.state);
      await this.audio.resume();
      this.silenceProbe = setInterval(() => this.measure(), SILENCE_PROBE_MS);
      // 输出设备切换（插入耳机）会被 Chrome 用来重建音频输出：只记录事实，绝不据此判定静音。
      if (typeof navigator.mediaDevices?.addEventListener === 'function') {
        navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);
      }
      this.stream.getAudioTracks()[0]?.addEventListener('ended', this.onTrackEnded);
      this.startedAt = performance.now();
      this.lastProgressAt = performance.now();
      this.lastAudibleAt = performance.now();
      this.anchor = { mediaMs: this.sample.positionMs, wallMs: performance.now() };
      // 等第一条真实采样再开录：`input.sample` 可能是弹窗打开时的旧快照，
      // 直接拿它当连续性基线会被判成「跳转」，导致一开录就停。
      await this.waitForBaseline();
      if (this.stopping || !this.stream) { await this.release(); return; }
      this.beginPart(mime);
      this.heartbeat = setInterval(() => this.progress(), 5_000);
      this.watchdog = setInterval(() => {
        if (this.stopping) return;
        /*
         * 判据必须是「采集到的音频有没有声音」，不能只看播放位置：
         * 位置上报是页面上报的，SW 被回收、消息丢失、页面暂停上报都会让位置「冻住」，
         * 但标签页音频其实还在采。旧逻辑只看位置，于是正常播放也会被误判成「没在播放」。
         * 现在要两个条件同时成立才停：音频连续静音，且位置也确实没推进。
         */
        const now = performance.now();
        const silentFor = now - this.lastAudibleAt;
        const frozenFor = now - this.lastProgressAt;
        if (shouldStopForSilence(silentFor, frozenFor)) {
          const seconds = Math.round(ASR_SILENCE_LIMIT_MS / 1000);
          this.stop(false, `连续 ${seconds} 秒没有采集到任何声音，播放位置也没有推进，采集已停止`, undefined, 'stall');
        } else if (now - this.startedAt >= ASR_MAX_RECORD_MS) {
          this.stop(false, '已达到单次两小时录音上限', undefined, 'limit');
        }
      }, 500);
      this.progress();
    } catch (cause) {
      await this.release();
      throw toAppError(cause, 'CAPTURE_UNAVAILABLE', '无法开始标签页音频采集');
    }
  }

  updateSample(next: CaptureSample): void {
    if (this.stopping) return;
    const now = performance.now();
    // 只要媒体位置往前走了，就先刷新「未停滞」时刻与时间轴锚点。
    // 必须放在任何 early return 之前：否则「音量 0」这类只提示不停录的分支
    // 会一直不更新，watchdog 再把「位置明明在推进」误判成停滞。
    this.trackTimeline(next, now);
    // 第一条真实采样直接作为基线：不做连续性判断，避免拿旧快照当参照而误停。
    if (!this.hasBaseline) {
      this.hasBaseline = true;
      this.baselineFromSample = true;
      this.sample = next;
      this.sampleAt = now;
      this.lastProgressAt = now;
      const resolve = this.resolveBaseline;
      this.resolveBaseline = undefined;
      resolve?.();
      return;
    }
    // 5 秒兜底基线不是真实采样：第一条真实采样只用来校准，不参与连续性判断，
    // 否则「弹窗打开时的旧位置」与真实位置的差距会被误判成跳转，一开录就停。
    if (!this.baselineFromSample) {
      this.baselineFromSample = true;
      this.sample = next;
      this.sampleAt = now;
      this.lastProgressAt = now;
      return;
    }
    const issue = captureIssue(this.sample, next, now - this.sampleAt);
    if (issue) {
      if (issue.kind === 'muted') {
        // 真实静音操作：连续读到才停，避免播放器重置状态时的单次抖动结束整场录音。
        this.mutedSamples += 1;
        if (this.mutedSamples < ASR_MUTE_CONFIRM_SAMPLES) { this.sample = next; this.sampleAt = now; return; }
        this.stop(issue.discard, issue.reason, undefined, 'mute');
        return;
      }
      if (issue.kind === 'silent-volume') {
        // 音量 0 不是静音操作：只提示，不停止、不丢分片；恢复后自动继续。
        this.mutedSamples = 0;
        if (!this.volumeZeroSince) this.volumeZeroSince = now;
        if (now - this.volumeZeroSince >= VOLUME_ZERO_LIMIT_MS) { this.stop(false, issue.reason, undefined, 'volume'); return; }
        this.warn(issue.reason);
        this.sample = next;
        this.sampleAt = now;
        return;
      }
      this.mutedSamples = 0;
      this.volumeZeroSince = 0;
      if (issue.kind === 'paused') {
        // 暂停：结束当前分片并入库后挂起；恢复播放时由常规分支重新开片。
        // 只在第一次暂停时告警，避免每次采样都重复提示。
        if (!this.suspended) this.warn(issue.reason);
        this.suspendPart();
        this.sample = next;
        this.sampleAt = now;
        return;
      }
      if (issue.stop) {
        const kind: CaptureStopKind = 'timeline';
        this.stop(issue.discard, issue.reason, undefined, kind);
        return;
      }
    } else {
      this.mutedSamples = 0;
      this.volumeZeroSince = 0;
    }
    this.sample = next;
    this.sampleAt = now;
    // 之前因暂停挂起过：恢复播放就续录新分片。
    if (this.suspended) this.resumePart();
    if (next.ended) this.stop(false, '视频已播放结束，采集已停止', next.positionMs, 'ended');
  }

  /**
   * 等第一条真实采样到达，最多 5 秒。
   * 等到就按真实位置切分片；等不到先按旧快照开路（只影响第一片起点），
   * 避免用户点了转写却一直没有反应。
   */
  private waitForBaseline(): Promise<void> {
    if (this.hasBaseline) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.resolveBaseline = resolve;
      setTimeout(() => {
        if (this.resolveBaseline !== resolve) return;
        this.resolveBaseline = undefined;
        this.hasBaseline = true;
        this.sampleAt = performance.now();
        this.lastProgressAt = performance.now();
        resolve();
      }, 5_000);
    });
  }

  /**
   * graceful 停止保留当前有效片段；只有时间轴不可信时才 discard=true。
   * `kind` 记录结构化原因，最终错误文案直接由它生成，不再靠猜。
   */
  stop(discard = false, warning = '', endMs?: number, kind?: CaptureStopKind): void {
    if (this.stopping) return;
    this.stopping = true;
    if (kind && !this.stopKind) { this.stopKind = kind; this.stopReason = warning || ''; }
    if (warning) this.warn(warning);
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    if (this.part) {
      this.part.discard = discard;
      this.part.endMs = endMs;
      if (this.part.recorder.state !== 'inactive') this.part.recorder.stop();
    } else void this.finish();
    this.progress();
  }

  private warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  /**
   * 设备切换只记录事实并提示：Chrome 会因为输出设备变化重建音频输出，
   * 但这既不是「页面静音」，也不该被当成用户操作而结束录音。
   */
  private onDeviceChange = (): void => {
    this.deviceChanged = true;
    this.warn(DEVICE_CHANGE_WARNING);
    console.info('[VideoStudy] asr:device-changed', { at: Math.round(performance.now()) });
  };

  /** 回放图被设备切换挂起时主动恢复，否则用户会听不到声音（tabCapture 已掐掉原生输出）。 */
  private onStateChange = (): void => {
    this.lastContextState = String(this.audio?.state ?? 'unknown');
    if (this.lastContextState === 'suspended' || this.lastContextState === 'interrupted') {
      void this.audio?.resume().catch(() => undefined);
    }
  };

  private onTrackEnded = (): void => {
    this.trackEnded = true;
    // 音轨结束前录到的音频仍然有效，保留而不是丢弃。
    this.stop(false, this.deviceChanged
      ? '音频输出设备变化后标签页音频采集中断；已录分片已保留'
      : '标签页音频采集已结束；已录分片已保留', undefined, 'track-ended');
  };

  /** 采样真实电平，用于事后区分「采集到静音」和「有声音但没识别出字」。 */
  private measure(): void {
    const analyser = this.analyser;
    const probe = this.probe;
    if (!analyser || !probe) return;
    // 回放图没在跑时读不到真实电平。此时「不知道」不等于「静音」：
    // 把 lastAudibleAt 刷新掉，宁可不停采集，也不要在测不到的时候下结论。
    if (String(this.audio?.state ?? '') !== 'running') { this.lastAudibleAt = performance.now(); return; }
    analyser.getFloatTimeDomainData(probe);
    let peak = 0;
    for (let index = 0; index < probe.length; index += 1) {
      const value = Math.abs(probe[index] ?? 0);
      if (value > peak) peak = value;
    }
    if (peak > this.peak) this.peak = peak;
    if (this.part && peak > this.part.peak) this.part.peak = peak;
    // 只有真正测到声音才算「有内容可转写」，这是停止判定唯一可靠的输入。
    if (peak >= ASR_SILENCE_PEAK) this.lastAudibleAt = performance.now();
  }

  /** 记录时间轴推进：位置往前走就刷新「未停滞」时刻并移动锚点。 */
  private trackTimeline(next: CaptureSample, now: number): void {
    if (!(next.positionMs > this.sample.positionMs + 10)) return;
    this.lastProgressAt = now;
    this.anchor = { mediaMs: next.positionMs, wallMs: now };
  }

  /**
   * 当前媒体位置：锚点 + 墙钟推进。
   *
   * 为什么不用「最后采样位置 + 距采样时间」：页面上报一旦中断或位置冻结，
   * 那样算出来的位置会停在原地，整段音频的时长被压成 0，分片会被当成过短丢掉。
   * 用锚点 + 墙钟，位置正常时同样准确，位置冻结时至少不会丢音频。
   */
  private positionNow(): number {
    const value = this.anchor.mediaMs + Math.max(0, performance.now() - this.anchor.wallMs);
    return Math.round(this.sample.durationMs > 0 ? Math.min(value, this.sample.durationMs) : value);
  }

  /**
   * 暂停期间挂起当前分片：停止 MediaRecorder 并把已录部分正常入库，
   * 但不结束整场会话（用户恢复播放后会重新开一片）。
   */
  private suspendPart(): void {
    if (!this.part || this.stopping) return;
    this.suspended = true;
    clearTimeout(this.timer);
    if (this.part.recorder.state !== 'inactive') this.part.recorder.stop();
  }

  /** 恢复播放后重新开始录制；只重置分片，不清空已完成分片与证据。 */
  private resumePart(): void {
    if (this.stopping || this.part || this.finished) return;
    this.suspended = false;
    const mime = ['audio/webm;codecs=opus', 'audio/webm'].find((type) => MediaRecorder.isTypeSupported(type));
    if (!mime) { this.stop(true, '浏览器不支持 WebM 音频录制', undefined, 'failed'); return; }
    this.beginPart(mime);
  }

  private beginPart(mime: string): void {
    if (this.stopping || !this.stream) return;
    const recorder = new MediaRecorder(this.stream, { mimeType: mime, audioBitsPerSecond: 96_000 });
    const part: Part = {
      recorder, blobs: [], offsetMs: this.positionNow(), startedAt: performance.now(), discard: false, peak: 0,
    };
    this.part = part;
    recorder.addEventListener('dataavailable', (event) => { if (event.data.size) part.blobs.push(event.data); });
    recorder.addEventListener('error', () => {
      this.error = appError('CAPTURE_UNAVAILABLE', '浏览器音频编码失败');
      this.stop(true, '', undefined, 'failed');
    });
    recorder.addEventListener('stop', () => {
      if (this.part === part) this.part = null;
      const elapsed = Math.round(performance.now() - part.startedAt);
      const durationMs = Math.max(0, Math.min(elapsed, (part.endMs ?? this.positionNow()) - part.offsetMs));
      const audio = new Blob(part.blobs, { type: recorder.mimeType });
      part.blobs = [];
      const silent = part.peak < ASR_SILENCE_PEAK;
      // 没拿到任何音频字节属于真正的采集故障，与静音、暂停都无关，单独计数。
      if (!audio.size) this.emptyParts += 1;
      if (!part.discard && durationMs >= 250 && audio.size) this.enqueue(audio, part.offsetMs, durationMs, silent);
      if (this.stopping) void this.finish();
      // 挂起中（暂停）不自动开新分片：等恢复播放再续录，避免录进整段静音。
      else if (!this.suspended) this.beginPart(mime);
    }, { once: true });
    recorder.start(); // 每段重新 start/stop，不能把无容器头的 timeslice 直接当独立文件上传。
    // 首片更短：让用户几秒内就看到第一批文字，而不是先等满 30 秒。
    const window = this.nextIndex === 0 ? ASR_FIRST_CHUNK_MS : ASR_CAPTURE_CHUNK_MS;
    this.timer = setTimeout(() => { if (recorder.state !== 'inactive') recorder.stop(); }, window);
  }

  private enqueue(audio: Blob, offsetMs: number, durationMs: number, silent: boolean): void {
    if (this.pending >= ASR_MAX_QUEUED) {
      this.stop(true, '本地转写速度低于录音速度，队列已满；已停止录音，保留已提交片段', undefined, 'queue-full');
      return;
    }
    const index = this.nextIndex++;
    this.pending += 1;
    this.recordedMs += durationMs;
    this.chunks += 1;
    if (silent) this.silentChunks += 1;
    this.tail = this.tail.then(async () => {
      if (this.error) return;
      try {
        // 墙钟估算会短于真实音频：WebM/Opus 有容器预填充与编码缓冲，
        // 于是 Whisper 的最后一句起点可能「超出」durationMs 而被错判为越界。
        // 这里先量出这片的真实音频时长当校验上限；量不出来就退回原估算。
        const audioMs = await measureAudioMs(audio);
        const limitMs = audioMs > 0 ? Math.max(Math.round(audioMs), 1) : durationMs;
        const segments = await transcribeLocalAudio({ config: this.input.config, audio, offsetMs, durationMs: limitMs });
        // 把「这一片有多少字节、多长、识别出几条」记录下来：
        // 「进度在走但一个字不出」必须能区分是分片为空、音频静音，还是模型返回 0 段。
        console.info('[VideoStudy] asr:chunk', {
          index, bytes: audio.size, durationMs, segments: segments.length, silent,
        });
        await this.emit({ kind: 'chunk', index, segments, silent, bytes: audio.size, durationMs });
        this.completed += 1;
      } catch (cause) {
        this.error = toAppError(cause, 'LOCAL_WHISPER_ERROR', '本地转写失败');
        this.stop(true, '转写失败后已停止采集；未自动重发音频', undefined, 'failed');
      }
    }).finally(() => { this.pending -= 1; this.progress(); });
    this.progress();
  }

  private progress(): void {
    if (this.finished) return;
    void this.emit({ kind: 'progress', recordedMs: this.recordedMs, completedChunks: this.completed,
      queuedChunks: this.pending, recording: !this.stopping }).catch(() => {
      if (!this.stopping) this.stop(true, '扩展后台未响应，已停止录音', undefined, 'closed');
    });
  }

  private evidence(): CaptureEvidence {
    return {
      chunks: this.chunks, silentChunks: this.silentChunks, emptyParts: this.emptyParts,
      deviceChanged: this.deviceChanged, trackEnded: this.trackEnded,
      peak: Math.round(this.peak * 1000) / 1000,
      contextRunning: this.lastContextState === 'running',
      stopKind: this.stopKind, stopReason: this.stopReason,
    };
  }

  private async release(): Promise<void> {
    clearInterval(this.silenceProbe);
    this.silenceProbe = undefined;
    if (typeof navigator.mediaDevices?.removeEventListener === 'function') {
      navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange);
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    this.stream = null;
    this.analyser?.disconnect();
    this.analyser = null;
    this.probe = null;
    this.source?.disconnect();
    this.source = null;
    this.audio?.removeEventListener('statechange', this.onStateChange);
    await this.audio?.close().catch(() => undefined);
    this.audio = null;
  }

  private async finish(): Promise<void> {
    if (this.finished || this.part) return;
    // 先取证据再释放：释放会关掉 AudioContext，之后就取不到图状态了。
    const evidence = this.evidence();
    // 先释放采集，转写等待期间不再监听标签页音频。
    await this.release();
    await this.tail;
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    clearInterval(this.heartbeat);
    // 完成通知有限重试；后台按 session id / 已完成状态幂等，不重发音频。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try { await this.emit({ kind: 'done', warnings: this.warnings, error: this.error, evidence }); return; }
      catch { if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    }
    console.warn('[VideoStudy] asr:completion-undelivered', { code: 'STORAGE_FAILED' });
  }
}
