import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  outDir: 'output',
  manifest: {
    name: '视频学习笔记',
    description: '在任意网站的视频页学习：识别播放器、读取页内字幕、音频转写、随播放自动生成带引用笔记，本地保存并导出 Markdown。',
    version: '0.15.0',
    // tabCapture/offscreen：只为「从音频转写」采集当前标签页声音到本机。
    // 不新增 <all_urls> 之外的宿主权限，也不申请 webRequest 之类可读请求内容的权限。
    permissions: ['storage', 'scripting', 'alarms', 'tabCapture', 'offscreen'],
    // 通用层：https 与本地 http 视频页都能识别（脚本按需注入，不在所有页面常驻）。
    // B站三条用于适配器能力（分 P、站方字幕轨道）。
    host_permissions: [
      'https://www.bilibili.com/*',
      'https://api.bilibili.com/*',
      'https://*.hdslb.com/*',
      'https://*/*',
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    optional_host_permissions: ['http://*/*'],
    // 保持标准弹窗，不往视频页注入 UI。
    // SSE 连接由 Service Worker 持有；弹窗关闭只退订显示，任务仍可续跑。
    action: {
      default_popup: 'panel.html',
      default_title: '视频学习笔记',
    },
    web_accessible_resources: [
      {
        resources: ['library.html', 'options.html', 'selfcheck.html'],
        matches: ['https://*/*'],
      },
    ],
  },
});
