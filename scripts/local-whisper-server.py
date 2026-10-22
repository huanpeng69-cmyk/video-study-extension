"""
本地语音转写服务（仅本机回环地址）。

为什么需要它：浏览器扩展无法直接执行 Python，也无法读取本地文件；
音频必须在用户本机完成转写，不能用云端接口代替。

设计约束：
- 只监听 127.0.0.1，不做鉴权代理、不转发到任何远端。
- 模型路径必须由环境变量显式给出；缺失时明确失败并说明原因，不自动联网下载。
- 只接受扩展发来的 WebM/Opus 字节流，返回带真实分段时间的 JSON。
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any

MODEL_ENV = "WHISPER_MODEL_DIR"
ALLOWED_EXT = {".webm", ".ogg", ".m4a", ".mp4", ".wav", ".mp3"}
MAX_BYTES = 8 * 1024 * 1024
SERVICE_NAME = "video-study-whisper"

_model: Any = None
_lock = threading.Lock()


def json_response(handler: Any, status: int, payload: dict[str, Any]) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.send_header("Cache-Control", "no-store")
    handler.end_headers()
    handler.wfile.write(body)


def resolve_model_dir() -> Path:
    raw = os.environ.get(MODEL_ENV, "").strip()
    if not raw:
        raise RuntimeError(
            f"未设置 {MODEL_ENV}。请把它指向完整的 CTranslate2 Whisper 模型目录"
            "（需含 model.bin、config.json、tokenizer.json）。本服务不会自动下载模型。"
        )
    path = Path(raw).expanduser()
    if not path.is_dir():
        raise RuntimeError(f"{MODEL_ENV} 指向的目录不存在：{path}")
    missing = [name for name in ("model.bin", "config.json", "tokenizer.json") if not (path / name).is_file()]
    if missing:
        raise RuntimeError(f"模型目录缺少必要文件：{', '.join(missing)}（路径 {path}）")
    return path


def load_model() -> Any:
    global _model
    with _lock:
        if _model is not None:
            return _model
        from faster_whisper import WhisperModel  # 延迟导入，避免健康检查失败时无法回报原因

        directory = resolve_model_dir()
        # local_files_only：绝不因为缺文件而去联网拉取。
        _model = WhisperModel(
            str(directory),
            device=os.environ.get("WHISPER_DEVICE", "cpu"),
            compute_type=os.environ.get("WHISPER_COMPUTE_TYPE", "int8"),
            cpu_threads=int(os.environ.get("WHISPER_CPU_THREADS", "4")),
            local_files_only=True,
        )
        return _model


def model_ready() -> str | None:
    """返回就绪的模型目录名；未就绪返回 None。不抛异常。"""
    try:
        return resolve_model_dir().name
    except RuntimeError:
        return None


def transcribe(audio: bytes, suffix: str, language: str | None) -> list[dict[str, Any]]:
    model = load_model()
    with tempfile.TemporaryDirectory(prefix="vs-asr-") as folder:
        target = Path(folder) / f"input{suffix}"
        target.write_bytes(audio)
        segments, _info = model.transcribe(
            str(target),
            language=language or None,
            beam_size=1,
            vad_filter=os.environ.get("WHISPER_VAD", "1") == "1",
        )
        # 时间戳来自模型自身输出，不做补齐或外推。
        return [
            {"start": float(seg.start), "end": float(seg.end), "text": seg.text.strip()}
            for seg in segments
            if seg.text and seg.text.strip()
        ]


def build_handler() -> Any:
    from http.server import BaseHTTPRequestHandler

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt: str, *args: Any) -> None:  # 不打印音频与正文
            sys.stderr.write("[whisper] %s\n" % (fmt % args))

        def _allowed_origin(self) -> bool:
            # 扩展请求带 Origin: chrome-extension://<id>；只回显扩展来源，便于正确 CORS。
            origin = self.headers.get("Origin", "")
            return origin.startswith("chrome-extension://") or origin.startswith("moz-extension://")

        def _cors(self) -> None:
            origin = self.headers.get("Origin", "")
            if self._allowed_origin():
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")

        def do_OPTIONS(self) -> None:  # noqa: N802
            self.send_response(204)
            self._cors()
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header(
                "Access-Control-Allow-Headers",
                "Content-Type, X-VideoStudy-Client, X-VideoStudy-Language",
            )
            self.send_header("Access-Control-Max-Age", "600")
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_GET(self) -> None:  # noqa: N802
            if self.path.rstrip("/") == "/health":
                ready = model_ready()
                if ready is None:
                    try:
                        resolve_model_dir()
                    except RuntimeError as cause:
                        self.send_response(200)
                        self._cors()
                        body = json.dumps(
                            {"service": SERVICE_NAME, "status": "not-ready", "reason": str(cause)},
                            ensure_ascii=False,
                        ).encode("utf-8")
                        self.send_header("Content-Type", "application/json; charset=utf-8")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)
                        return
                self.send_response(200)
                self._cors()
                body = json.dumps(
                    {"service": SERVICE_NAME, "status": "ready", "model": ready}, ensure_ascii=False
                ).encode("utf-8")
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            self.send_response(404)
            self._cors()
            self.send_header("Content-Length", "0")
            self.end_headers()

        def do_POST(self) -> None:  # noqa: N802
            if self.path.rstrip("/") not in ("/v1/audio/transcriptions", "/audio/transcriptions"):
                self.send_response(404)
                self._cors()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length <= 0 or length > MAX_BYTES:
                self.send_response(413 if length > MAX_BYTES else 400)
                self._cors()
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            content_type = (self.headers.get("Content-Type") or "").lower()
            suffix = ".webm" if "webm" in content_type else ".ogg" if "ogg" in content_type else ".m4a"
            if suffix not in ALLOWED_EXT:
                suffix = ".webm"
            audio = self.rfile.read(length)
            language = (self.headers.get("X-VideoStudy-Language") or "").strip().lower() or None
            try:
                segments = transcribe(audio, suffix, language)
            except RuntimeError as cause:
                json_response(self, 503, {"error": "not-ready", "reason": str(cause)})
                return
            except Exception as cause:  # noqa: BLE001
                # 只回错误类型，不回音频或路径细节。
                json_response(self, 500, {"error": type(cause).__name__})
                return
            finally:
                del audio
            text = " ".join(item["text"] for item in segments).strip()
            json_response(self, 200, {"text": text, "segments": segments})

    return Handler


def main() -> int:
    host = os.environ.get("WHISPER_HOST", "127.0.0.1")
    port = int(os.environ.get("WHISPER_PORT", "8765"))
    if host not in ("127.0.0.1", "localhost", "::1"):
        print("只允许监听本机回环地址（127.0.0.1）。", file=sys.stderr)
        return 2
    ready = model_ready()
    if ready is None:
        try:
            resolve_model_dir()
        except RuntimeError as cause:
            print(f"[whisper] 启动后模型不可用：{cause}", file=sys.stderr)
    else:
        print(f"[whisper] 模型目录：{ready}", file=sys.stderr)
    from http.server import ThreadingHTTPServer

    server = ThreadingHTTPServer((host, port), build_handler())
    print(f"[whisper] 监听 http://{host}:{port}（仅本机）", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
