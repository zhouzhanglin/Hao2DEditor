#!/usr/bin/env python3
"""Hao2DEditor 本机命令服务客户端（备用通道）。

优先用 MCP 或你自己的 HTTP 能力；本脚本用于没有 HTTP 工具的场合，或需要把
大段批量命令落成文件反复执行时。它只做一件事：按编辑器约定的形状收发 JSON。

连接信息解析顺序：
  1. --url / --token（或环境变量 HAO2D_URL / HAO2D_TOKEN）
  2. 从 --project（默认 cwd）逐级向上找 ai/hao2d-ai-server.json
  3. 用户目录 command-server.json
     macOS   ~/Library/Application Support/hao2d-editor/
     Windows %APPDATA%/hao2d-editor/
     Linux   ~/.config/hao2d-editor/

用法：
  python3 hao2d.py health
  python3 hao2d.py catalog [--grep 关键字]
  python3 hao2d.py state
  python3 hao2d.py call getProjectState
  python3 hao2d.py call addBone '{"name":"chest","parent":"root"}'
  python3 hao2d.py batch build.json [--label 搭骨架] [--no-transaction]

退出码：0 = 全部 ok；1 = 有 ok:false 或连接失败。
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from urllib.parse import urlencode

TIMEOUT = 60


# ---------------------------------------------------------------- 连接信息


def _read_json(path: str) -> dict | None:
    try:
        with open(path, "r", encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return None


def _user_data_candidates() -> list[str]:
    home = os.path.expanduser("~")
    if sys.platform == "darwin":
        base = os.path.join(home, "Library", "Application Support", "hao2d-editor")
    elif os.name == "nt":
        base = os.path.join(os.environ.get("APPDATA", home), "hao2d-editor")
    else:
        base = os.path.join(os.environ.get("XDG_CONFIG_HOME", os.path.join(home, ".config")), "hao2d-editor")
    return [os.path.join(base, "command-server.json")]


def discover(project: str | None, url: str | None, token: str | None) -> tuple[str, str, str]:
    """返回 (url, token, 来源说明)。找不到就退出并给出排查提示。"""
    if url and token:
        return url.rstrip("/"), token, "--url/--token"

    env_url, env_token = os.environ.get("HAO2D_URL"), os.environ.get("HAO2D_TOKEN")
    if env_url and env_token:
        return env_url.rstrip("/"), env_token, "环境变量"

    start = os.path.abspath(project or os.getcwd())
    current = start
    while True:
        info = _read_json(os.path.join(current, "ai", "hao2d-ai-server.json"))
        if info and info.get("url") and info.get("token"):
            return info["url"].rstrip("/"), info["token"], f"{current}/ai/hao2d-ai-server.json"
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent

    for path in _user_data_candidates():
        info = _read_json(path)
        if info and info.get("url") and info.get("token"):
            return info["url"].rstrip("/"), info["token"], path

    sys.exit(
        "找不到 Hao2DEditor 命令服务。\n"
        "  - 编辑器开着吗？关闭时发现文件会被删除\n"
        "  - 试 --url http://127.0.0.1:37241 --token <token>\n"
        "  - 或读工程 <工程目录>/ai/hao2d-ai-server.json\n"
        "  - 或读用户目录 command-server.json（路径见本脚本头部注释）"
    )


# ---------------------------------------------------------------- 请求


def request(base: str, token: str, path: str, payload: dict | None = None) -> dict:
    url = f"{base}{path}?{urlencode({'token': token})}"
    data = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST" if data is not None else "GET")
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            body = resp.read().decode("utf-8")
    except urllib.error.HTTPError as exc:  # 正常情况命令服务一律回 200
        body = exc.read().decode("utf-8", "replace")
    except urllib.error.URLError as exc:
        sys.exit(f"连不上 {base}：{exc.reason}\n编辑器可能没开（关掉时服务会停）。")
    try:
        return json.loads(body)
    except ValueError:
        sys.exit(f"返回不是 JSON：{body[:400]}")


def show(result: dict, pretty: bool = True) -> bool:
    print(json.dumps(result, ensure_ascii=False, indent=2 if pretty else None))
    if isinstance(result, dict) and result.get("ok") is False:
        print("提示：读 error 原文改参数后重试，不要原样重发。", file=sys.stderr)
        return False
    return True


# ---------------------------------------------------------------- 子命令


def cmd_health(args, base, token):
    return show(request(base, token, "/health"))


def cmd_catalog(args, base, token):
    result = request(base, token, "/commands")
    if result.get("ok") is False:
        return show(result)
    # GET /commands 顶层就是 { commands, playbook, instructions }（见 __catalog）
    catalog = result.get("commands") or result.get("data", {}).get("commands", [])
    keyword = (args.grep or "").lower()
    items = []
    for spec in catalog:
        text = f"{spec.get('name', '')} {spec.get('title', '')} {spec.get('description', '')}".lower()
        if keyword and keyword not in text:
            continue
        items.append(spec)
    if keyword:
        print(json.dumps(items, ensure_ascii=False, indent=2))
    else:
        names = [spec.get("name", "") for spec in items]
        print(f"{len(names)} 条命令：\n" + " ".join(names))
    return True


def cmd_state(args, base, token):
    result = request(base, token, "/command", {"name": "getProjectState"})
    if not result.get("ok"):
        return show(result)
    data = result.get("data", {})
    print(f"工程      {data.get('projectName')}  ({data.get('projectPath')})")
    print(f"未保存    {data.get('dirty')}   撤销/重做 {data.get('canUndo')}/{data.get('canRedo')}")
    for item in data.get("skeletons", []):
        mark = "*" if item.get("active") else " "
        print(f" {mark} [{item.get('index')}] {item.get('armatureName')}  "
              f"骨 {item.get('bones')} 槽 {item.get('slots')} 动画 {item.get('animations')}")
        if item.get("animationNames"):
            print(f"      动画：{', '.join(item['animationNames'])}")
    for hint in data.get("next", []):
        print(f"next: {hint}")
    return True


def cmd_call(args, base, token):
    payload = {"name": args.name}
    if args.args:
        try:
            payload["args"] = json.loads(args.args)
        except ValueError:
            sys.exit("args 不是合法 JSON（要传对象，如 '{\"name\":\"chest\"}'）")
    return show(request(base, token, "/command", payload))


def cmd_batch(args, base, token):
    try:
        with open(args.file, "r", encoding="utf-8") as handle:
            content = json.load(handle)
    except (OSError, ValueError) as exc:
        sys.exit(f"读不了批量文件 {args.file}：{exc}")
    body = content if isinstance(content, dict) else {"commands": content}
    body.setdefault("commands", [])
    if args.label:
        body["label"] = args.label
    if args.no_transaction:
        body["transaction"] = False
    else:
        body.setdefault("transaction", True)
    return show(request(base, token, "/batch", body))


def main() -> int:
    parser = argparse.ArgumentParser(description="Hao2DEditor 命令服务客户端（备用通道）")
    parser.add_argument("--url", help="命令服务地址，如 http://127.0.0.1:37241")
    parser.add_argument("--token", help="命令服务 token")
    parser.add_argument("--project", help="工程目录（用于找 ai/hao2d-ai-server.json）")
    subs = parser.add_subparsers(dest="cmd", required=True)

    subs.add_parser("health", help="探活")
    catalog = subs.add_parser("catalog", help="命令目录")
    catalog.add_argument("--grep", help="按关键字过滤（名字/标题/说明）")
    subs.add_parser("state", help="getProjectState 简表")
    call = subs.add_parser("call", help="执行单条命令")
    call.add_argument("name")
    call.add_argument("args", nargs="?", help="JSON 对象字符串")
    batch = subs.add_parser("batch", help="批量执行（默认 transaction=true）")
    batch.add_argument("file", help='JSON 文件：{"label":…, "commands":[…]} 或裸数组')
    batch.add_argument("--label")
    batch.add_argument("--no-transaction", action="store_true")

    args = parser.parse_args()
    base, token, origin = discover(args.project, args.url, args.token)
    if args.cmd != "health":
        print(f"# {origin}", file=sys.stderr)

    handlers = {
        "health": cmd_health,
        "catalog": cmd_catalog,
        "state": cmd_state,
        "call": cmd_call,
        "batch": cmd_batch,
    }
    ok = handlers[args.cmd](args, base, token)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
