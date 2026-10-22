/**
 * 结构化诊断日志。
 *
 * 约束（来自任务书）：统一 `[VideoStudy]` 前缀；记录页面 URL、平台识别、
 * 快照来源、字段是否取到、消息收发状态、错误阶段与超时时间。
 * 禁止输出 Cookie、令牌、鉴权头、完整媒体地址或用户隐私数据。
 */

export type LogLevel = 'log' | 'warn' | 'error';

const PREFIX = '[VideoStudy]';

/** 去掉可能带签名的查询串，只保留 origin + path，避免泄露令牌参数。 */
export function safeUrl(rawUrl: string): string {
  try {
    const url = new URL(rawUrl);
    const path = url.pathname.length > 1 ? url.pathname : '/';
    return `${url.origin}${path}`;
  } catch {
    return '(invalid-url)';
  }
}

function emit(level: LogLevel, stage: string, payload?: Record<string, unknown>): void {
  const sink = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  if (payload && Object.keys(payload).length > 0) {
    sink(`${PREFIX} ${stage}`, payload);
    return;
  }
  sink(`${PREFIX} ${stage}`);
}

export const vsLog = {
  info(stage: string, payload?: Record<string, unknown>): void {
    emit('log', stage, payload);
  },
  warn(stage: string, payload?: Record<string, unknown>): void {
    emit('warn', stage, payload);
  },
  error(stage: string, payload?: Record<string, unknown>): void {
    emit('error', stage, payload);
  },
};
