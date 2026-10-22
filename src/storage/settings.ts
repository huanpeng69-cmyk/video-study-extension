/**
 * 配置与密钥（技术方案 4.4、7.1）。
 * - 非敏感配置：storage.local，可信上下文
 * - 默认 Key：storage.session（浏览器重启/扩展更新后清空）
 * - 可选记住：storage.local 的独立记录
 * - 永不写 storage.sync，永不进入导出与日志
 */
import { appError, toAppError } from '../domain/errors';
import { AGNES_PRESET, normalizeEndpoint } from '../domain/endpoint';
import { DEFAULT_LOCAL_WHISPER, normalizeLocalWhisper, type LocalWhisperConfig } from '../asr/local-whisper';

export interface ProviderConfig {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  /** 是否允许把 Key 持久化到 storage.local。 */
  rememberKey: boolean;
}

export interface AppSettings {
  provider: ProviderConfig;
  targetLanguage: string;
  /** 用户已确认过发送范围。 */
  consentAcknowledged: boolean;
  maxTokens: number;
  /** 旧版云端 ASR 字段仅为配置兼容保留，新转写链路不再使用。 */
  transcribeModelId: string;
  /** 本地转写独立于聊天 API。实际模型/可执行文件由本机桥接配置。 */
  localWhisper: LocalWhisperConfig;
}

const SETTINGS_KEY = 'settings.v1';
const KEY_SESSION = 'apiKey.session.v1';
const KEY_LOCAL = 'apiKey.local.v1';

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    id: 'agnes',
    name: AGNES_PRESET.name,
    baseUrl: AGNES_PRESET.baseUrl,
    modelId: AGNES_PRESET.modelId,
    rememberKey: false,
  },
  targetLanguage: '简体中文',
  consentAcknowledged: false,
  maxTokens: 2048,
  transcribeModelId: '',
  localWhisper: { ...DEFAULT_LOCAL_WHISPER },
};

function trustedStorage(): chrome.storage.StorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage ? chrome.storage.local : null;
}

function sessionStorage(): chrome.storage.StorageArea | null {
  return typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null;
}

function wrap<T>(operation: () => Promise<T>, message: string): Promise<T> {
  return operation().catch((cause) => {
    throw toAppError(cause, 'STORAGE_FAILED', message);
  });
}

export async function loadSettings(): Promise<AppSettings> {
  const area = trustedStorage();
  if (!area) return { ...DEFAULT_SETTINGS };
  const stored = await wrap(() => area.get(SETTINGS_KEY), '读取设置失败');
  const raw = stored[SETTINGS_KEY] as Partial<AppSettings> | undefined;
  if (!raw) return { ...DEFAULT_SETTINGS };
  return {
    ...DEFAULT_SETTINGS,
    ...raw,
    provider: { ...DEFAULT_SETTINGS.provider, ...(raw.provider ?? {}) },
    localWhisper: { ...DEFAULT_LOCAL_WHISPER, ...(raw.localWhisper ?? {}) },
  };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const area = trustedStorage();
  if (!area) return;
  const normalized = {
    ...settings,
    provider: {
      ...settings.provider,
      baseUrl: normalizeEndpoint(settings.provider.baseUrl).baseUrl,
      modelId: settings.provider.modelId.trim(),
      name: settings.provider.name.trim() || settings.provider.id,
    },
    targetLanguage: settings.targetLanguage.trim() || '简体中文',
    localWhisper: normalizeLocalWhisper(settings.localWhisper),
  };
  await wrap(() => area.set({ [SETTINGS_KEY]: normalized }), '保存设置失败');
}

/**
 * 保存 Key：remember=false 时写入 session 并清除 local 副本，
 * 避免“取消记住”后旧 Key 仍留在磁盘。
 */
export async function saveApiKey(apiKey: string, remember: boolean): Promise<void> {
  const local = trustedStorage();
  const session = sessionStorage();
  const value = apiKey.trim();
  if (!value) {
    await clearApiKey();
    return;
  }
  if (session) await wrap(() => session.set({ [KEY_SESSION]: value }), '保存会话密钥失败');
  if (local) {
    if (remember) {
      await wrap(() => local.set({ [KEY_LOCAL]: value }), '保存密钥失败');
    } else {
      await wrap(() => local.remove(KEY_LOCAL), '清理本地密钥失败');
    }
  }
}

export async function loadApiKey(settings: AppSettings): Promise<string | null> {
  const session = sessionStorage();
  if (session) {
    const stored = await wrap(() => session.get(KEY_SESSION), '读取会话密钥失败');
    const value = stored[KEY_SESSION];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (!settings.provider.rememberKey) return null;
  const local = trustedStorage();
  if (!local) return null;
  const stored = await wrap(() => local.get(KEY_LOCAL), '读取密钥失败');
  const value = stored[KEY_LOCAL];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export async function clearApiKey(): Promise<void> {
  const session = sessionStorage();
  const local = trustedStorage();
  if (session) await wrap(() => session.remove(KEY_SESSION), '清除会话密钥失败');
  if (local) await wrap(() => local.remove(KEY_LOCAL), '清除密钥失败');
}

/** 只允许可信扩展上下文访问这两个区域，避免 Content Script 读取配置与 Key。 */
export async function restrictStorageAccess(): Promise<void> {
  const local = trustedStorage();
  const session = sessionStorage();
  try {
    await local?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* 旧版浏览器不支持时忽略：Key 不放到 local 之外仍然安全。 */
  }
  try {
    await session?.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });
  } catch {
    /* 同上。 */
  }
}

export interface ReadyProvider {
  baseUrl: string;
  modelId: string;
  apiKey: string;
  providerId: string;
  providerName: string;
  maxTokens: number;
  targetLanguage: string;
}

export function assertProviderReady(settings: AppSettings, apiKey: string | null): ReadyProvider {
  if (!settings.provider.baseUrl.trim() || !settings.provider.modelId.trim()) {
    throw appError('PROVIDER_NOT_CONFIGURED', '请先填写 API 基地址与模型 ID');
  }
  if (!apiKey) throw appError('PROVIDER_NOT_CONFIGURED', '缺少 API Key');
  const endpoint = normalizeEndpoint(settings.provider.baseUrl);
  return {
    baseUrl: endpoint.baseUrl,
    modelId: settings.provider.modelId.trim(),
    apiKey,
    providerId: settings.provider.id,
    providerName: settings.provider.name || settings.provider.id,
    maxTokens: settings.maxTokens,
    targetLanguage: settings.targetLanguage,
  };
}
