# 启动本机语音转写服务（只监听 127.0.0.1）。
#
# 为什么需要脚本：浏览器扩展不能直接执行 Python；必须由你在本机启动一个
# 只回环监听的服务，扩展把标签页音频交给它，转成文字。
#
# 用法：
#   1) 准备一个完整的 CTranslate2 Whisper 模型目录（含 model.bin/config.json/tokenizer.json）；
#   2) $env:WHISPER_MODEL_DIR = 'D:\models\faster-whisper-small'
#   3) .\scripts\start-local-whisper.ps1
#
# 本脚本不会下载模型，也不会把音频发到任何网络地址。

param(
  [string]$ModelDir = $env:WHISPER_MODEL_DIR,
  [string]$Python = 'C:\Users\86131\AppData\Local\Programs\Python\Python313\python.exe',
  [int]$Port = 8765
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$server = Join-Path $PSScriptRoot 'local-whisper-server.py'

if (-not (Test-Path -LiteralPath $server)) {
  throw "找不到本地服务脚本：$server"
}
if (-not (Test-Path -LiteralPath $Python)) {
  throw "找不到 Python：$Python（请用 -Python 指向已安装 faster-whisper 的解释器）"
}
if ([string]::IsNullOrWhiteSpace($ModelDir)) {
  Write-Warning '未设置 -ModelDir / WHISPER_MODEL_DIR：服务会启动但报告 not-ready，直到提供模型目录。'
} elseif (-not (Test-Path -LiteralPath $ModelDir)) {
  throw "模型目录不存在：$ModelDir"
}

# 依赖自检：缺失时给出明确指引，不自动安装、不联网。
& $Python -B -c "import faster_whisper" 2>$null
if ($LASTEXITCODE -ne 0) {
  throw "当前 Python 未安装 faster-whisper。请先在该解释器中安装，再重试。"
}

if ($ModelDir) { $env:WHISPER_MODEL_DIR = $ModelDir }
$env:WHISPER_PORT = "$Port"
$env:PYTHONDONTWRITEBYTECODE = '1'

Write-Host "本地转写服务： http://127.0.0.1:$Port" -ForegroundColor Cyan
Write-Host "健康检查：     http://127.0.0.1:$Port/health" -ForegroundColor DarkGray
Write-Host "停止服务：     按 Ctrl+C" -ForegroundColor DarkGray

Push-Location $root
try {
  & $Python -B $server
} finally {
  Pop-Location
}
