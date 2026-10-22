/** 统一错误分类：不同来源的失败必须能被区分，不能都展示成“生成失败”。 */
export type ErrorCode =
  | 'UNSUPPORTED_PAGE'
  | 'PLAYER_NOT_READY'
  | 'LOGIN_REQUIRED'
  | 'NO_SUBTITLE'
  | 'SUBTITLE_UNKNOWN'
  | 'SUBTITLE_HOST_BLOCKED'
  | 'SUBTITLE_READ_FAILED'
  | 'PARSE_FAILED'
  | 'PARSE_WARNINGS'
  | 'PROVIDER_NOT_CONFIGURED'
  | 'CONSENT_REQUIRED'
  | 'LOCAL_WHISPER_UNAVAILABLE'
  | 'LOCAL_WHISPER_ERROR'
  | 'CAPTURE_UNAVAILABLE'
  | 'NO_SPEECH'
  /** 采集到的音频本身是数字静音（设备/路由问题），与「页面被静音」是两件事。 */
  | 'CAPTURE_SILENT'
  /** 采集被浏览器打断（设备切换、音轨结束），已完成分片仍会保留。 */
  | 'CAPTURE_INTERRUPTED'
  | 'PERMISSION_DENIED'
  | 'AUTH_FAILED'
  | 'QUOTA_EXCEEDED'
  | 'NOT_FOUND'
  | 'BAD_REQUEST'
  | 'TOO_LARGE'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR'
  | 'NETWORK_ERROR'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'BAD_RESPONSE'
  | 'VALIDATION_FAILED'
  | 'STORAGE_FAILED'
  | 'BACKUP_INVALID'
  | 'UNKNOWN';

export interface AppError {
  code: ErrorCode;
  message: string;
  /** 已脱敏的补充信息，禁止写入密钥、Cookie、完整字幕正文。 */
  detail?: string;
  retryable: boolean;
  httpStatus?: number;
}

export function appError(code: ErrorCode, message: string, extra?: Partial<Omit<AppError, 'code' | 'message'>>): AppError {
  return { code, message, retryable: RETRYABLE.has(code), ...extra };
}

const RETRYABLE = new Set<ErrorCode>([
  'NETWORK_ERROR',
  'TIMEOUT',
  'SERVER_ERROR',
  'RATE_LIMITED',
  'PLAYER_NOT_READY',
  'SUBTITLE_READ_FAILED',
  'STORAGE_FAILED',
]);

export function isRetryable(error: AppError): boolean {
  return RETRYABLE.has(error.code);
}

/** 将未知异常收敛为 AppError，避免把原始对象（可能含请求头）直接抛给 UI。 */
export function toAppError(cause: unknown, fallbackCode: ErrorCode = 'UNKNOWN', fallbackMessage = '发生未知错误'): AppError {
  if (isAppError(cause)) return cause;
  if (cause instanceof DOMException && cause.name === 'AbortError') {
    return appError('ABORTED', '操作已取消');
  }
  const message = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : fallbackMessage;
  return appError(fallbackCode, message || fallbackMessage);
}

export function isAppError(value: unknown): value is AppError {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    'message' in value &&
    'retryable' in value &&
    typeof (value as AppError).code === 'string'
  );
}

/** 错误文案：用户可据此决定下一步。 */
export function describeError(error: AppError): { title: string; action: string } {
  switch (error.code) {
    case 'UNSUPPORTED_PAGE':
      return { title: '当前页面暂不支持', action: '请打开包含 HTML5 视频的网页；浏览器内部页与受保护播放器除外' };
    case 'PLAYER_NOT_READY':
      return { title: '播放器尚未就绪', action: '等待视频加载后重新识别' };
    case 'LOGIN_REQUIRED':
      return { title: '该字幕可能需要登录后读取', action: '按当前网站要求登录，或改用导入字幕/本地语音转写' };
    case 'NO_SUBTITLE':
      return { title: '当前未发现可读取的字幕', action: '可导入 SRT/VTT 文件，或先手写笔记' };
    case 'SUBTITLE_UNKNOWN':
      return { title: '字幕信息读取失败，尚不能确定是否有字幕', action: '重试或导入字幕文件' };
    case 'SUBTITLE_HOST_BLOCKED':
      return { title: '该字幕来源不在允许的域名内', action: '请导入字幕文件' };
    case 'SUBTITLE_READ_FAILED':
      return { title: '字幕正文读取失败', action: '重试，或导入字幕文件' };
    case 'PARSE_FAILED':
      return { title: '字幕文件无法解析', action: '检查文件格式与编码（UTF-8）' };
    case 'PARSE_WARNINGS':
      return { title: '字幕存在无效条目', action: '可确认后仅导入有效条目' };
    case 'CONSENT_REQUIRED':
      return { title: '尚未确认自动发送字幕', action: '在设置中确认数据去向并保存；未确认时不会自动请求模型' };
    case 'LOCAL_WHISPER_UNAVAILABLE':
      return { title: '本地语音转写服务未启动', action: '运行本地转写启动脚本，再在设置中测试连接' };
    case 'LOCAL_WHISPER_ERROR':
      return { title: '本地语音转写失败', action: '检查本地服务的模型和运行环境，不会自动回退云端' };
    case 'CAPTURE_UNAVAILABLE':
      return { title: '标签页音频采集不可用', action: '请在 Chrome/Edge 116+ 的视频标签页点扩展并授权；确认音频正在播放' };
    case 'NO_SPEECH':
      return { title: '未识别到语音', action: '声音已采集但模型没有识别出文字；可换用更准确的模型后重试' };
    case 'CAPTURE_SILENT':
      return {
        title: '采集到的音频是静音',
        action: '页面并未静音：请确认页面音量不为 0、系统输出设备正常；插拔耳机后请重新开始转写',
      };
    case 'CAPTURE_INTERRUPTED':
      return {
        title: '音频采集被中断',
        action: '让视频正常播放后重新开始转写；已完成的分片会保留，音频不会发送到云端',
      };
    case 'PROVIDER_NOT_CONFIGURED':
      return { title: 'AI 尚未连接', action: '在设置中填写服务地址、模型与自己的 API Key' };
    case 'PERMISSION_DENIED':
      return { title: '未获得所需访问权限', action: '授权当前网站或服务域名后重试；本地笔记仍可用' };
    case 'AUTH_FAILED':
      return { title: 'API Key 无效或无权访问该模型', action: '检查 Key 与模型权限' };
    case 'QUOTA_EXCEEDED':
      return { title: '账户余额、套餐或额度不足', action: '查看服务商控制台' };
    case 'NOT_FOUND':
      return { title: '接口地址或模型不存在', action: '核对 Base URL 与模型 ID' };
    case 'BAD_REQUEST':
      return { title: '请求参数不被该服务支持', action: '检查模型能力与参数设置' };
    case 'TOO_LARGE':
      return { title: '本次文本超出模型上下文', action: '缩小范围或减小每批条数' };
    case 'RATE_LIMITED':
      return { title: '触发限流', action: '稍后再试，或减少并发' };
    case 'SERVER_ERROR':
      return { title: '服务暂时不可用', action: '稍后重试' };
    case 'NETWORK_ERROR':
      return { title: '网络连接失败', action: '检查网络与代理后重试' };
    case 'TIMEOUT':
      return { title: '请求超时', action: '重试；结果可能已在服务端处理' };
    case 'ABORTED':
      return { title: '已取消', action: '可重新开始任务' };
    case 'BAD_RESPONSE':
      return { title: '模型返回内容格式异常', action: '重试该段，或更换模型' };
    case 'VALIDATION_FAILED':
      return { title: '生成结果未通过校验', action: '仅重试失败的段落' };
    case 'STORAGE_FAILED':
      return { title: '本地保存失败', action: '复制或导出当前内容后再清理空间' };
    case 'BACKUP_INVALID':
      return { title: '备份文件无法使用', action: '确认文件来源与版本' };
    default:
      return { title: '发生未知错误', action: '查看脱敏信息后重试' };
  }
}
