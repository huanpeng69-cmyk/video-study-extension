import { describe, expect, it } from 'vitest';
import {
  isStateReplyFor,
  isStateRequestFor,
  makeStateReply,
  makeStateRequest,
  STATE_REPLY,
  STATE_REQUEST,
} from '../src/adapters/bilibili/bridge-protocol';
import { resolveSnapshot } from '../src/adapters/bilibili/snapshot';

/**
 * 回归测试：旧实现的请求与应答共用同一个 channel，且应答处理器只比对 channel。
 * 由于 window.postMessage 会把消息派发给同一 window 的所有监听器（含发出者自己），
 * 请求刚发出就被自己的处理器命中，立刻解析为 null，主世界应答永远收不到——
 * 界面因此恒显示“未能读取当前视频信息”。
 */
describe('主世界桥接协议', () => {
  it('请求与应答的类型不同，不能互相误判', () => {
    const request = makeStateRequest('ch-1');
    const reply = makeStateReply('ch-1', { aid: '1' });

    expect(request.type).toBe(STATE_REQUEST);
    expect(reply.type).toBe(STATE_REPLY);

    // 关键：隔离世界的监听器必须忽略自己发出的请求。
    expect(isStateReplyFor(request, 'ch-1')).toBe(false);
    // 主世界的监听器必须接受请求。
    expect(isStateRequestFor(request, 'ch-1')).toBe(true);
    // 反向同理。
    expect(isStateRequestFor(reply, 'ch-1')).toBe(false);
    expect(isStateReplyFor(reply, 'ch-1')).toBe(true);
  });

  it('channel 不匹配时不接受（避免并发请求串台）', () => {
    const reply = makeStateReply('ch-a', null);
    expect(isStateReplyFor(reply, 'ch-b')).toBe(false);
    expect(isStateRequestFor(makeStateRequest('ch-a'), 'ch-b')).toBe(false);
  });

  it('忽略无关消息与畸形数据', () => {
    expect(isStateReplyFor(null, 'ch-1')).toBe(false);
    expect(isStateReplyFor('string', 'ch-1')).toBe(false);
    expect(isStateReplyFor({ channel: 'ch-1' }, 'ch-1')).toBe(false); // 缺少 type
    expect(isStateRequestFor({ type: STATE_REQUEST }, 'ch-1')).toBe(false); // 缺少 channel
  });

  it('应答允许 snapshot 为 null（表示主世界拿不到数据，而不是把请求当成应答）', () => {
    const reply = makeStateReply('ch-1', null);
    expect(isStateReplyFor(reply, 'ch-1')).toBe(true);
    expect(reply.snapshot).toBeNull();
  });
});

describe('快照失败原因区分', () => {
  const HREF = 'https://www.bilibili.com/video/BV1GJ411x7h7/';

  it('拿到 aid/cid 时成功', () => {
    const outcome = resolveSnapshot({
      href: HREF,
      initial: { bvid: 'BV1GJ411x7h7', aid: '80433022', cid: '137649199', title: 'T' },
      globalVars: null,
      domTitle: 'DOM',
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.failure).toBeNull();
  });

  it('主世界无应答时报 main-world-unavailable，而不是笼统的加载失败', () => {
    const outcome = resolveSnapshot({ href: HREF, initial: null, globalVars: null, domTitle: 'DOM' });
    expect(outcome.ok).toBe(false);
    expect(outcome.failure).toBe('main-world-unavailable');
  });

  it('主世界有数据但缺 aid 时报 missing-aid', () => {
    const outcome = resolveSnapshot({ href: HREF, initial: { bvid: 'BV1GJ411x7h7', cid: '1' }, globalVars: null });
    expect(outcome.failure).toBe('missing-aid');
  });

  it('缺 cid 时报 missing-cid', () => {
    const outcome = resolveSnapshot({ href: HREF, initial: { bvid: 'BV1GJ411x7h7', aid: '1' }, globalVars: null });
    expect(outcome.failure).toBe('missing-cid');
  });

  it('URL 都没有 bvid 时报 unsupported-url', () => {
    const outcome = resolveSnapshot({ href: 'https://www.bilibili.com/bangumi/play/ep1', initial: null, globalVars: null });
    expect(outcome.failure).toBe('unsupported-url');
  });

  it('诊断信息只含布尔与序号，不含 URL 参数', () => {
    const outcome = resolveSnapshot({ href: `${HREF}?p=2&token=secret`, initial: null, globalVars: null });
    expect(outcome.diag.pageIndex).toBe(2);
    expect(JSON.stringify(outcome.diag)).not.toContain('secret');
  });
});
