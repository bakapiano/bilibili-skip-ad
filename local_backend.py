"""Loopback-only llama.cpp inference; cloud credentials never enter requests."""

from __future__ import annotations

import copy
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

from deepseek_backend import build_request as build_baseline_request


ROOT = Path(__file__).resolve().parent
DEFAULT_BASE_URL = "http://127.0.0.1:8766/v1"
DEFAULT_MODEL = "qwen3-4b-local"
KEY_PATH = ROOT / ".runtime" / "local" / "api.key"


class LocalModelError(ValueError):
    def __init__(self, message: str, metadata: dict | None = None):
        super().__init__(message)
        self.metadata = metadata


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def endpoint(base_url: str) -> str:
    try:
        url = urllib.parse.urlsplit(base_url)
        if (url.scheme != "http" or url.hostname not in {"127.0.0.1", "::1", "localhost"}
                or url.username or url.password or url.query or url.fragment
                or url.path.rstrip("/") != "/v1" or not url.port or not 1 <= url.port <= 65535):
            raise ValueError
    except ValueError:
        raise LocalModelError("本地后端地址应为 http://127.0.0.1:<端口>/v1 等回环地址。") from None
    return base_url.rstrip("/") + "/chat/completions"


def build_local_request(transcript: dict, instructions: str, schema: dict, *,
                        model: str = DEFAULT_MODEL, thinking: str = "disabled", max_tokens: int = 2048) -> dict:
    if thinking != "disabled":
        raise LocalModelError("本地 Qwen 对照基线采用非思考模式；请使用 --thinking disabled。")
    # Reuse only prompt construction from the Flash baseline. This function
    # performs no network I/O and does not read any cloud API credentials.
    request = build_baseline_request(transcript, instructions, schema, max_tokens=max_tokens)
    request.pop("thinking")
    request["model"] = model
    constrained = copy.deepcopy(schema)
    for key in ("video_key", "transcript_sha256"):
        constrained["properties"][key] = {"type": "string", "const": transcript[key]}
    request.update({"response_format": {"type": "json_object", "schema": constrained},
                    "chat_template_kwargs": {"enable_thinking": False}, "reasoning_effort": "none",
                    "temperature": 0.7, "top_p": 0.8, "top_k": 20, "min_p": 0,
                    "presence_penalty": 1.5, "seed": 42, "cache_prompt": False})
    return request


def local_key() -> str:
    key = os.environ.get("LOCAL_LLM_API_KEY", "")
    if not key and KEY_PATH.is_file():
        key = KEY_PATH.read_text(encoding="ascii").strip()
    if not key or "\r" in key or "\n" in key:
        raise LocalModelError("请先运行 python local_model.py start，或为自有回环服务设置 LOCAL_LLM_API_KEY。")
    return key


def call_local(request: dict, base_url: str = DEFAULT_BASE_URL, timeout: int = 180) -> tuple[str, dict]:
    url = endpoint(base_url)
    key = local_key()
    if type(timeout) is not int or timeout <= 0:
        raise LocalModelError("本地调用 timeout 应为正整数。")
    data = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST", headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json"})
    started_at, started = datetime.now(timezone.utc), time.monotonic()
    # Bypass system HTTP proxies so even local auth headers remain on loopback.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        with opener.open(req, timeout=timeout) as response:
            body = response.read(8 * 1024 * 1024 + 1)
        if len(body) > 8 * 1024 * 1024:
            raise LocalModelError("本地模型响应超过 8 MiB。")
    except urllib.error.HTTPError as exc:
        raise LocalModelError(f"本地模型返回 HTTP {exc.code}；请检查 .runtime/local/server.log。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise LocalModelError("本地模型连接失败或超时；请运行 python local_model.py status 检查服务。") from None
    metadata = {"backend": "local-llama", "model": request["model"], "endpoint": url,
                "thinking": "disabled", "started_at": started_at.isoformat(),
                "elapsed_seconds": round(time.monotonic() - started, 3), "attempts": 1,
                "sampling": {key: request[key] for key in ("temperature", "top_p", "top_k", "min_p", "presence_penalty", "seed")},
                "cache_prompt_requested": request["cache_prompt"],
                "cost": {"api_charge_cny": "0", "basis": "local inference", "note": "运行成本来自本机电力与硬件使用。"}}
    try:
        payload = json.loads(body)
    except (json.JSONDecodeError, UnicodeError):
        raise LocalModelError("本地模型返回了异常 JSON。", metadata) from None
    if not isinstance(payload, dict):
        raise LocalModelError("本地模型响应结构异常。", metadata)
    metadata.update(response_id=payload.get("id"), returned_model=payload.get("model"),
                    usage=payload.get("usage"), timings=payload.get("timings"))
    usage = payload.get("usage")
    if (not isinstance(usage, dict) or any(type(usage.get(key)) is not int or usage[key] < 0
            for key in ("prompt_tokens", "completion_tokens", "total_tokens"))
            or usage["total_tokens"] != usage["prompt_tokens"] + usage["completion_tokens"]):
        raise LocalModelError("本地模型 token 用量格式异常。", metadata)
    choices = payload.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise LocalModelError("本地模型 choices 格式异常。", metadata)
    choice = choices[0]
    metadata["finish_reason"] = choice.get("finish_reason")
    message = choice.get("message") or {}
    if (choice.get("finish_reason") != "stop" or not isinstance(message, dict) or message.get("tool_calls")
            or not isinstance(message.get("content"), str) or not message["content"].strip()):
        raise LocalModelError("本地模型本轮输出尚未完整结束；请检查 local-usage.json。", metadata)
    return message["content"], metadata
