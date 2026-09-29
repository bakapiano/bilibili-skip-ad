"""Portable, project-local Qwen3/llama.cpp runtime for Windows NVIDIA GPUs."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import secrets
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
import zipfile
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "local-model.json"
STATE_DIR = ROOT / ".runtime" / "local"
STATE_PATH = STATE_DIR / "server-state.json"
KEY_PATH = STATE_DIR / "api.key"
RUNTIME = ROOT / ".runtime" / "llama-b11146"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def config() -> dict:
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def inside_root(path: Path) -> Path:
    resolved = path.resolve()
    if not resolved.is_relative_to(ROOT) or resolved == ROOT:
        raise ValueError("本地运行文件应位于项目子目录。")
    return resolved


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verified_asset(asset: dict) -> Path:
    destination = inside_root(ROOT / asset["path"])
    if destination.is_file():
        if destination.stat().st_size == asset["size"] and sha256(destination) == asset["sha256"]:
            return destination
        raise ValueError(f"现有文件校验失败，已保留：{destination.name}")
    temporary = inside_root(Path(str(destination) + ".part"))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not temporary.exists() or temporary.stat().st_size < asset["size"]:
        print(f"下载 {destination.name}（{asset['size'] / 1e9:.2f} GB）…", flush=True)
        command = ["curl.exe", "--location", "--fail", "--retry", "2", "--retry-delay", "2",
                   "--continue-at", "-", "--connect-timeout", "20", "--max-time", "3600",
                   "--silent", "--show-error", "--output", str(temporary), asset["url"]]
        subprocess.run(command, check=True, creationflags=subprocess.CREATE_NO_WINDOW)
    if temporary.stat().st_size != asset["size"] or sha256(temporary) != asset["sha256"]:
        raise ValueError(f"下载文件校验失败，已保留以便排查：{temporary.name}")
    # Both paths are resolved and confined to this project's artifact folders.
    temporary.rename(destination)
    print(f"SHA-256 校验通过：{destination.name}", flush=True)
    return destination


def extract_runtime(archive: Path) -> None:
    target = inside_root(RUNTIME)
    target.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(archive) as bundle:
        for item in bundle.infolist():
            path = (target / item.filename).resolve()
            if not path.is_relative_to(target):
                raise ValueError("压缩包包含越界路径。")
        bundle.extractall(target)


def setup(runtime_only: bool = False) -> None:
    if os.name != "nt":
        raise ValueError("这份便携运行包用于 Windows x64 NVIDIA 环境。")
    for asset in config()["assets"]:
        if runtime_only and asset["kind"] == "model":
            continue
        path = verified_asset(asset)
        if asset["kind"] == "runtime":
            extract_runtime(path)
    print("本地运行文件已就绪。")


def read_state() -> dict:
    return json.loads(STATE_PATH.read_text(encoding="utf-8")) if STATE_PATH.is_file() else {}


def write_state(state: dict) -> None:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    STATE_PATH.write_text(json.dumps(state, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def process_identity(pid: int) -> dict | None:
    if type(pid) is not int or pid < 1:
        return None
    shell = shutil.which("pwsh") or shutil.which("powershell")
    if not shell:
        raise ValueError("需要 PowerShell 来核对受管理进程的身份。")
    command = (f"$runtimeProcess = Get-Process -Id {pid} -ErrorAction Stop; "
               "[pscustomobject]@{path=$runtimeProcess.Path;started=$runtimeProcess.StartTime.ToUniversalTime().ToString('o')} | ConvertTo-Json -Compress")
    result = subprocess.run([shell, "-NoProfile", "-NonInteractive", "-Command", command], capture_output=True,
                            text=True, encoding="utf-8", errors="replace", timeout=10,
                            creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:
        return None
    return json.loads(result.stdout)


def owned_process(state: dict) -> bool:
    if state.get("status") != "running":
        return False
    identity = process_identity(state.get("pid"))
    if not identity or identity != state.get("identity"):
        return False
    executable = Path(identity.get("path", "")).resolve()
    return executable.name.lower() == "llama-server.exe" and executable.is_relative_to(RUNTIME.resolve())


def healthy() -> bool:
    cfg = config()
    key = KEY_PATH.read_text(encoding="ascii").strip() if KEY_PATH.is_file() else ""
    req = urllib.request.Request(f"http://{cfg['host']}:{cfg['port']}/health", headers={"Authorization": "Bearer " + key})
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(req, timeout=2) as response:
            payload = json.load(response)
            return isinstance(payload, dict) and payload.get("status") == "ok"
    except (urllib.error.URLError, OSError, json.JSONDecodeError):
        return False


def start() -> None:
    cfg = config()
    state = read_state()
    if state and owned_process(state):
        print("本地模型进程已在运行。" + ("健康检查通过。" if healthy() else "正在加载，运行 status 查看状态。"))
        return
    with socket.socket() as probe:
        if probe.connect_ex((cfg["host"], cfg["port"])) == 0:
            raise ValueError(f"端口 {cfg['port']} 已有服务，请先确认占用进程。")
    binaries = list(RUNTIME.rglob("llama-server.exe")) if RUNTIME.is_dir() else []
    model_path = ROOT / next(asset["path"] for asset in cfg["assets"] if asset["kind"] == "model")
    if len(binaries) != 1 or not model_path.is_file():
        raise ValueError("请先运行 python local_model.py setup。")
    executable = binaries[0].resolve()
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    if not KEY_PATH.exists():
        KEY_PATH.write_text(secrets.token_urlsafe(32) + "\n", encoding="ascii")
    key = KEY_PATH.read_text(encoding="ascii").strip()
    if len(key) < 32 or any(char.isspace() for char in key):
        raise ValueError("本地服务密钥格式异常，请检查 .runtime/local/api.key。")
    environment = os.environ.copy()
    # Keep unrelated cloud credentials and inherited server options out of the
    # local inference process. Explicit flags below define this deployment.
    for name in list(environment):
        if name.startswith("LLAMA_") or name in {"DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "HF_TOKEN"}:
            environment.pop(name)
    environment["LLAMA_API_KEY"] = key
    environment["PATH"] = str(executable.parent) + os.pathsep + str(RUNTIME) + os.pathsep + environment.get("PATH", "")
    command = [str(executable), "--model", str(model_path.resolve()), "--alias", cfg["alias"],
               "--host", cfg["host"], "--port", str(cfg["port"]), "--ctx-size", str(cfg["context_size"]),
               "--parallel", "1", "--n-gpu-layers", "99", "--flash-attn", "on",
               "--threads", "6", "--threads-batch", "6", "--batch-size", "1024", "--ubatch-size", "256",
               "--jinja", "--reasoning", "off", "--reasoning-budget", "0", "--offline",
               "--no-context-shift", "--no-ui", "--no-agent", "--no-ui-mcp-proxy",
               "--cors-origins", f"http://{cfg['host']}:{cfg['port']}"]
    log = STATE_DIR / "server.log"
    started = time.monotonic()
    with log.open("ab", buffering=0) as stream:
        process = subprocess.Popen(command, cwd=executable.parent, env=environment, stdin=subprocess.DEVNULL,
                                   stdout=stream, stderr=stream,
                                   creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP)
    identity = process_identity(process.pid)
    if not identity:
        raise ValueError(f"模型服务启动失败，请查看 {log}。")
    state = {"status": "running", "pid": process.pid, "identity": identity, "model": cfg["model"],
             "model_path": str(model_path.resolve()), "runtime_version": cfg["runtime_version"],
             "base_url": f"http://{cfg['host']}:{cfg['port']}/v1", "context_size": cfg["context_size"],
             "started_at": datetime.now(timezone.utc).isoformat(), "log": str(log)}
    write_state(state)
    while time.monotonic() - started < 55:
        if process.poll() is not None:
            state["status"] = "exited"
            write_state(state)
            raise ValueError(f"模型服务退出，查看 {log}。")
        if healthy():
            state["startup_seconds"] = round(time.monotonic() - started, 3)
            write_state(state)
            print(f"模型服务已就绪：{state['base_url']}；PID {process.pid}；启动耗时 {state['startup_seconds']} 秒。")
            return
        time.sleep(0.5)
    print("模型进程仍在加载，请运行 python local_model.py status 查看进度。")


def stop() -> None:
    state = read_state()
    if not state or not owned_process(state):
        print("本项目当前的模型进程已停止。")
        return
    # The PID, executable path and exact process creation time must all match
    # our state file, so a recycled PID cannot target another application.
    subprocess.run(["taskkill", "/PID", str(state["pid"]), "/T", "/F"], check=True,
                   capture_output=True, creationflags=subprocess.CREATE_NO_WINDOW, timeout=15)
    state.update(status="stopped", stopped_at=datetime.now(timezone.utc).isoformat())
    write_state(state)
    print("已停止本地模型服务，模型文件和日志已保留。")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("setup", "start", "stop", "status"))
    parser.add_argument("--runtime-only", action="store_true")
    args = parser.parse_args()
    try:
        if args.command == "setup":
            setup(args.runtime_only)
        elif args.command == "start":
            start()
        elif args.command == "stop":
            stop()
        else:
            state = read_state()
            print(json.dumps({**state, "healthy": healthy()}, ensure_ascii=False, indent=2))
        return 0
    except (ValueError, OSError, subprocess.SubprocessError, KeyError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
