"""Bilibili captions -> local Qwen / DeepSeek API / Codex -> skip userscript.

Python 3.11+; standard library only. All generated artifacts stay local.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import tomllib
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from deepseek_backend import DeepSeekError, build_request, call_deepseek
from local_backend import LocalModelError, build_local_request, call_local, DEFAULT_BASE_URL, DEFAULT_MODEL


ROOT = Path(__file__).resolve().parent
MAX_DOWNLOAD = 8 * 1024 * 1024
BV_PATTERN = re.compile(r"BV[0-9A-Za-z]{10}")


class PocError(ValueError):
    pass


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def read_json(path: Path) -> object:
    if path.stat().st_size > MAX_DOWNLOAD:
        raise PocError("输入文件超过 8 MiB；请先按带重叠上下文的窗口分段。")
    return json.loads(path.read_text(encoding="utf-8-sig"))


def video_ref(value: str, page: int | None = None) -> tuple[str, int]:
    if BV_PATTERN.fullmatch(value):
        bvid, url_page = value, 1
    else:
        parsed = urllib.parse.urlsplit(value)
        if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"www.bilibili.com", "bilibili.com"}:
            raise PocError("请输入 BV 号或 bilibili.com/video/ 链接。")
        match = re.fullmatch(r"/video/(BV[0-9A-Za-z]{10})/?", parsed.path)
        if not match:
            raise PocError("请输入标准 BV 视频链接。")
        bvid = match.group(1)
        try:
            url_page = int(urllib.parse.parse_qs(parsed.query).get("p", ["1"])[0])
        except ValueError as exc:
            raise PocError("分 P 参数必须为正整数。") from exc
    selected = page if page is not None else url_page
    if selected < 1:
        raise PocError("分 P 参数必须为正整数。")
    return bvid, selected


# Public player URL-obfuscation constants, observed in core.ba67b466.js on
# 2026-09-28. This resolves public caption addresses; the original auth_key
# remains unchanged. A format change fails closed and permits JSON import.
SUBTITLE_FORMATS = (
    ('nP](wOFRvU.+<fjS{jn-!$D|Dz&",zT`', "=CFxYRn{.y|uVyO$uh&sikph?N.ilF/`"),
    ('Bn"q~|albg@]Go~ACgyDvKnd+)_D}^&J?', "Cu~L!xs~f^&r@'vh=q]q{eeng*sEg^kp#J"),
)


def resolve_subtitle_url(url: str) -> str:
    url = "https:" + url if url.startswith("//") else url
    parsed = urllib.parse.urlsplit(url)
    if parsed.hostname != "subtitle.bilibili.com":
        return url
    encoded = urllib.parse.unquote(parsed.path.lstrip("/"), errors="strict")
    for prefix, seed in SUBTITLE_FORMATS:
        key = seed + "bilibili"
        decoded = "".join(chr(ord(char) ^ ord(key[i % len(key)])) for i, char in enumerate(encoded))
        if decoded.startswith(prefix):
            path = decoded[len(prefix):]
            if not re.fullmatch(r"/bfs/[A-Za-z0-9_./-]+", path):
                raise PocError("字幕地址解码后路径异常。")
            return urllib.parse.urlunsplit(("https", "aisubtitle.hdslb.com", path, parsed.query, ""))
    raise PocError("字幕地址格式已变化；请用 --subtitle-json 导入播放器导出的字幕。")


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def fetch_bytes(url: str) -> bytes:
    # Only caption/API hosts, including after redirects. Cookies are sent only
    # to the Bilibili API and are never logged or embedded in generated files.
    opener = urllib.request.build_opener(NoRedirect())
    for _ in range(4):
        parsed = urllib.parse.urlsplit(url)
        host = parsed.hostname or ""
        if (parsed.scheme != "https" or parsed.username or parsed.password or parsed.port not in {None, 443}
                or not (host == "api.bilibili.com" or host.endswith(".hdslb.com"))):
            raise PocError("获取字幕时仅允许 HTTPS B站 API 和 hdslb.com 字幕资源。")
        headers = {"User-Agent": "Mozilla/5.0", "Referer": "https://www.bilibili.com/"}
        sessdata = os.environ.get("BILIBILI_SESSDATA", "")
        if host == "api.bilibili.com" and sessdata:
            if any(char in sessdata for char in "\r\n;"):
                raise PocError("BILIBILI_SESSDATA 应仅包含该 Cookie 的值。")
            headers["Cookie"] = "SESSDATA=" + sessdata
        try:
            with opener.open(urllib.request.Request(url, headers=headers), timeout=25) as response:
                data = response.read(MAX_DOWNLOAD + 1)
            if len(data) > MAX_DOWNLOAD:
                raise PocError("字幕响应超过 8 MiB。")
            return data
        except urllib.error.HTTPError as exc:
            if exc.code in {301, 302, 303, 307, 308} and exc.headers.get("Location"):
                url = urllib.parse.urljoin(url, exc.headers["Location"])
                continue
            raise PocError(f"{host} 返回 HTTP {exc.code}；请检查访问状态或导入字幕 JSON。") from None
        except (urllib.error.URLError, TimeoutError, OSError):
            raise PocError(f"{host} 请求失败；请检查网络或导入字幕 JSON。") from None
    raise PocError("字幕请求重定向次数过多。")


def api_data(path: str, **params) -> dict:
    result = json.loads(fetch_bytes("https://api.bilibili.com" + path + "?" + urllib.parse.urlencode(params)))
    if result.get("code") != 0:
        raise PocError(f"B站 API 返回 code={result.get('code')}；请检查登录状态或稍后重试。")
    return result.get("data") or {}


def varint(data: bytes, position: int) -> tuple[int, int]:
    value = 0
    for shift in range(0, 70, 7):
        if position >= len(data):
            raise PocError("Protobuf varint 被截断。")
        byte = data[position]
        position += 1
        if shift == 63 and byte > 1:
            raise PocError("Protobuf varint 溢出。")
        value |= (byte & 127) << shift
        if byte < 128:
            return value, position
    raise PocError("Protobuf varint 长度异常。")


def protobuf_fields(data: bytes):
    position = 0
    while position < len(data):
        tag, position = varint(data, position)
        number, wire = tag >> 3, tag & 7
        if number == 0:
            raise PocError("Protobuf 字段编号异常。")
        if wire == 0:
            value, position = varint(data, position)
        elif wire in {1, 2, 5}:
            if wire == 2:
                size, position = varint(data, position)
            else:
                size = 8 if wire == 1 else 4
            if size > len(data) - position:
                raise PocError("Protobuf 字段被截断。")
            value = data[position:position + size]
            position += size
        else:
            raise PocError("Protobuf 出现未知 wire type。")
        yield number, wire, value


def subtitle_tracks(data: bytes) -> list[dict]:
    if data.lstrip().startswith(b"{"):
        result = json.loads(data)
        raise PocError(f"字幕接口返回 code={result.get('code')}。")
    tracks = []
    outer = list(protobuf_fields(data))
    # SubtitleViewReply.subtitle is field 1; VideoSubtitle.subtitles is field 3.
    envelopes = [value for number, wire, value in outer if number == 1 and wire == 2]
    for envelope in envelopes:
        for number, wire, raw in protobuf_fields(envelope):
            if number != 3 or wire != 2:
                continue
            fields = {key: value for key, kind, value in protobuf_fields(raw) if kind == 2}
            if 5 in fields:
                tracks.append({"lan": fields.get(3, b"").decode("utf-8"),
                               "lan_doc": fields.get(4, b"").decode("utf-8"),
                               "subtitle_url": fields[5].decode("utf-8")})
    return tracks


def number(value, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value):
        raise PocError(f"{name} 必须为有限数值。")
    return float(value)


def normalize(video: dict, body: list, source: str = "imported") -> dict:
    if not BV_PATTERN.fullmatch(str(video.get("bvid", ""))):
        raise PocError("视频 BV 号异常。")
    for name in ("page", "cid"):
        if type(video.get(name)) is not int or video[name] < 1:
            raise PocError(f"视频 {name} 异常。")
    duration = number(video.get("duration"), "视频时长")
    if duration <= 0 or not isinstance(body, list) or not body:
        raise PocError("需要正数视频时长与非空字幕。")
    cues, previous = [], -1.0
    for index, cue in enumerate(body, 1):
        if not isinstance(cue, dict):
            raise PocError(f"第 {index} 条字幕应为对象。")
        start, end = number(cue.get("from"), "字幕起点"), number(cue.get("to"), "字幕终点")
        text = cue.get("content")
        if not (0 <= start < min(end, duration) and end <= duration + 1.0) or start < previous:
            raise PocError(f"第 {index} 条字幕时间轴异常。")
        if not isinstance(text, str) or not text.strip() or len(text) > 10000:
            raise PocError(f"第 {index} 条字幕文本异常。")
        start, end = round(start, 3), round(min(end, duration), 3)
        if start >= end:
            raise PocError(f"第 {index} 条字幕精度不足以生成有效区间。")
        cues.append({"id": index, "from": start, "to": end, "content": text.strip()})
        previous = start
    video = {**video, "duration": duration}
    key = f"{video['bvid']}:p{video['page']}:{video['cid']}"
    payload = json.dumps({"video": video, "cues": cues}, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return {"version": 1, "video_key": key, "video": video, "source": source,
            "transcript_sha256": hashlib.sha256(payload.encode("utf-8")).hexdigest(), "cues": cues}


def load_transcript(path: Path) -> dict:
    raw = read_json(path)
    if not isinstance(raw, dict) or raw.get("version") != 1:
        raise PocError("请先用 fetch 命令生成标准字幕文件。")
    rebuilt = normalize(raw["video"], raw["cues"], raw.get("source", "imported"))
    if rebuilt["transcript_sha256"] != raw.get("transcript_sha256") or rebuilt["video_key"] != raw.get("video_key"):
        raise PocError("字幕校验和发生变化；请重新准备输入。")
    if any(cue.get("id") != index for index, cue in enumerate(raw["cues"], 1)):
        raise PocError("字幕 ID 必须连续且从 1 开始。")
    return rebuilt


def fetch_transcript(ref: str, page: int | None = None, imported: Path | None = None) -> dict:
    bvid, selected_page = video_ref(ref, page)
    meta = api_data("/x/web-interface/view", bvid=bvid)
    pages = meta.get("pages") or []
    if selected_page > len(pages):
        raise PocError(f"该视频共有 {len(pages)} P。")
    part = pages[selected_page - 1]
    video = {"bvid": bvid, "cid": part["cid"], "page": selected_page,
             "title": meta["title"], "part": part.get("part", ""), "duration": part["duration"]}
    if imported:
        raw = read_json(imported)
        return normalize(video, raw.get("body", []) if isinstance(raw, dict) else raw, "imported-bilibili-subtitle")
    tracks = []
    try:
        tracks = api_data("/x/player/wbi/v2", bvid=bvid, cid=part["cid"]).get("subtitle", {}).get("subtitles", [])
    except PocError:
        pass  # The independently versioned Protobuf endpoint is the fallback.
    if not tracks:
        query = urllib.parse.urlencode({"oid": part["cid"], "pid": meta["aid"], "type": 1,
                                       "context_ext": '{"video_type":1}', "cur_production_type": 0,
                                       "preferred_language": "ai-zh"})
        tracks = subtitle_tracks(fetch_bytes("https://api.bilibili.com/x/v2/subtitle/web/view?" + query))
    chinese = [track for track in tracks if "zh" in track.get("lan", "").lower()]
    if not chinese:
        raise PocError("当前接口未取得中文字幕；可设置 BILIBILI_SESSDATA，或用 --subtitle-json 导入带时间戳字幕。")
    track = min(chinese, key=lambda item: item.get("lan", "").startswith("ai-"))
    subtitles = json.loads(fetch_bytes(resolve_subtitle_url(track["subtitle_url"])))
    return normalize(video, subtitles.get("body", []), "bilibili:" + track["lan"])


def make_prompt(transcript: dict) -> str:
    data = {name: transcript[name] for name in ("video_key", "transcript_sha256", "video", "cues")}
    prompt = (ROOT / "prompt.md").read_text(encoding="utf-8") + "\n" + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    if len(prompt) > 120000:
        raise PocError("本 PoC 单次输入上限为 12 万字符；长视频请先分段并保留相邻上下文。")
    return prompt


def parse_labels(text: str) -> dict:
    cleaned = text.strip().removeprefix("\ufeff")
    # Some configured providers ignore strict structured output and retain a
    # personal sign-off. Accept only this known harmless suffix; validate the
    # complete object, bindings and all fields below.
    if cleaned.endswith("喵！"):
        cleaned = cleaned[:-2].rstrip()
    if cleaned.startswith("```json\n") and cleaned.endswith("```"):
        cleaned = cleaned[8:-3].strip()
    result = json.loads(cleaned)
    if not isinstance(result, dict):
        raise PocError("模型输出应为 JSON 对象。")
    return result


def validate_labels(transcript: dict, labels: dict) -> dict:
    if set(labels) != {"video_key", "transcript_sha256", "summary", "segments"}:
        raise PocError("模型输出字段与 Schema 不一致。")
    for name in ("video_key", "transcript_sha256"):
        if labels[name] != transcript[name]:
            raise PocError("标注与当前视频/字幕校验和不匹配。")
    if not isinstance(labels["summary"], str) or not isinstance(labels["segments"], list):
        raise PocError("模型输出 summary/segments 类型异常。")
    cues, output, previous_end = transcript["cues"], [], 0.0
    for segment in labels["segments"]:
        if not isinstance(segment, dict) or set(segment) != {"start_id", "end_id", "brand", "confidence", "reason", "evidence_ids"}:
            raise PocError("广告段字段与 Schema 不一致。")
        first, last = segment["start_id"], segment["end_id"]
        if type(first) is not int or type(last) is not int or not (1 <= first <= last <= len(cues)):
            raise PocError("模型返回了越界或倒置的字幕 ID。")
        evidence = segment["evidence_ids"]
        if not isinstance(evidence, list) or not evidence or any(type(i) is not int or not first <= i <= last for i in evidence):
            raise PocError("广告证据必须来自该广告区间内的字幕。")
        score = number(segment["confidence"], "confidence")
        if not 0 <= score <= 1 or any(not isinstance(segment[name], str) or not segment[name].strip() for name in ("brand", "reason")):
            raise PocError("广告评分、品牌或理由异常。")
        start, end = cues[first - 1]["from"], max(cue["to"] for cue in cues[first - 1:last])
        if start < previous_end:
            raise PocError("广告区间重叠或顺序异常。")
        previous_end = end
        output.append({**segment, "start": start, "end": end,
                       "evidence": [cues[i - 1] for i in dict.fromkeys(evidence)]})
    return {"version": 1, "video_key": transcript["video_key"], "video": transcript["video"],
            "transcript_sha256": transcript["transcript_sha256"], "summary": labels["summary"],
            "auto_threshold": 0.9, "segments": output}


def configured_mcp_disables() -> list[str]:
    config = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex"))) / "config.toml"
    if not config.is_file():
        return []
    # Read names only into command-line overrides, preserving configured model
    # provider/auth settings without copying or logging credentials.
    parsed = tomllib.loads(config.read_text(encoding="utf-8-sig"))
    result = []
    for name in parsed.get("mcp_servers", {}):
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            raise PocError("MCP 配置名包含特殊字符；请先通过 prepare 导出输入，在 Codex 会话内标注。")
        result += ["-c", f"mcp_servers.{name}.enabled=false"]
    return result


def codex_command() -> list[str]:
    executable = shutil.which("codex.cmd" if os.name == "nt" else "codex")
    if not executable:
        raise PocError("请安装 Codex CLI，或把 prepare 生成的 prompt.txt 交给当前 Codex 会话，再用 render 导入结果。")
    if os.name == "nt" and executable.lower().endswith(".cmd"):
        # Invoke npm's JS launcher directly: cmd.exe otherwise reinterprets
        # quoting in -c overrides and in paths containing shell metacharacters.
        launcher = Path(executable).parent / "node_modules" / "@openai" / "codex" / "bin" / "codex.js"
        node = shutil.which("node")
        if not node or not launcher.is_file():
            raise PocError("请使用 npm 安装的 Codex CLI，以便通过 Node 安全调用 Windows 启动器。")
        return [node, str(launcher)]
    return [executable]


def call_codex(prompt: str, model: str | None, timeout: int) -> tuple[dict, dict]:
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="biliskip-codex-") as work:
        output = Path(work) / "labels.json"
        command = codex_command() + ["exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
                   "--color", "never", "--json", "--output-schema", str(ROOT / "labels.schema.json"),
                   "--output-last-message", str(output), "-c", "features.shell_tool=false",
                   "-c", "features.multi_agent=false", "-c", 'web_search="disabled"'] + configured_mcp_disables()
        if model:
            command += ["--model", model]
        command += ["-"]
        options = {"creationflags": subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True}
        process = subprocess.Popen(command, cwd=work, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                   stderr=subprocess.PIPE, encoding="utf-8", errors="replace", **options)
        try:
            stdout, _stderr = process.communicate(prompt, timeout=timeout)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.communicate(timeout=15)
            raise PocError(f"Codex 分类超过 {timeout} 秒；已停止本次子进程。") from None
        usage = {}
        for line in stdout.splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "turn.completed":
                usage = event.get("usage", {})
        if process.returncode or not output.is_file():
            raise PocError(f"Codex 调用失败（退出码 {process.returncode}）。请检查当前 CLI 的模型服务与认证配置；prepare 可导出手动标注输入。")
        return parse_labels(output.read_text(encoding="utf-8-sig")), {
            "backend": "codex-cli", "model": model or "configured-default", "elapsed_seconds": round(time.monotonic() - started, 3), "usage": usage}


def stamp(seconds: float) -> str:
    return f"{int(seconds // 60):02d}:{seconds % 60:06.3f}"


def export(transcript: dict, labels: dict, folder: Path, detector: dict) -> dict:
    result = validate_labels(transcript, labels)
    result["detector"] = detector
    folder.mkdir(parents=True, exist_ok=True)
    write_json(folder / "labels.json", labels)
    write_json(folder / "segments.json", result)
    # JSON is assigned as a JS value, never HTML; the template uses textContent.
    javascript = (ROOT / "skip.template.js").read_text(encoding="utf-8").replace(
        "__BILISKIP_DATA__", json.dumps(result, ensure_ascii=True))
    (folder / "skip.user.js").write_text(javascript, encoding="utf-8")
    review = ["# 广告标注预览", "", transcript["video"]["title"], "", labels["summary"], "",
              f"视频绑定：`{transcript['video_key']}`", "", "评分为模型自评；边界由字幕时间戳映射。", ""]
    if detector.get("backend") == "deepseek-api":
        usage, cost = detector["usage_normalized"], detector["cost"]
        review += [f"模型：`{detector['model']}`；思考模式：`{detector['thinking']}`；耗时 {detector['elapsed_seconds']} 秒。", "",
                   f"输入 {usage['prompt_tokens']} token（缓存命中 {usage['prompt_cache_hit_tokens']}、未命中 {usage['prompt_cache_miss_tokens']}）；输出 {usage['completion_tokens']} token。", "",
                   f"按 {cost['pricing_as_of']} 价格估算：空闲时段 ¥{cost['estimated_cny']['off_peak']}；高峰时段 ¥{cost['estimated_cny']['peak']}。", "",
                   f"本次时段提示：`{detector['billing_period_hint']}`。费用以官方账单为准。", ""]
    elif detector.get("backend") == "local-llama":
        usage = detector.get("usage") or {}
        review += [f"本地模型：`{detector['model']}`；耗时 {detector['elapsed_seconds']} 秒。", "",
                   f"输入 {usage.get('prompt_tokens', '未知')} token；输出 {usage.get('completion_tokens', '未知')} token。", "",
                   "模型在本机推理。运行成本来自电力与硬件使用。", ""]
    for segment in result["segments"]:
        review += [f"## {stamp(segment['start'])} → {stamp(segment['end'])} · {segment['brand']}", "",
                   f"字幕 {segment['start_id']}–{segment['end_id']}；评分 {segment['confidence']:.2f}。", "", segment["reason"], ""]
        review += [f"- [{cue['id']}] {stamp(cue['from'])} {cue['content']}" for cue in segment["evidence"]]
        review.append("")
    (folder / "review.md").write_text("\n".join(review), encoding="utf-8")
    return result


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("fetch", "run"):
        command = sub.add_parser(name)
        command.add_argument("video")
        command.add_argument("--page", type=int)
        command.add_argument("--subtitle-json", type=Path, help="导入原始 B站 JSON 或带 from/to/content 的数组")
        command.add_argument("--out-dir", type=Path)
    for name in ("prepare", "detect", "render"):
        command = sub.add_parser(name)
        command.add_argument("transcript", type=Path)
        command.add_argument("--out-dir", type=Path)
        if name == "render":
            command.add_argument("labels", type=Path)
    for name in ("run", "detect"):
        sub.choices[name].add_argument("--provider", choices=("codex", "deepseek", "local"), default="codex")
        sub.choices[name].add_argument("--model", help="DeepSeek 默认为 deepseek-flash；local 默认 qwen3-4b-local；Codex 沿用本机配置")
        sub.choices[name].add_argument("--local-base-url", default=DEFAULT_BASE_URL, help="本地回环模型服务地址")
        sub.choices[name].add_argument("--timeout", type=int, default=180)
        sub.choices[name].add_argument("--thinking", choices=("disabled", "enabled"), default="disabled", help="DeepSeek 思考模式")
        sub.choices[name].add_argument("--max-output-tokens", type=int, default=2048, help="DeepSeek 单次输出上限（含思考 token）")
    args = parser.parse_args(argv)
    try:
        if args.command in {"fetch", "run"}:
            transcript = fetch_transcript(args.video, args.page, args.subtitle_json)
        else:
            transcript = load_transcript(args.transcript)
        video = transcript["video"]
        suffix = {"deepseek": "-deepseek-flash", "local": "-local-qwen3-4b"}.get(getattr(args, "provider", None), "")
        folder = args.out_dir or ROOT / "runs" / f"{video['bvid']}-p{video['page']}{suffix}"
        folder.mkdir(parents=True, exist_ok=True)
        write_json(folder / "transcript.json", transcript)
        (folder / "prompt.txt").write_text(make_prompt(transcript), encoding="utf-8")
        if args.command in {"run", "detect"}:
            if args.timeout < 1:
                raise PocError("timeout 必须大于零。")
            if args.provider == "local":
                request = build_local_request(transcript, (ROOT / "prompt.md").read_text(encoding="utf-8"),
                                              read_json(ROOT / "labels.schema.json"), model=args.model or DEFAULT_MODEL,
                                              thinking=args.thinking, max_tokens=args.max_output_tokens)
                write_json(folder / "local-request.json", request)
                print(f"正在用本机 {request['model']} 分类 {len(transcript['cues'])} 条字幕…", flush=True)
                try:
                    content, detector = call_local(request, args.local_base_url, args.timeout)
                except LocalModelError as exc:
                    if exc.metadata:
                        write_json(folder / "local-usage.json", exc.metadata)
                    raise
                write_json(folder / "local-usage.json", detector)
                # Keep the final answer for local troubleshooting; the server's
                # separate reasoning field is deliberately excluded.
                (folder / "local-answer.txt").write_text(content, encoding="utf-8")
                labels = parse_labels(content)
            elif args.provider == "deepseek":
                request = build_request(transcript, (ROOT / "prompt.md").read_text(encoding="utf-8"),
                                        read_json(ROOT / "labels.schema.json"), model=args.model or "deepseek-flash",
                                        thinking=args.thinking, max_tokens=args.max_output_tokens)
                write_json(folder / "api-request.json", request)
                print(f"正在直接调用 deepseek-flash 分类 {len(transcript['cues'])} 条字幕…", flush=True)
                try:
                    content, detector = call_deepseek(request, read_json(ROOT / "deepseek-pricing.json"), args.timeout)
                except DeepSeekError as exc:
                    if exc.metadata:
                        write_json(folder / "api-usage.json", exc.metadata)
                    raise
                # Preserve chargeable usage even if the generated JSON fails
                # parsing or cue validation. Requests are never auto-retried.
                write_json(folder / "api-usage.json", detector)
                labels = parse_labels(content)
            else:
                print(f"正在通过本机 Codex 分类 {len(transcript['cues'])} 条字幕…", flush=True)
                labels, detector = call_codex(make_prompt(transcript), args.model, args.timeout)
            result = export(transcript, labels, folder, detector)
        elif args.command == "render":
            result = export(transcript, parse_labels(args.labels.read_text(encoding="utf-8-sig")), folder,
                            {"backend": "imported-labels"})
        else:
            print(f"已准备 {len(transcript['cues'])} 条字幕：{folder / 'transcript.json'}")
            return 0
        print(f"已生成 {len(result['segments'])} 个广告区间：{folder / 'review.md'}")
        for segment in result["segments"]:
            print(f"  {stamp(segment['start'])} -> {stamp(segment['end'])}  {segment['brand']}  score={segment['confidence']}")
        print(f"油猴脚本：{folder / 'skip.user.js'}")
        if result.get("detector", {}).get("backend") == "deepseek-api":
            detector = result["detector"]
            usage, cost = detector["usage_normalized"], detector["cost"]
            print(f"耗时 {detector['elapsed_seconds']} 秒；输入 {usage['prompt_tokens']} / 输出 {usage['completion_tokens']} token")
            print(f"费用估算（CNY，{cost['pricing_as_of']} 价格）：空闲 ¥{cost['estimated_cny']['off_peak']} / 高峰 ¥{cost['estimated_cny']['peak']}")
        elif result.get("detector", {}).get("backend") == "local-llama":
            detector = result["detector"]
            print(f"本地推理耗时 {detector['elapsed_seconds']} 秒；用量 {detector['usage']}")
        return 0
    except (PocError, DeepSeekError, LocalModelError, json.JSONDecodeError, OSError, KeyError, TypeError, UnicodeError, tomllib.TOMLDecodeError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    # Keep Chinese diagnostics readable through Windows terminal pipes.
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
