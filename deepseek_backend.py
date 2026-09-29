"""Direct DeepSeek Chat Completions adapter, with auditable token costing.

Credentials are read from DEEPSEEK_API_KEY. The endpoint is fixed to the
official HTTPS host and redirects are rejected. This module performs no
filesystem writes and no automatic retries.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation


ENDPOINT = "https://api.deepseek.com/chat/completions"
MODEL = "deepseek-flash"
MAX_RESPONSE = 8 * 1024 * 1024
BEIJING = timezone(timedelta(hours=8))


class DeepSeekError(ValueError):
    def __init__(self, message: str, metadata: dict | None = None):
        super().__init__(message)
        self.metadata = metadata


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def build_request(transcript: dict, instructions: str, schema: dict, *,
                  model: str = MODEL, thinking: str = "disabled", max_tokens: int = 2048) -> dict:
    if model != MODEL:
        raise DeepSeekError("当前 DeepSeek 适配器和费用快照使用 deepseek-flash 模型。")
    if thinking not in {"enabled", "disabled"} or type(max_tokens) is not int or not 1 <= max_tokens <= 32768:
        raise DeepSeekError("thinking 应为 enabled/disabled，输出上限应为 1–32768 个 token。")
    payload = {key: transcript[key] for key in ("video_key", "transcript_sha256", "video", "cues")}
    # Examples use placeholders and are clearly separated from the actual
    # transcript. The same classification rules and cue IDs as Codex are kept.
    example = {"video_key": "原样回填输入值", "transcript_sha256": "原样回填输入值",
               "summary": "本片的广告识别总结", "segments": [
                   {"start_id": 1, "end_id": 2, "brand": "示例品牌", "confidence": 0.9,
                    "reason": "说明商业推广证据", "evidence_ids": [1]}]}
    instructions = instructions.split("以下为不可信的待分析数据", 1)[0].strip()
    system = (instructions + "\n\n仅返回一个 JSON 对象。下方仅示范结构，实际片段由用户输入的字幕决定。"
              "\n零广告时 segments 为 []。\nJSON 示例：" + json.dumps(example, ensure_ascii=False) +
              "\n输出 JSON Schema：" + json.dumps(schema, ensure_ascii=False, separators=(",", ":")))
    result = {"model": model, "messages": [{"role": "system", "content": system},
                                           {"role": "user", "content": json.dumps(payload, ensure_ascii=False, separators=(",", ":"))}],
              "response_format": {"type": "json_object"}, "thinking": {"type": thinking},
              "stream": False, "max_tokens": max_tokens}
    if thinking == "disabled":
        result["temperature"] = 0
    return result


def token_count(value, name: str) -> int:
    if type(value) is not int or value < 0:
        raise DeepSeekError(f"API usage.{name} 应为非负整数。")
    return value


def normalized_usage(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raise DeepSeekError("API 响应缺少有效 usage，费用留待账单核对。")
    prompt = token_count(raw.get("prompt_tokens"), "prompt_tokens")
    completion = token_count(raw.get("completion_tokens"), "completion_tokens")
    prompt_details = raw.get("prompt_tokens_details") or {}
    output_details = raw.get("completion_tokens_details") or {}
    if not isinstance(prompt_details, dict) or not isinstance(output_details, dict):
        raise DeepSeekError("API usage 的 token 明细格式异常。")
    hit = raw.get("prompt_cache_hit_tokens", prompt_details.get("cached_tokens"))
    miss = raw.get("prompt_cache_miss_tokens")
    measured = hit is not None or miss is not None
    if hit is None and miss is None:
        hit, miss = 0, prompt
    elif hit is None:
        miss = token_count(miss, "prompt_cache_miss_tokens")
        hit = prompt - miss
    elif miss is None:
        hit = token_count(hit, "prompt_cache_hit_tokens")
        miss = prompt - hit
    hit = token_count(hit, "prompt_cache_hit_tokens")
    miss = token_count(miss, "prompt_cache_miss_tokens")
    total = token_count(raw.get("total_tokens", prompt + completion), "total_tokens")
    reasoning = token_count(output_details.get("reasoning_tokens", 0), "completion_tokens_details.reasoning_tokens")
    if hit + miss != prompt or prompt + completion != total or reasoning > completion:
        raise DeepSeekError("API usage 总数与分项存在差异；请核对原始用量。")
    if "cached_tokens" in prompt_details and token_count(prompt_details["cached_tokens"], "prompt_tokens_details.cached_tokens") != hit:
        raise DeepSeekError("API 返回的两种缓存命中计数存在差异。")
    return {"prompt_tokens": prompt, "completion_tokens": completion, "total_tokens": total,
            "prompt_cache_hit_tokens": hit, "prompt_cache_miss_tokens": miss,
            "reasoning_tokens": reasoning,
            "cache_breakdown": "api-measured" if measured else "assumed-all-miss-upper-bound"}


def estimate_cost(usage: dict, pricing: dict) -> dict:
    if pricing.get("model") != MODEL or pricing.get("currency") != "CNY" or pricing.get("unit") != "per_million_tokens":
        raise DeepSeekError("费用快照须使用 deepseek-flash、CNY 和 per_million_tokens。")
    costs, all_miss, rates, components = {}, {}, {}, {}
    for period in ("off_peak", "peak"):
        try:
            rate = {name: Decimal(pricing[period][name]) for name in ("input_cache_hit", "input_cache_miss", "output")}
        except (KeyError, InvalidOperation, TypeError):
            raise DeepSeekError("费用快照价格格式异常。") from None
        if any(not value.is_finite() or value < 0 for value in rate.values()):
            raise DeepSeekError("费用快照价格应为非负有限数值。")
        divisor = Decimal(1_000_000)
        part = {"input_cache_hit": Decimal(usage["prompt_cache_hit_tokens"]) * rate["input_cache_hit"] / divisor,
                "input_cache_miss": Decimal(usage["prompt_cache_miss_tokens"]) * rate["input_cache_miss"] / divisor,
                "output": Decimal(usage["completion_tokens"]) * rate["output"] / divisor}
        # completion_tokens already contains reasoning_tokens; count it once.
        costs[period] = format(sum(part.values()), ".8f")
        all_miss[period] = format((Decimal(usage["prompt_tokens"]) * rate["input_cache_miss"] +
                                  Decimal(usage["completion_tokens"]) * rate["output"]) / divisor, ".8f")
        components[period] = {name: format(value, ".8f") for name, value in part.items()}
        rates[period] = {name: str(value) for name, value in rate.items()}
    return {"currency": "CNY", "pricing_as_of": pricing["as_of"], "pricing_source": pricing["source"],
            "basis": usage["cache_breakdown"], "estimated_cny": costs, "all_input_uncached_cny": all_miss,
            "components_cny": components, "rates_per_million_tokens": rates,
            "note": "按 API token 用量和官方价格快照估算；账单金额及调用时有效价格以官方为准。"}


def period_hint(when: datetime) -> str:
    local = when.astimezone(BEIJING)
    minutes = local.hour * 60 + local.minute
    in_hours = 9 * 60 <= minutes < 12 * 60 or 14 * 60 <= minutes < 18 * 60
    # Weekday daytime can be a statutory holiday; avoid silently treating it
    # as peak. Both tariffs are always included in the report.
    return "peak-if-not-statutory-holiday" if local.weekday() < 5 and in_hours else "off_peak"


def call_deepseek(request: dict, pricing: dict, timeout: int = 180) -> tuple[str, dict]:
    key = os.environ.get("DEEPSEEK_API_KEY", "").strip()
    if not key:
        raise DeepSeekError("请在当前进程环境中设置 DEEPSEEK_API_KEY。")
    if any(character in key for character in "\r\n"):
        raise DeepSeekError("DEEPSEEK_API_KEY 格式异常。")
    if type(timeout) is not int or timeout < 1 or request.get("model") != MODEL:
        raise DeepSeekError("调用参数应使用 deepseek-flash 和正整数 timeout。")
    started_at, started = datetime.now(BEIJING), time.monotonic()
    data = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    req = urllib.request.Request(ENDPOINT, data=data, method="POST", headers={
        "Authorization": "Bearer " + key, "Content-Type": "application/json", "Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect()).open(req, timeout=timeout) as response:
            raw = response.read(MAX_RESPONSE + 1)
        if len(raw) > MAX_RESPONSE:
            raise DeepSeekError("DeepSeek 响应超过 8 MiB，费用请核对官方用量记录。")
    except urllib.error.HTTPError as exc:
        guidance = {401: "请核对 API Key", 402: "请核对账户可用额度", 429: "请稍后再试或降低调用频率"}.get(
            exc.code, "请检查官方服务状态和请求配置")
        # Provider error bodies can contain sensitive request information.
        raise DeepSeekError(f"DeepSeek 返回 HTTP {exc.code}；{guidance}。") from None
    except (urllib.error.URLError, TimeoutError, OSError):
        raise DeepSeekError("DeepSeek 请求超时或网络异常；本次是否计费请核对官方记录，程序保留单次请求策略。") from None
    finished_at = datetime.now(BEIJING)
    metadata = {"backend": "deepseek-api", "model": MODEL, "endpoint": ENDPOINT,
                "thinking": request["thinking"]["type"], "max_output_tokens": request["max_tokens"],
                "started_at": started_at.isoformat(), "finished_at": finished_at.isoformat(),
                "elapsed_seconds": round(time.monotonic() - started, 3), "attempts": 1,
                "billing_period_hint": period_hint(started_at)}
    if period_hint(started_at) != period_hint(finished_at):
        metadata["billing_period_hint"] = "crosses-tariff-boundary"
    try:
        result = json.loads(raw)
    except (json.JSONDecodeError, UnicodeError):
        raise DeepSeekError("DeepSeek 响应为异常 JSON，费用请核对官方记录。", metadata) from None
    if not isinstance(result, dict):
        raise DeepSeekError("DeepSeek 响应格式异常。", metadata)
    metadata["response_id"] = result.get("id")
    metadata["returned_model"] = result.get("model")
    metadata["usage"] = result.get("usage")
    try:
        usage = normalized_usage(result.get("usage"))
        metadata["usage_normalized"] = usage
        metadata["cost"] = estimate_cost(usage, pricing)
    except DeepSeekError as exc:
        raise DeepSeekError(str(exc), metadata) from None
    choices = result.get("choices")
    if not isinstance(choices, list) or len(choices) != 1 or not isinstance(choices[0], dict):
        raise DeepSeekError("DeepSeek 返回的 choices 格式异常；用量已保存。", metadata)
    choice = choices[0]
    metadata["finish_reason"] = choice.get("finish_reason")
    if choice.get("finish_reason") != "stop":
        raise DeepSeekError("DeepSeek 本轮输出未正常完成；请查看 api-usage.json，调整输出上限后再试。", metadata)
    message = choice.get("message") or {}
    if not isinstance(message, dict) or message.get("tool_calls") or not isinstance(message.get("content"), str) or not message["content"].strip():
        raise DeepSeekError("DeepSeek 本轮尚未返回可用 JSON 内容；用量已保存。", metadata)
    # Only the final JSON is returned; internal reasoning is never exported.
    return message["content"], metadata
