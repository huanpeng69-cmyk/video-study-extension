import type { AppError } from '../domain/errors';

/**
 * 音频转写分片的公共辅助。
 *
 * 历史：这两个函数原本长在 `orchestrator.ts` 里（后台轮询 relay 拉分片的那套编排）。
 * 现在实际链路是「离屏文档录制 → 后台逐片调用本机 Whisper」，编排已迁移，
 * 只剩纯函数还被契约测试使用，所以独立放在这里，不再保留整个旧模块。
 */

/** 鉴权 / 额度 / 权限类错误再重试也不会成功，调用方应原样抛出而不是计数。 */
export function isFatalAsrError(error: AppError): boolean {
  return [
    'AUTH_FAILED',
    'QUOTA_EXCEEDED',
    'PERMISSION_DENIED',
    'PROVIDER_NOT_CONFIGURED',
    'NOT_FOUND',
    'ABORTED',
  ].includes(error.code);
}

/** 离屏文档以 base64 回传分片；空 MIME 退回 audio/webm，避免无类型 Blob 被服务端拒收。 */
export function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime || 'audio/webm' });
}
