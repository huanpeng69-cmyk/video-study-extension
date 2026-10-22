import { describe, expect, it } from 'vitest';
import { ASR_OFFSCREEN_TARGET, ASR_BACKGROUND_TARGET, ASR_EVENT_TYPE } from '../src/asr/tab-protocol';

/**
 * 回归：后台与离屏文档必须对「事件消息类型」有唯一一致的定义。
 *
 * 历史缺陷：离屏文档发 `type: 'event'`，后台却判断 `message.type === 'ASR_EVENT'`，
 * 于是后台永远收不到采集事件 —— 进度停在 0/1、一个字也不会入库。
 * 这里把两侧共用的常量钉死，避免再各写一份字面量。
 */
describe('ASR 跨文档消息契约', () => {
  it('离屏目标与后台目标必须是不同的字符串', () => {
    expect(ASR_OFFSCREEN_TARGET).toBe('video-study-asr-offscreen');
    expect(ASR_BACKGROUND_TARGET).toBe('video-study-asr-background');
    expect(ASR_OFFSCREEN_TARGET).not.toBe(ASR_BACKGROUND_TARGET);
  });

  it('事件类型是唯一常量，不能被写成裸字符串', () => {
    expect(ASR_EVENT_TYPE).toBe('event');
    // 后台若再按别的字面量判断（例如 'ASR_EVENT'）就会静默丢事件。
    expect(ASR_EVENT_TYPE).not.toBe('ASR_EVENT');
  });
});
