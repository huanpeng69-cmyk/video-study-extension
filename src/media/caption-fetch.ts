export const MAX_TRACK_BYTES = 2 * 1024 * 1024;
export const TRACK_TIMEOUT_MS = 15_000;

export type CaptionFetchResult = { ok: true; text: string } | { ok: false; reason: string };
export type TrackUrlResult = { ok: true; url: string } | { ok: false; reason: string };

function privateV4(parts: number[]): boolean {
  const [a = 0, b = 0] = parts;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0)) || (a === 100 && b >= 64 && b <= 127) ||
    (a === 198 && (b === 18 || b === 19));
}

/** URL canonicalization already expands hexadecimal/short IPv4 literals. No DNS/network probing. */
export function isPrivateCaptionHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || /\.(?:localhost|local|localdomain|internal|lan|home)$/.test(host)) return true;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return privateV4(host.split('.').map(Number));
  if (host.startsWith('[') && host.endsWith(']')) {
    const halves = host.slice(1, -1).split('::');
    const left = (halves[0] || '').split(':').filter(Boolean);
    const right = (halves[1] || '').split(':').filter(Boolean);
    const words = [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right].map((word) => parseInt(word, 16));
    const first = words[0] ?? 0;
    if (first === 0 && words.slice(0, 6).every((word) => word === 0)) return true;
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xffc0) === 0xfec0 || (first & 0xff00) === 0xff00) return true;
    if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff) {
      return privateV4([(words[6] ?? 0) >>> 8, (words[6] ?? 0) & 255, (words[7] ?? 0) >>> 8, (words[7] ?? 0) & 255]);
    }
    // 6to4 and NAT64 must not smuggle a private IPv4 destination.
    if (first === 0x2002) return privateV4([(words[1] ?? 0) >>> 8, (words[1] ?? 0) & 255, (words[2] ?? 0) >>> 8, (words[2] ?? 0) & 255]);
    if (first === 0x64 && words[1] === 0xff9b) return privateV4([(words[6] ?? 0) >>> 8, (words[6] ?? 0) & 255, (words[7] ?? 0) >>> 8, (words[7] ?? 0) & 255]);
    return false;
  }
  return !host.includes('.');
}

/** Callers must first authorize an actually enumerated track, not a caller-supplied URL. */
export function checkCaptionUrl(raw: string, pageHref: string, actualTrack = false): TrackUrlResult {
  try {
    const page = new URL(pageHref);
    const url = new URL(raw, page);
    if (!['http:', 'https:'].includes(page.protocol) || page.username || page.password || url.username || url.password) {
      return { ok: false, reason: '字幕地址包含凭据或页面来源不受支持' };
    }
    if (url.protocol === 'blob:') {
      const inner = new URL(url.pathname);
      return actualTrack && inner.origin === page.origin && !inner.username && !inner.password
        ? { ok: true, url: url.href }
        : { ok: false, reason: '只允许实际字幕轨道使用同源 blob 地址' };
    }
    if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, reason: '字幕地址协议不受支持' };
    if (!isPrivateCaptionHost(page.hostname) && isPrivateCaptionHost(url.hostname)) {
      return { ok: false, reason: '禁止公共页面读取本机或私有网络字幕地址' };
    }
    return { ok: true, url: url.href };
  } catch {
    return { ok: false, reason: '字幕地址无效' };
  }
}

/** Page-origin CORS fetch only. The original URL/signature is never edited, and redirects are errors. */
export async function fetchCaptionText(
  raw: string,
  pageHref: string,
  options: { actualTrack?: boolean; signal?: AbortSignal; fetcher?: typeof fetch; timeoutMs?: number; maxBytes?: number } = {},
): Promise<CaptionFetchResult> {
  const checked = checkCaptionUrl(raw, pageHref, options.actualTrack === true);
  if (!checked.ok) return checked;
  if (options.signal?.aborted) return { ok: false, reason: '字幕请求已取消' };
  const controller = new AbortController();
  const maxBytes = Math.min(MAX_TRACK_BYTES, Math.max(1, options.maxBytes ?? MAX_TRACK_BYTES));
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let reason = '字幕读取失败（网络、跨域 CORS 或重定向受限）';
  let stop: (message: string) => void = () => undefined;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = (message) => {
      reason = message;
      controller.abort();
      void reader?.cancel().catch(() => undefined);
      reject(new Error('caption-read-stopped'));
    };
  });
  const timer = setTimeout(() => stop('字幕读取超时（15 秒上限）'), Math.min(TRACK_TIMEOUT_MS, Math.max(1, options.timeoutMs ?? TRACK_TIMEOUT_MS)));
  const onAbort = () => stop('字幕请求已取消');
  options.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const read = async (): Promise<CaptionFetchResult> => {
      const response = await (options.fetcher ?? fetch)(checked.url, {
        credentials: 'same-origin', redirect: 'error', mode: 'cors', signal: controller.signal,
      });
      if (!response.ok) return { ok: false, reason: `字幕请求失败（HTTP ${response.status}）` };
      if (response.redirected || response.type === 'opaque' || response.type === 'opaqueredirect') return { ok: false, reason: '不允许字幕重定向或不透明响应' };
      const declared = Number(response.headers.get('content-length'));
      if (declared > maxBytes) {
        controller.abort();
        void response.body?.cancel().catch(() => undefined);
        return { ok: false, reason: '字幕文件超过 2 MB，已停止读取' };
      }
      if (!response.body) return { ok: false, reason: '字幕响应没有可安全读取的数据流' };
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      const parts: string[] = [];
      let bytes = 0;
      while (true) {
        const chunk = await reader.read();
        if (controller.signal.aborted) return { ok: false, reason };
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > maxBytes) {
          stop('字幕文件超过 2 MB，已停止读取');
          return { ok: false, reason };
        }
        parts.push(decoder.decode(chunk.value, { stream: true }));
      }
      parts.push(decoder.decode());
      return { ok: true, text: parts.join('') };
    };
    return await Promise.race([read(), stopped]);
  } catch {
    // Never echo fetch exceptions: they can contain a full signed/token-bearing URL.
    return { ok: false, reason };
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
    try { reader?.releaseLock(); } catch { /* A timed-out read may still be settling. */ }
  }
}
