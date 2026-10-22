/**
 * 主世界 ↔ 隔离世界的 postMessage 协议。
 *
 * 为什么单独成模块：`window.postMessage` 会把消息派发给同一 window 上的**所有**
 * 监听器，包括刚刚发出消息的那个上下文。旧实现用同一个 `channel` 同时表示
 * 请求与应答，且应答处理器只校验 channel，于是请求一发出就被自己的处理器命中、
 * 立刻以 `snapshot: undefined` → `null` 解析，主世界的应答永远来不及被接收。
 * 结果是每次快照都失败，界面恒显示“未能读取当前视频信息”。
 *
 * 因此请求与应答必须是**不同类型**，且匹配时必须同时校验 type 与 channel。
 */

export const STATE_REQUEST = 'VSN_READ_STATE_REQUEST';
export const STATE_REPLY = 'VSN_READ_STATE_REPLY';

export interface StateRequestMessage {
  type: typeof STATE_REQUEST;
  channel: string;
}

export interface StateReplyMessage {
  /** 只读白名单字段；缺失字段保持 undefined。 */
  type: typeof STATE_REPLY;
  channel: string;
  snapshot: Record<string, unknown> | null;
}

export function makeStateRequest(channel: string): StateRequestMessage {
  return { type: STATE_REQUEST, channel };
}

export function makeStateReply(channel: string, snapshot: Record<string, unknown> | null): StateReplyMessage {
  return { type: STATE_REPLY, channel, snapshot };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** 主世界只应答与自身 type 匹配、且 channel 相同的请求。 */
export function isStateRequestFor(data: unknown, channel: string): data is StateRequestMessage {
  return isRecord(data) && data.type === STATE_REQUEST && data.channel === channel;
}

/** 隔离世界只接受真正的应答：type 必须是 STATE_REPLY，且 channel 匹配。 */
export function isStateReplyFor(data: unknown, channel: string): data is StateReplyMessage {
  return isRecord(data) && data.type === STATE_REPLY && data.channel === channel;
}
