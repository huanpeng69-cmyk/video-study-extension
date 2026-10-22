import { describe, expect, it } from 'vitest';
import { normalizeEndpoint, isAllowedSubtitleHost } from '../src/domain/endpoint';

describe('模型地址规范化', () => {
  it('保留基地址路径并追加固定 endpoint', () => {
    expect(normalizeEndpoint('https://apihub.agnes-ai.com/v1').requestUrl).toBe(
      'https://apihub.agnes-ai.com/v1/chat/completions',
    );
    expect(normalizeEndpoint('https://proxy.example/api/v1/').baseUrl).toBe('https://proxy.example/api/v1');
  });

  it('拒绝完整 endpoint、非 HTTPS 与带凭据的地址', () => {
    expect(() => normalizeEndpoint('https://apihub.agnes-ai.com/v1/chat/completions')).toThrowError(/基地址/);
    expect(() => normalizeEndpoint('http://apihub.agnes-ai.com/v1')).toThrowError(/HTTPS/);
    expect(() => normalizeEndpoint('https://user:pass@example.com/v1')).toThrowError(/账号或密码/);
    expect(() => normalizeEndpoint('https://example.com/v1?key=1')).toThrowError(/查询参数/);
    expect(() => normalizeEndpoint('not a url')).toThrowError(/合法 URL/);
  });

  it('授权模式只覆盖该主机', () => {
    expect(normalizeEndpoint('https://apihub.agnes-ai.com/v1').hostPermissionPattern).toBe(
      'https://apihub.agnes-ai.com/*',
    );
  });
});

describe('字幕来源域名白名单', () => {
  it('接受 B站字幕 CDN 已知后缀', () => {
    expect(isAllowedSubtitleHost('https://i0.hdslb.com/bfs/subtitle/a.json')).toBe(true);
    expect(isAllowedSubtitleHost('https://aisubtitle.hdslb.com/bfs/ai_subtitle/x.json')).toBe(true);
    expect(isAllowedSubtitleHost('https://api.bilibili.com/x/y')).toBe(true);
  });

  it('拒绝相似域名、非 HTTPS 与带凭据地址', () => {
    expect(isAllowedSubtitleHost('https://evil-hdslb.com/a.json')).toBe(false);
    expect(isAllowedSubtitleHost('https://hdslb.com.evil.com/a.json')).toBe(false);
    expect(isAllowedSubtitleHost('http://i0.hdslb.com/a.json')).toBe(false);
    expect(isAllowedSubtitleHost('https://user:pass@i0.hdslb.com/a.json')).toBe(false);
    expect(isAllowedSubtitleHost('https://example.com/a.json')).toBe(false);
  });
});
