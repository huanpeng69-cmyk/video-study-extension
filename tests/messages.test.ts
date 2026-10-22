import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, withRequestId } from '../src/lib/messages';

/**
 * 回归测试：旧实现的内容脚本上报不带 version，后台对所有消息强制校验版本，
 * 导致上下文被丢弃、弹窗永远停在“播放器尚未就绪”。
 */
function shouldReject(message: { version?: number }): boolean {
  // 与 background 的判定保持一致：只有显式携带版本时才校验。
  return typeof message.version === 'number' && message.version !== PROTOCOL_VERSION;
}

describe('消息版本校验', () => {
  it('未携带版本的消息不应被拒绝', () => {
    expect(shouldReject({})).toBe(false);
  });

  it('携带正确版本的消息通过', () => {
    expect(shouldReject({ version: PROTOCOL_VERSION })).toBe(false);
  });

  it('携带错误版本的消息被拒绝', () => {
    expect(shouldReject({ version: PROTOCOL_VERSION + 1 })).toBe(true);
  });

  it('UI 请求统一带上版本与 requestId 信封', () => {
    const request = withRequestId({ type: 'CAPTURE_VIDEO', payload: {} });
    expect(request.version).toBe(PROTOCOL_VERSION);
    expect(request.requestId.startsWith('req-')).toBe(true);
    expect(request.type).toBe('CAPTURE_VIDEO');
  });
});
