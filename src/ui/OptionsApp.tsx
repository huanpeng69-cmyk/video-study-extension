import { useCallback, useEffect, useState } from 'react';
import { AGNES_PRESET, normalizeEndpoint } from '../domain/endpoint';
import { describeError, toAppError } from '../domain/errors';
import { testConnection } from '../ai/client';
import { checkLocalWhisper, DEFAULT_LOCAL_WHISPER_URL, DEFAULT_WHISHPER_URL } from '../asr/local-whisper';
import { WHISHPER_DEFAULT_MODEL } from '../asr/whishper';
import { clearApiKey, DEFAULT_SETTINGS, loadApiKey, loadSettings, saveApiKey, saveSettings, type AppSettings } from '../storage/settings';

/** 设置页：服务地址、模型、Key 策略与连接测试（PRD F10、F13）。 */
export function OptionsApp() {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [apiKey, setApiKey] = useState('');
  const [keyPresent, setKeyPresent] = useState(false);
  const [message, setMessage] = useState<{ kind: 'ok' | 'error' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [endpointPreview, setEndpointPreview] = useState('');

  const refresh = useCallback(async () => {
    const loaded = await loadSettings();
    setSettings(loaded);
    const key = await loadApiKey(loaded);
    setKeyPresent(Boolean(key));
    if (key) setApiKey(key);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    try {
      setEndpointPreview(normalizeEndpoint(settings.provider.baseUrl).requestUrl);
    } catch {
      setEndpointPreview('');
    }
  }, [settings.provider.baseUrl]);

  const persist = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      await saveSettings(settings);
      await saveApiKey(apiKey, settings.provider.rememberKey);
      const key = await loadApiKey(settings);
      setKeyPresent(Boolean(key));
      setMessage({ kind: 'ok', text: '已保存设置' });
    } catch (error) {
      const normalized = toAppError(error);
      const described = describeError(normalized);
      setMessage({ kind: 'error', text: `${described.title}：${normalized.message}` });
    } finally {
      setBusy(false);
    }
  }, [apiKey, settings]);

  /** 连接测试只发送不含字幕的短文本（技术方案 4.5）。 */
  const runTest = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const endpoint = normalizeEndpoint(settings.provider.baseUrl);
      if (!apiKey.trim()) throw toAppError(new Error('请先填写 API Key'));
      const result = await testConnection({
        baseUrl: settings.provider.baseUrl,
        modelId: settings.provider.modelId,
        apiKey: apiKey.trim(),
        maxTokens: 64,
      });
      const usage = result.usage.totalTokens === null ? '用量未知' : `${result.usage.totalTokens} tokens`;
      setMessage({ kind: 'ok', text: `连接成功：${endpoint.requestUrl} · ${result.model || settings.provider.modelId} · ${usage}` });
    } catch (error) {
      const normalized = toAppError(error);
      const described = describeError(normalized);
      setMessage({
        kind: 'error',
        text: `${described.title}：${normalized.message}${normalized.detail ? `（${normalized.detail}）` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  }, [apiKey, settings.provider.baseUrl, settings.provider.modelId]);

  const requestHostPermission = useCallback(async () => {
    try {
      const origin = new URL(normalizeEndpoint(settings.provider.baseUrl).origin).origin;
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      setMessage(
        granted
          ? { kind: 'ok', text: `已授权 ${origin}` }
          : { kind: 'warn', text: '未授权该域名，AI 功能将无法请求' },
      );
    } catch (error) {
      setMessage({ kind: 'error', text: toAppError(error).message });
    }
  }, [settings.provider.baseUrl]);

  /** 只验证本机服务是否就绪；不发送任何音频、不使用聊天 Key。 */
  const testLocalWhisper = useCallback(async () => {
    setBusy(true);
    setMessage(null);
    try {
      const health = await checkLocalWhisper(settings.localWhisper);
      setMessage({ kind: 'ok', text: `本地转写已就绪：${health.model}` });
    } catch (error) {
      const normalized = toAppError(error);
      const described = describeError(normalized);
      setMessage({
        kind: 'error',
        text: `${described.title}：${normalized.message}${normalized.detail ? `（${normalized.detail}）` : ''}`,
      });
    } finally {
      setBusy(false);
    }
  }, [settings.localWhisper]);

  return (
    <div className="app">
      <header className="app-header">
        <div className="app-title">
          <h1>设置</h1>
        </div>
      </header>
      <main className="panel">
        <div className="stack">
          {message ? <div className={`notice ${message.kind}`}>{message.text}</div> : null}

          <div className="section">
            <h2>AI 服务</h2>
            <div className="stack">
              <div className="row">
                <button
                  type="button"
                  onClick={() =>
                    setSettings((prev) => ({
                      ...prev,
                      provider: {
                        ...prev.provider,
                        id: 'agnes',
                        name: AGNES_PRESET.name,
                        baseUrl: AGNES_PRESET.baseUrl,
                        modelId: AGNES_PRESET.modelId,
                      },
                    }))
                  }
                >
                  使用 Agnes 预设
                </button>
                <span className="hint">也可填写其他 OpenAI 兼容服务</span>
              </div>
              <label className="field">
                服务名称
                <input
                  type="text"
                  value={settings.provider.name}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, provider: { ...prev.provider, name: event.target.value } }))
                  }
                />
              </label>
              <label className="field">
                API 基地址（不含 /chat/completions）
                <input
                  type="text"
                  value={settings.provider.baseUrl}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, provider: { ...prev.provider, baseUrl: event.target.value } }))
                  }
                  placeholder="https://apihub.agnes-ai.com/v1"
                />
              </label>
              <p className="hint">实际请求地址：{endpointPreview || '地址无效'}</p>
              <label className="field">
                模型 ID（以你的账户实际可用为准）
                <input
                  type="text"
                  value={settings.provider.modelId}
                  onChange={(event) =>
                    setSettings((prev) => ({ ...prev, provider: { ...prev.provider, modelId: event.target.value } }))
                  }
                />
              </label>
              <label className="field">
                目标语言
                <input
                  type="text"
                  value={settings.targetLanguage}
                  onChange={(event) => setSettings((prev) => ({ ...prev, targetLanguage: event.target.value }))}
                />
              </label>
              <p className="hint">
                音频转写不经过上面的对话服务：声音只在本机由 Whisper 转成文字，不上传云端，也不需要 API Key。
              </p>
              <label className="field">
                API Key
                <input
                  type="password"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={keyPresent ? '已保存（留空则保持不变）' : '粘贴你自己的 API Key'}
                  autoComplete="off"
                />
              </label>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={settings.provider.rememberKey}
                  onChange={(event) =>
                    setSettings((prev) => ({
                      ...prev,
                      provider: { ...prev.provider, rememberKey: event.target.checked },
                    }))
                  }
                />
                在此浏览器记住 Key（写入本地存储，不是系统密钥库）
              </label>
              <p className="hint">
                默认只在当前浏览器会话保存；扩展更新或浏览器重启后需要重新填写。Key 不会进入笔记、备份或日志。
              </p>
            </div>
          </div>

          <div className="section">
            <h2>权限</h2>
            <div className="row">
              <button type="button" onClick={() => void requestHostPermission()} disabled={busy}>
                授权该模型域名
              </button>
              <span className="hint">仅授权当前服务域名，不是所有网站</span>
            </div>
          </div>

          <div className="section">
            <h2>本地语音转写</h2>
            <label className="field">
              转写服务
              <select
                value={settings.localWhisper.backend}
                onChange={(event) => {
                  const backend = event.target.value === 'whishper' ? 'whishper' : 'local';
                  setSettings((prev) => ({
                    ...prev,
                    localWhisper: {
                      ...prev.localWhisper,
                      backend,
                      // 切换后端时同步默认地址与模型，避免把 8765 填给 Whishper。
                      baseUrl: backend === 'whishper' ? DEFAULT_WHISHPER_URL : DEFAULT_LOCAL_WHISPER_URL,
                      model: backend === 'whishper' ? WHISHPER_DEFAULT_MODEL : '',
                    },
                  }));
                }}
              >
                <option value="local">内置本地服务（8765，同步）</option>
                <option value="whishper">Whishper 容器（8082，异步任务）</option>
              </select>
            </label>
            <label className="field">
              服务地址（只允许 127.0.0.1 / localhost）
              <input
                type="text"
                value={settings.localWhisper.baseUrl}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, localWhisper: { ...prev.localWhisper, baseUrl: event.target.value } }))
                }
                placeholder={settings.localWhisper.backend === 'whishper' ? DEFAULT_WHISHPER_URL : DEFAULT_LOCAL_WHISPER_URL}
              />
            </label>
            {settings.localWhisper.backend === 'whishper' ? (
              <>
                <label className="field">
                  Whishper 模型
                  <select
                    value={settings.localWhisper.model || WHISHPER_DEFAULT_MODEL}
                    onChange={(event) =>
                      setSettings((prev) => ({ ...prev, localWhisper: { ...prev.localWhisper, model: event.target.value } }))
                    }
                  >
                    <option value="tiny">tiny（快，约 0.2× 实时）</option>
                    <option value="small">small（准，约 0.7× 实时，可能跟不上播放）</option>
                  </select>
                </label>
                <p className="hint">
                  实测：<code>tiny</code> 转 60 秒音频约 12.6 秒；<code>small</code> 约 43.6 秒（纯 CPU）。
                  选 <code>small</code> 时若转写速度低于播放速度，录音队列积压后会停止并保留已完成部分。
                </p>
              </>
            ) : null}
            <label className="field">
              转写语言（留空自动识别，可填 zh / en）
              <input
                type="text"
                value={settings.localWhisper.language}
                onChange={(event) =>
                  setSettings((prev) => ({ ...prev, localWhisper: { ...prev.localWhisper, language: event.target.value } }))
                }
                placeholder="留空"
              />
            </label>
            <div className="row">
              <button type="button" onClick={() => void testLocalWhisper()} disabled={busy}>
                测试本地转写
              </button>
              <span className="hint">
                {settings.localWhisper.backend === 'whishper'
                  ? '确保 Docker 中的 whishper 容器已启动；音频只在本机处理。'
                  : <>先运行 <code>scripts/start-local-whisper.ps1</code>；音频只在本机处理，不消耗云端额度。</>}
              </span>
            </div>
          </div>

          <div className="section">
            <h2>SSE 自动学习</h2>
            <label className="checkbox">
              <input type="checkbox" checked={settings.consentAcknowledged}
                onChange={(event) => setSettings((previous) => ({ ...previous, consentAcknowledged: event.target.checked }))} />
              允许按播放进度自动发送当前字幕片段到上述服务
            </label>
            <p className="hint">每 30 秒一个节点，使用当前对话模型的 SSE 接口，可能计费。关闭弹窗不会停止；可在自动学习页暂停。只发送视频标题与当前片段字幕，不发送 B站登录信息或手写笔记。勾选后请保存设置。</p>
          </div>

          <div className="row">
            <button type="button" className="primary" onClick={() => void persist()} disabled={busy}>
              保存设置
            </button>
            <button type="button" onClick={() => void runTest()} disabled={busy}>
              测试连接
            </button>
            <button
              type="button"
              className="danger"
              onClick={() => {
                void clearApiKey()
                  .then(() => {
                    setApiKey('');
                    setKeyPresent(false);
                    setMessage({ kind: 'ok', text: '已清除本机 API Key' });
                  })
                  .catch((error) => setMessage({ kind: 'error', text: toAppError(error).message }));
              }}
            >
              清除 Key
            </button>
          </div>

          <div className="notice">
            <strong>数据去向</strong>
            翻译或自动学习时，字幕文本会发送到上面填写的服务域名；视频文件、B站登录信息和其他笔记不会发送。
            自动学习须先勾选确认并授权模型域名。服务商可能计费并按自身政策处理数据；本地笔记与导出不受影响。
          </div>
        </div>
      </main>
    </div>
  );
}
