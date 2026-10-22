/**
 * Whishper 适配器（本机容器，默认 `http://127.0.0.1:8082`）。
 *
 * 与 `local-whisper.ts`（同步 `/v1/audio/transcriptions`）的区别：
 * Whishper 是**异步任务队列**——上传拿到任务 id，再轮询到完成才拿到结果。
 * 实测接口（whishper 容器，`pluja/whishper:latest`）：
 * - `POST /api/transcriptions?modelSize=<m>&language=<l>`（multipart，字段名 `file`）
 *   ⚠ 不带这两个查询参数时任务会直接 `status=-1` 失败，因此必须显式传。
 * - `GET  /api/transcriptions/{id}` → `{ status, result: { segments: [{start,end,text}] } }`
 *   `status`: 0=排队/运行中，2=完成，-1=失败。
 *
 * 约束：只允许回环地址；不读取任何密钥；失败绝不补造字幕。
 */
import { appError, isAppError } from '../domain/errors';
import type { TranscriptionSegment } from './client';
import { normalizeLocalSegments, type LocalWhisperConfig } from './local-whisper';

/** Whishper 服务标识：仅本机容器，路径固定。 */
export const WHISPER_BACKEND_WHISHPER = 'whishper';
/** 实测：`small` 在纯 CPU 上 60 秒音频要 43.6 秒，跟不上实时；`tiny` 为 12.6 秒。 */
export const WHISHPER_DEFAULT_MODEL = 'tiny';
export const WHISHPER_POLL_INTERVAL_MS = 1_500;
const WHISHPER_MAX_POLLS = 400;

/** 任务状态：只认实测到的三个值，其它一律视为未知并明确失败。 */
export const WHISHPER_STATUS = { running: 0, failed: -1, completed: 2 } as const;

export interface WhishperJob {
  id: string;
  status: number;
  result?: { segments?: unknown; text?: unknown };
}

/** 只允许回环 origin；Whishper 固定挂在 `/api`。 */
export function whishperOrigin(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw appError('BAD_REQUEST', 'Whishper 地址无效');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash) {
    throw appError('BAD_REQUEST', 'Whishper 只允许本机 127.0.0.1 或 localhost 地址');
  }
  return url.origin;
}

export function buildWhishperUploadUrl(baseUrl: string, model: string, language: string): string {
  const origin = whishperOrigin(baseUrl);
  const params = new URLSearchParams({ modelSize: model });
  // Whishper 用 `auto` 表示自动识别；空字符串会让它失败。
  params.set('language', language || 'auto');
  return `${origin}/api/transcriptions?${params.toString()}`;
}

export function buildWhishperJobUrl(baseUrl: string, id: string): string {
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) throw appError('BAD_REQUEST', 'Whishper 任务 id 格式无效');
  return `${whishperOrigin(baseUrl)}/api/transcriptions/${id}`;
}

/** 健康检查：能列出任务即认为服务在线（不要求已有任务）。 */
export async function checkWhishper(
  config: LocalWhisperConfig,
  fetchImpl?: typeof fetch,
): Promise<{ model: string }> {
  const origin = whishperOrigin(config.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await (fetchImpl ?? fetch)(`${origin}/api/transcriptions`, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!response.ok) {
      throw appError('LOCAL_WHISPER_ERROR', `Whishper 未就绪（HTTP ${response.status}）`, {
        detail: '请在 Docker 中确认 whishper 容器已启动，并访问 http://127.0.0.1:8082 验证。',
      });
    }
    const payload: unknown = await response.json().catch(() => null);
    if (!Array.isArray(payload)) throw appError('LOCAL_WHISPER_ERROR', '该地址不像 Whishper 服务（未返回任务列表）');
    return { model: config.model || WHISHPER_DEFAULT_MODEL };
  } catch (cause) {
    if (isAppError(cause)) throw cause;
    if (controller.signal.aborted) throw appError('TIMEOUT', 'Whishper 健康检查超时');
    throw appError('LOCAL_WHISPER_UNAVAILABLE', '无法连接 Whishper', {
      detail: '请先启动 Docker 中的 whishper 容器（默认端口 8082）。音频不会发往云端。',
    });
  } finally {
    clearTimeout(timer);
  }
}

/** 上传一个分片，返回任务 id。参数缺失会让 Whishper 静默失败，因此这里强制带上。 */
async function uploadChunk(
  config: LocalWhisperConfig,
  audio: Blob,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<string> {
  const model = (config.model || WHISHPER_DEFAULT_MODEL).trim();
  const url = buildWhishperUploadUrl(config.baseUrl, model, config.language);
  const form = new FormData();
  form.append('file', audio, `chunk.${audio.type.includes('ogg') ? 'ogg' : 'webm'}`);
  const response = await (options.fetchImpl ?? fetch)(url, {
    method: 'POST', body: form, credentials: 'omit', redirect: 'error', signal: options.signal,
  }).catch((cause) => {
    if (options.signal?.aborted) throw appError('ABORTED', '已取消本地转写');
    throw appError('LOCAL_WHISPER_UNAVAILABLE', '无法上传音频到 Whishper', {
      detail: cause instanceof Error ? cause.message : undefined,
    });
  });
  if (!response.ok) {
    // 不转述服务端正文：可能含文件路径或音频内容。
    throw appError('LOCAL_WHISPER_ERROR', `Whishper 拒绝了这段音频（HTTP ${response.status}）`, {
      httpStatus: response.status,
    });
  }
  const payload = (await response.json().catch(() => null)) as { id?: unknown; status?: unknown } | null;
  if (!payload || typeof payload.id !== 'string' || !/^[A-Za-z0-9_-]{8,64}$/.test(payload.id)) {
    throw appError('LOCAL_WHISPER_ERROR', 'Whishper 未返回有效任务 id');
  }
  // 上传即失败（常见于漏传 modelSize/language）要立刻报错，而不是空转轮询。
  if (payload.status === WHISHPER_STATUS.failed) {
    throw appError('LOCAL_WHISPER_ERROR', 'Whishper 未能开始转写该分片', {
      detail: '请在 Whishper 页面确认模型已加载；本适配器已按 tiny/small 传入模型参数。',
    });
  }
  return payload.id;
}

/** 轮询任务直到完成 / 失败 / 超时。 */
async function pollJob(
  config: LocalWhisperConfig,
  id: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch; timeoutMs?: number },
): Promise<WhishperJob> {
  const url = buildWhishperJobUrl(config.baseUrl, id);
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  for (let attempt = 0; attempt < WHISHPER_MAX_POLLS; attempt += 1) {
    if (options.signal?.aborted) throw appError('ABORTED', '已取消本地转写');
    if (Date.now() > deadline) throw appError('TIMEOUT', 'Whishper 转写超时；未自动重试');
    const response = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: options.signal,
    }).catch(() => null);
    if (response && response.ok) {
      const job = (await response.json().catch(() => null)) as WhishperJob | null;
      if (job && typeof job.status === 'number') {
        if (job.status === WHISHPER_STATUS.completed) return job;
        if (job.status === WHISHPER_STATUS.failed) {
          throw appError('LOCAL_WHISPER_ERROR', 'Whishper 转写该分片失败', {
            detail: '可在 Whishper 页面查看该任务的失败原因；扩展不会重发同一段音频。',
          });
        }
      }
    }
    await new Promise((resolve) => setTimeout(resolve, WHISHPER_POLL_INTERVAL_MS));
  }
  throw appError('TIMEOUT', 'Whishper 转写轮询次数超限');
}

/**
 * 转写一个分片：上传 → 轮询 → 校验并映射到绝对时间轴。
 * 时间戳校验复用 `normalizeLocalSegments`，与同步后端保持同一套严格规则。
 */
export async function transcribeWhishper(options: {
  config: LocalWhisperConfig;
  audio: Blob;
  offsetMs: number;
  durationMs: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<TranscriptionSegment[]> {
  if (!options.audio.size) throw appError('BAD_REQUEST', '录音片段为空');
  if (options.audio.size > 25 * 1024 * 1024) throw appError('TOO_LARGE', '录音片段超过 25 MB');
  if (!Number.isFinite(options.durationMs) || options.durationMs <= 0) {
    throw appError('BAD_REQUEST', '录音片段时间无效');
  }
  const id = await uploadChunk(options.config, options.audio, options);
  const job = await pollJob(options.config, id, options);
  return normalizeLocalSegments(job.result ?? null, options.offsetMs, options.durationMs);
}
