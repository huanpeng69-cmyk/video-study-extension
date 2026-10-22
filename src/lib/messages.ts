/**
 * 消息协议（技术方案 8.1）。
 * 每个请求带协议版本与 requestId；版本校验只针对携带 version 的消息，
 * 避免内容脚本的主动上报被误判为协议不兼容（这是旧的卡住原因之一）。
 */
import type { AppError } from '../domain/errors';
import type { VideoPlatform } from '../domain/video';

export const PROTOCOL_VERSION = 1;

export interface VideoSnapshotPayload {
  bvid?: string;
  aid?: string | number;
  cid?: string | number;
  title?: string;
  pageIndex?: number;
  durationMs?: number;
}

export interface TrackSummary {
  id: string;
  lan: string;
  lanDoc: string;
  generationKind: 'human' | 'ai' | 'unknown';
  url: string;
}

export type RuntimeRequest =
  | { type: 'CAPTURE_VIDEO'; payload: { tabId?: number } }
  | { type: 'LIST_TRACKS'; payload: { aid: string; cid: string } }
  | { type: 'READ_SUBTITLE'; payload: { url: string } }
  | { type: 'SEEK_VIDEO'; payload: { positionMs: number } }
  | { type: 'VIDEO_CONTEXT_CHANGED'; payload: Record<string, unknown> }
  | { type: 'PLAYBACK_POSITION'; payload: Record<string, unknown> }
  | { type: 'GET_VIDEO_STATE'; payload: { tabId?: number } }
  | { type: 'CONTROL_PLAYBACK'; payload: { action: PlaybackAction; value?: number | boolean } }
  | { type: 'CAPTURE_FRAME'; payload: { tabId?: number } }
  /**
   * 开始本地语音转写：采集当前标签页音频，交给本机 Whisper（不使用聊天 Key，不发云端）。
   * 返回会话 id 后由 UI 轮询 ASR_STATE 获取进度与结果。
   */
  | { type: 'TRANSCRIBE_AUDIO'; payload: { chunkMs?: number; startMs?: number; endMs?: number } }
  | { type: 'ASR_STATE'; payload: Record<string, never> }
  | { type: 'ASR_STOP'; payload: Record<string, never> }
  | { type: 'AUTO_SUMMARY_STATE'; payload: { videoId: string } }
  | { type: 'AUTO_SUMMARY_SELECT'; payload: { videoId: string; transcriptId: string } }
  | { type: 'AUTO_SUMMARY_CONTROL'; payload: { videoId: string; enabled: boolean; retryFailed?: boolean } }
  /** 通用层：列出页面自身的 `<track>` 字幕轨道，不依赖任何站点接口。 */
  | { type: 'LIST_PAGE_TRACKS'; payload: { tabId?: number } }
  | { type: 'READ_PAGE_TRACK'; payload: { url: string; tabId?: number } }
  /** 确认已取得被访问站点权限后注入通用页面脚本；不授予权限则不注入。 */
  | { type: 'ENSURE_PAGE_SCRIPT'; payload: { tabId?: number } }
  /** 在后台生成学习总结：关闭弹窗后仍继续执行。 */
  | { type: 'START_SUMMARY'; payload: { videoId: string } }
  | { type: 'SUMMARY_PROGRESS'; payload: { videoId: string } }
  | { type: 'CANCEL_SUMMARY'; payload: { videoId: string } }
  /** 读取已完成的总结（弹窗关闭后再打开也能看到）。 */
  | { type: 'FULL_SUMMARY_PREVIEW'; payload: { videoId: string; transcriptId: string } }
  | { type: 'FULL_SUMMARY_START'; payload: { videoId: string; transcriptId: string; appendToNote?: boolean } }
  | { type: 'FULL_SUMMARY_PROGRESS'; payload: { videoId: string } }
  | { type: 'GET_SUMMARY'; payload: { videoId: string } };

export type PlaybackAction = 'play' | 'pause' | 'toggle' | 'seek' | 'rate' | 'volume' | 'mute';

export interface RuntimeResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: AppError;
}

/** UI 侧只读状态：由后台维护，页面无法伪造。 */
export interface TabContext {
  tabId: number;
  documentEpoch: string;
  bvid: string;
  aid: string;
  cid: string;
  pageIndex: number;
  title: string;
  durationMs: number;
  positionMs: number;
  updatedAt: number;
  /** 通用站点为 'web'；缺省按 'bilibili' 处理，兼容旧上下文。 */
  platform?: VideoPlatform;
  /** 播放去重与自动学习使用的稳定视频键；B站为 `bvid:cid`。 */
  videoKey?: string;
  /** 回看链接；通用站点为页面地址。 */
  /** 统一视频主键：B站为 bilibili:bvid:cid，通用站点为 web:源:键。 */
  videoId?: string;
  canonicalUrl?: string;
}

export interface VideoState {
  paused: boolean;
  muted: boolean;
  volume: number;
  playbackRate: number;
  positionMs: number;
  durationMs: number;
  ready: boolean;
}

export interface CapturedFrame {
  /** PNG data URL。 */
  dataUrl: string;
  positionMs: number;
  width: number;
  height: number;
}

export function withRequestId<T extends RuntimeRequest>(request: T): T & { version: number; requestId: string } {
  return {
    ...request,
    version: PROTOCOL_VERSION,
    requestId: `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** UI → 后台：带信封字段的完整请求。 */
export async function sendRuntimeMessage<T>(request: RuntimeRequest): Promise<RuntimeResponse<T>> {
  try {
    const response = (await chrome.runtime.sendMessage(withRequestId(request))) as RuntimeResponse<T> | undefined;
    if (!response) return { ok: false };
    return response;
  } catch (cause) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN',
        message: cause instanceof Error ? cause.message : '扩展后台未响应',
        retryable: true,
      },
    };
  }
}

/** 内容脚本 → 后台：主动上报。同样带版本，便于后台区分来源。 */
export async function postFromContent(request: RuntimeRequest): Promise<void> {
  try {
    await chrome.runtime.sendMessage(withRequestId(request));
  } catch {
    // 后台休眠或页面正在卸载时忽略，下一次上报会补上。
  }
}

/**
 * 新文档/分 P 切换时，迟到的旧播放位置不得触发另一视频的字幕请求。
 *
 * 身份比较必须用后台显式维护的 `context.videoKey`：
 * - B站：`bvid:cid`；
 * - 通用站点：`webKey`（URL 推导键，如 `/watch?v=xxx`）。
 *
 * 历史缺陷：这里写成 `` `${context.bvid}:${context.cid}` ``，
 * 通用站点的 `bvid` 被塞进 `webKey`、`cid` 为空 → 期望值变成
 * `"/watch?v=xxx:"`（多一个冒号），而上报的是 `"/watch?v=xxx"`，
 * 两者永远不匹配 → PLAYBACK_POSITION 被静默丢弃 →
 * 进度条不更新、自动学习不触发（两者都依赖这条位置上报）。
 * B站恰好 `bvid:cid` 与 `videoKey` 一致，所以只有 B站正常。
 */
export function isPlaybackForContext(payload: Record<string, unknown> | undefined, context: TabContext): boolean {
  const expectedKey = context.videoKey ?? `${context.bvid}:${context.cid}`;
  return payload?.documentEpoch === context.documentEpoch && payload?.videoKey === expectedKey;
}

/** 敏感自动学习控制与订阅只接收本扩展页面，不接收宿主网页或内容脚本。 */
export function isTrustedExtensionSender(sender: chrome.runtime.MessageSender): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(''));
}
