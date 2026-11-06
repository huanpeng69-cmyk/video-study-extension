/**
 * 回归：界面从「点击即关的弹窗」改为「常驻浏览器侧边栏」。
 *
 * 依据 Chrome 官方 sidePanel 文档：
 * - manifest 需要 "sidePanel" 权限与 side_panel.default_path；
 * - 想让工具栏图标打开侧边栏，manifest 保留 action 但**不能**设 default_popup，
 *   再由 sidePanel.setPanelBehavior({ openPanelOnActionClick: true }) 决定点击行为。
 *
 * 这里锁的是配置契约，不是真机行为：侧边栏能否打开仍需在浏览器里加载扩展验证。
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const config = readFileSync('wxt.config.ts', 'utf8');
const background = readFileSync('src/entrypoints/background.ts', 'utf8');
const panelHtml = readFileSync('src/entrypoints/panel/index.html', 'utf8');

describe('常驻侧边栏（源码级契约）', () => {
  it('manifest 声明 sidePanel 权限与侧边栏默认页面', () => {
    expect(config).toMatch(/'sidePanel'/);
    expect(config).toMatch(/side_panel:\s*\{[\s\S]{0,80}default_path:\s*'panel\.html'/);
  });

  it('不再把面板注册成 default_popup，否则点击图标仍是弹窗', () => {
    expect(config).not.toMatch(/default_popup/);
    expect(config).toMatch(/action:\s*\{[\s\S]{0,120}default_title:/);
  });

  it('后台用 sidePanel.open() 打开侧边栏（这会触发 activeTab 授权）', () => {
    expect(background).toMatch(/setPanelBehavior\?\.\(\{ openPanelOnActionClick: false \}\)/);
    expect(background).toMatch(/chrome\.sidePanel[\s\S]*?\.open\(\{ tabId: tab\.id \}\)/);
    expect(background).toMatch(/sidepanel:open-failed/);
  });

  it('侧边栏页面不再写死 520x600，宽度交给浏览器', () => {
    expect(panelHtml).not.toMatch(/width:\s*520px/);
    expect(panelHtml).not.toMatch(/height:\s*600px/);
    expect(panelHtml).toMatch(/height:\s*100%/);
  });
});
