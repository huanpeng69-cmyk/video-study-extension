/**
 * 主世界桥接：读取页面自身的 __INITIAL_STATE__，抽取当前分 P 的 aid / cid / 标题 / 时长。
 *
 * 为什么需要它：`window.aid` / `window.cid` 在新版 B站 SPA 下并不存在（实测页面 HTML
 * 只有 `window.__INITIAL_STATE__`），而隔离世界又读不到页面全局变量。
 *
 * 只读白名单字段；不读取 Cookie、localStorage、请求体或任何鉴权数据。
 */
import { defineContentScript } from 'wxt/utils/define-content-script';
import { extractFromInitialState } from '../adapters/bilibili/snapshot';
import { makeStateReply, STATE_REQUEST, type StateRequestMessage } from '../adapters/bilibili/bridge-protocol';
import { isRecord } from '../lib/guards';
import { vsLog } from '../lib/log';

export default defineContentScript({
  matches: ['https://www.bilibili.com/video/*'],
  runAt: 'document_idle',
  world: 'MAIN',
  main() {
    const MARK = '__videoStudyNotesBridge';
    const scope = window as unknown as Record<string, unknown>;
    if (scope[MARK]) return;
    scope[MARK] = true;

    const read = () => {
      const initial = extractFromInitialState(scope.__INITIAL_STATE__, window.location.href);
      if (initial) return initial;

      // 回退：部分页面仍会暴露全局变量。
      const aid = scope.aid;
      const cid = scope.cid;
      if ((typeof aid === 'string' || typeof aid === 'number') && (typeof cid === 'string' || typeof cid === 'number')) {
        const bvid = typeof scope.bvid === 'string' ? scope.bvid : '';
        const titleEl = document.querySelector<HTMLElement>('h1.video-title, h1');
        return {
          aid: String(aid),
          cid: String(cid),
          bvid,
          title: titleEl?.textContent?.trim() ?? '',
          pageIndex: 1,
          durationMs: 0,
        };
      }
      return null;
    };

    window.addEventListener('message', (event: MessageEvent) => {
      if (event.source !== window) return;
      const data: unknown = event.data;
      // 只应答真正的“请求”类型；旧实现只比对 channel，请求被自己拦截（见 bridge-protocol）。
      if (!isRecord(data) || data.type !== STATE_REQUEST || typeof data.channel !== 'string') return;
      const request = data as unknown as StateRequestMessage;
      const snapshot = read();
      vsLog.info('bridge:reply', {
        statePresent: Boolean(scope.__INITIAL_STATE__),
        snapshotOk: Boolean(snapshot),
      });
      try {
        window.postMessage(makeStateReply(request.channel, snapshot), window.location.origin);
      } catch {
        // 页面禁止 postMessage 时，隔离世界会退回 URL/DOM 方案并从快照里得到明确原因。
      }
    });

    vsLog.info('bridge:ready', { url: window.location.pathname, statePresent: Boolean(scope.__INITIAL_STATE__) });
  },
});
