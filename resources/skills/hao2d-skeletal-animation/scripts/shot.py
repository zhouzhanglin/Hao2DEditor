#!/usr/bin/env python3
"""抓视口截图存成 PNG —— 自查用（用户要图时也用它）。

`captureViewport` 返回的是 base64 data URL，聊天里没法直接看；本脚本把它落成 PNG
并打印绝对路径。默认只给自己 `read_file` 核对姿态用，**不要**拿它当流程关卡
（打完帧再问用户「这样可以吗」）。

用法：
  # 当前画面一张
  python3 shot.py --out preview/setup.png

  # 指定动画的多个时间点，各一张（文件名自动带时间）
  python3 shot.py --animation idle --times 0,0.5,1,1.5,2 --out preview/idle.png

  # 只挪播放头再截
  python3 shot.py --time 0.5 --out preview/idle_0.5.png

连接信息解析顺序与 hao2d.py 相同（--url/--token → 工程 ai/ → 用户目录）。
退出码：0 = 全部截成功；1 = 有失败。
"""

from __future__ import annotations

import argparse
import base64
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from hao2d import discover, request  # noqa: E402  (同目录的客户端)


def call(base: str, token: str, name: str, args: dict | None = None) -> dict:
    payload = {"name": name}
    if args:
        payload["args"] = args
    return request(base, token, "/command", payload)


def decode(data_url: str) -> bytes:
    _, _, payload = data_url.partition(",")
    return base64.b64decode(payload)


def save_png(base: str, token: str, out: str, time: float | None = None) -> bool:
    # 时间点一并交给 captureViewport：AI 通常在这个窗口之外驱动编辑器，
    # 窗口在后台时播放时钟不走，只 setTime 不 seek 的话截到的永远是第 0 帧（绑定姿态）
    args = None if time is None else {"time": time}
    result = call(base, token, "captureViewport", args)
    if result.get("ok") is False:
        print(f"截图失败：{result.get('error')}", file=sys.stderr)
        return False
    data = result.get("data") or {}
    data_url = data.get("dataUrl")
    if not data_url:
        print("截图失败：返回里没有 dataUrl（视口可能还没就绪，重试一次）", file=sys.stderr)
        return False
    path = os.path.abspath(out)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    with open(path, "wb") as handle:
        handle.write(decode(data_url))
    print(f"{path}  ({data.get('width')}x{data.get('height')})")
    return True


def main() -> int:
    parser = argparse.ArgumentParser(description="抓 Hao2DEditor 视口截图存 PNG")
    parser.add_argument("--out", required=True, help="输出 PNG 路径（--times 时作为文件名前缀）")
    parser.add_argument("--time", type=float, help="先挪播放头到该时间（秒）再截")
    parser.add_argument("--times", help="多个时间点，逗号分隔；每个时间点各存一张")
    parser.add_argument("--animation", help="先切到该动画（会先确保处于 animate 模式）")
    parser.add_argument("--url")
    parser.add_argument("--token")
    parser.add_argument("--project", help="工程目录（用于找 ai/hao2d-ai-server.json）")
    args = parser.parse_args()

    base, token, origin = discover(args.project, args.url, args.token)
    print(f"# {origin}", file=sys.stderr)

    if args.animation:
        call(base, token, "setMode", {"mode": "animate"})
        switched = call(base, token, "setAnimation", {"name": args.animation})
        if switched.get("ok") is False:
            print(f"切动画失败：{switched.get('error')}", file=sys.stderr)
            return 1

    times: list[float | None]
    if args.times:
        try:
            times = [float(item) for item in args.times.split(",") if item.strip()]
        except ValueError:
            print("--times 要写成 0,0.5,1 这样的数字列表", file=sys.stderr)
            return 1
    elif args.time is not None:
        times = [args.time]
    else:
        times = [None]

    stem, ext = os.path.splitext(args.out)
    ok = True
    for time in times:
        if time is not None:
            moved = call(base, token, "setTime", {"time": time})
            if moved.get("ok") is False:
                print(f"setTime({time}) 失败：{moved.get('error')}", file=sys.stderr)
                ok = False
                continue
        target = args.out if len(times) == 1 else f"{stem}_{time:.2f}{ext or '.png'}"
        ok = save_png(base, token, target, time) and ok
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
