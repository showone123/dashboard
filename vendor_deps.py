# -*- coding: utf-8 -*-
"""外部依赖本地化 / 校验工具。

为什么需要它
------------
构建出的 index.html 依赖 3 个固定版本的 CDN 文件（云服务 SDK、SheetJS、JSZip）。
把依赖落到 vendor/ 并锁定 SHA-256，可以：
  · 离线开发（无外网 / 系统代理拦截 CDN 的环境）；
  · 让「今天构建出的东西」和「上周构建出的东西」真的是同一个东西。

四个动作
--------
  python vendor_deps.py --check    校验 vendor/ 里的文件与 deps.lock.json 记录的 SHA-256 是否一致
  python vendor_deps.py --fetch    从 CDN 下载到 vendor/（下载后自动校验；不一致会报错）
  python vendor_deps.py --apply    把构建产物 index.html 里的 CDN 地址改成本地 vendor/ 相对路径
  python vendor_deps.py --info     打印依赖清单与锁定状态（不改任何文件）

⚠️ --apply 是**离线开发专用**。改完的 index.html 不再是单文件（需要 vendor/ 目录在旁边），
   不要用它发布线上。想恢复：重新跑 python build/make_app.py 即可。

只用标准库 urllib，不引入 requests。
"""
import hashlib
import io
import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
LOCK = os.path.join(HERE, "deps.lock.json")
VENDOR = os.path.join(HERE, "vendor")
INDEX = os.path.join(HERE, "index.html")
DIST_INDEX = os.path.join(HERE, "dist", "index.html")


def load_lock():
    with io.open(LOCK, encoding="utf-8") as f:
        return json.load(f)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def fetch(url, timeout=60):
    req = urllib.request.Request(url, headers={"User-Agent": "vendor_deps/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


# ---------------------------------------------------------------- 动作实现

def do_info():
    d = load_lock()
    print("依赖清单：%s\n" % LOCK)
    print("%-24s %-12s %-10s %-10s %s" % ("依赖", "锁定版本", "文件", "大小", "校验"))
    print("-" * 84)
    for it in d["runtime_browser_deps"]:
        vp = os.path.join(HERE, it["vendor_path"])
        if os.path.isfile(vp):
            ok = sha256_file(vp) == it["sha256"]
            state = "OK" if ok else "不一致"
            size = "%d" % os.path.getsize(vp)
        else:
            state, size = "缺失", "-"
        float_tag = " (浮动!)" if it.get("is_floating") else ""
        print("%-24s %-12s %-10s %-10s %s%s" % (
            it["name"], it["resolved_version"], "有" if os.path.isfile(vp) else "无",
            size, state, float_tag))
    print()
    for line in d["_critical_note"]:
        print(line if line.startswith("  ") else "  " + line)
    print()


def do_check():
    d = load_lock()
    bad = 0
    for it in d["runtime_browser_deps"]:
        vp = os.path.join(HERE, it["vendor_path"])
        if not os.path.isfile(vp):
            print("缺失  %-22s %s" % (it["name"], it["vendor_path"]))
            bad += 1
            continue
        got = sha256_file(vp)
        if got == it["sha256"]:
            print("OK    %-22s %s" % (it["name"], it["resolved_version"]))
        else:
            print("不一致 %-21s %s" % (it["name"], it["vendor_path"]))
            print("        期望 sha256 = %s" % it["sha256"])
            print("        实际 sha256 = %s" % got)
            bad += 1
    print()
    if bad:
        print("FAIL：%d 个依赖不匹配。跑 --fetch 重新下载，或确认 deps.lock.json 是否该更新。" % bad)
        return 1
    print("PASS：vendor/ 与 deps.lock.json 完全一致。")
    return 0


def do_fetch():
    d = load_lock()
    os.makedirs(VENDOR, exist_ok=True)
    bad = 0
    for it in d["runtime_browser_deps"]:
        dest = os.path.join(HERE, it["vendor_path"])
        url = it["cdn_url_used_by_build"]
        print("下载 %-22s <- %s" % (it["name"], url))
        try:
            body = fetch(url)
        except Exception as e:
            print("        失败：%s" % e)
            bad += 1
            continue
        with open(dest, "wb") as f:
            f.write(body)
        got = hashlib.sha256(body).hexdigest()
        if got == it["sha256"]:
            print("        OK  %d bytes，sha256 与锁一致" % len(body))
        elif it.get("is_floating"):
            print("        ⚠️  %d bytes，sha256 **变了**（浮动标签 @dev 已指向新构建）" % len(body))
            print("            锁里记录 ：%s" % it["sha256"])
            print("            本次实际 ：%s" % got)
            print("            这是预期内的事 —— 但意味着线上行为可能已随之变化。")
            print("            要接受新版本：把 deps.lock.json 的 sha256 / bytes / resolved_version 更新为上面的值。")
        else:
            print("        ✗ %d bytes，sha256 与锁**不一致**（固定版本号不该变，请排查）" % len(body))
            print("            期望 %s" % it["sha256"])
            print("            实际 %s" % got)
            bad += 1
    print()
    return 1 if bad else 0


def do_apply():
    """把 index.html（以及 dist/index.html，若存在）里的 CDN 地址换成本地 vendor 路径。"""
    d = load_lock()
    targets = [p for p in (INDEX, DIST_INDEX) if os.path.isfile(p)]
    if not targets:
        print("找不到 index.html，请先跑 python build/make_app.py")
        return 1

    # index.html 在仓库根，vendor/ 也在仓库根 → 相对路径就是 vendor/xxx
    pairs = [(it["cdn_url_used_by_build"], it["vendor_path"].replace("\\", "/"))
             for it in d["runtime_browser_deps"]]

    for tp in targets:
        with io.open(tp, encoding="utf-8") as f:
            s = f.read()
        n = 0
        for cdn, local in pairs:
            if cdn in s:
                s = s.replace(cdn, local)
                n += 1
        if n:
            out = tp + ".vendor.html"
            with io.open(out, "w", encoding="utf-8") as f:
                f.write(s)
            print("已生成 %s（替换了 %d 个 CDN 地址）" % (os.path.relpath(out, HERE), n))
        else:
            print("%s 里没找到可替换的 CDN 地址（可能已经替换过）" % os.path.relpath(tp, HERE))

    print()
    print("⚠️ 生成的 *.vendor.html 依赖同目录下的 vendor/ 才能打开，**不要发布它**。")
    print("   发布用 index.html 请由 python build/make_app.py 重新生成（CDN 版，单文件）。")
    return 0


# ---------------------------------------------------------------- 入口

ACTIONS = {"--check": do_check, "--fetch": do_fetch, "--apply": do_apply, "--info": do_info}


def main(argv):
    if len(argv) > 1 and argv[1] in ACTIONS:
        return ACTIONS[argv[1]]()
    do_info()
    print("用法：")
    print("  python vendor_deps.py --check    校验 vendor/ 与 deps.lock.json 的 SHA-256")
    print("  python vendor_deps.py --fetch    从 CDN 重新下载到 vendor/")
    print("  python vendor_deps.py --apply    生成离线版 index.html.vendor.html")
    print("  python vendor_deps.py --info     打印清单（默认）")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
