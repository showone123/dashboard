# -*- coding: utf-8 -*-
"""GitHub 协同：把 Codex 在 GitHub 上的改动安全地取回本项目，并把本项目的改动推回去。

设计前提（本机实测，2026-09-17）
--------------------------------
这台机器到 GitHub 的各条通道**不是全都通**：

    github.com:443          ❌ 不通（20 秒超时）→ 所以 `git clone https://github.com/...` 会失败
    github.com:22           ✅ 通              → SSH 方式可用
    ssh.github.com:443      ✅ 通              → SSH 走 443 也行（绕开上面那条封锁）
    api.github.com:443      ✅ 通（含鉴权写接口）
    codeload.github.com:443 ✅ 通（整库 zip）
    raw.githubusercontent.com:443 ✅ 通（单文件）

结论：**不要用 HTTPS 克隆**。三条可用的路：

    A. git over SSH（推荐，功能最全：分支/历史/合并都正常）
       —— 需要一次性配置 SSH 密钥（见 --setup-guide）
    B. GitHub API + Token（无需密钥，读写都行）
       —— 读用 zipball，写用 Git Data API（本脚本已实现，会生成真正的 commit）
    C. WorkBuddy 的 GitHub 连接器（平台原生，OAuth 授权，最省事）

本脚本实现 A 与 B，并自动选择可用的那条。

六个动作
--------
    python github_sync.py --probe              连通性体检（先跑这个，看当前哪条路通）
    python github_sync.py --status             本地 / 远端 / 部署产物 三方状态
    python github_sync.py --pull               拉远端到 _incoming/（**不改本地**）+ 变更报告
    python github_sync.py --diff               比对 _incoming/ 与本地，列出差异
    python github_sync.py --apply              把 _incoming/ 覆盖到本地（先自动备份）
    python github_sync.py --push -m "说明"      提交并推送本地改动

⚠️ 本脚本**永远不会直接覆盖你的工作区**。--pull 只写 _incoming/，--apply 才落地，
   且落地前会把被覆盖的文件备份到 _backup/<时间戳>/。

配置：github.json（可提交，不含密钥）+ 环境变量 GITHUB_TOKEN（只在用 API 模式时需要）
"""
import argparse
import base64
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(HERE, "github.json")
INCOMING = os.path.join(HERE, "_incoming")
BACKUP = os.path.join(HERE, "_backup")

# SSH 走 443：github.com:443 不通，但 ssh.github.com:443 通
SSH443 = ("ssh -p 443 -o HostName=ssh.github.com -o StrictHostKeyChecking=accept-new "
          "-o BatchMode=yes -o ConnectTimeout=20")

SKIP_DIRS = {".git", "_incoming", "_backup", "_gitclone_tmp", "__pycache__"}
SKIP_FILES = {".env"}


# ------------------------------------------------------------------ 基础工具

def load_config():
    if not os.path.isfile(CONFIG):
        return {}
    with io.open(CONFIG, encoding="utf-8") as f:
        return json.load(f)


def token():
    t = os.environ.get("GITHUB_TOKEN") or ""
    if t:
        return t.strip()
    # 也允许放在 .env 里（.env 已被 .gitignore 忽略）
    envf = os.path.join(HERE, ".env")
    if os.path.isfile(envf):
        with io.open(envf, encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GITHUB_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for c in iter(lambda: f.read(1 << 20), b""):
            h.update(c)
    return h.hexdigest()


def which(name):
    return shutil.which(name)


def has_ssh_key():
    return (os.path.isfile(os.path.expanduser("~/.ssh/id_ed25519"))
            or os.path.isfile(os.path.expanduser("~/.ssh/id_rsa")))


def run(cmd, env_extra=None, timeout=120, retry_net=1):
    """执行本地命令。

    retry_net > 1 时，对**网络类失败**（超时 / 连接被拒 / 传输中断）做指数退避重试；
    对"命令确实执行了但返回非零"（比如 git commit 说没东西可提交）不重试。
    本机 GitHub 可达性抖动，网络类 git 命令（clone / push / ls-remote）必须传 retry_net=4。
    """
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    net_markers = ("Unable to connect", "Could not connect", "Connection refused",
                   "Connection reset", "Failed to connect", "Connection timed out",
                   "TLS", "SSL", "Recv failure", "Send failure", "early EOF",
                   "RPC failed", "unexpected disconnect", "命令超时")
    last_code, last_out = 1, ""
    for attempt in range(max(1, retry_net)):
        last_code, last_out = _run_once(cmd, env, timeout)
        if retry_net <= 1:
            return last_code, last_out
        if last_code == 0:
            return last_code, last_out
        if last_code == 124:                       # 超时 → 网络问题，重试
            pass
        elif any(m in last_out for m in net_markers):
            pass                                   # 网络特征 → 重试
        else:
            return last_code, last_out             # 业务性失败，重试没意义
        if attempt < retry_net - 1:
            time.sleep(2.0 * (2 ** attempt))
            print("      （网络抖动，重试 %d/%d…）" % (attempt + 2, retry_net))
    return last_code, last_out


def _run_once(cmd, env, timeout):
    try:
        r = subprocess.run(cmd, cwd=HERE, env=env, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=timeout)
        return r.returncode, ((r.stdout or "") + (r.stderr or "")).strip()
    except subprocess.TimeoutExpired:
        return 124, "命令超时（%ds）" % timeout
    except FileNotFoundError as e:
        return 127, str(e)


def http(url, method="GET", data=None, headers=None, timeout=60, allow=(200, 201, 204, 302),
         retry_net=4):
    """HTTP 请求。网络层失败（code==0）自动重试，HTTP 状态码不重试。

    关键点：**code==0 表示"没连上"，不是"服务器说不行"**。本机 GitHub 可达性
    间歇性抖动，同一请求第二次往往就通，所以必须重试；而 401/404/422 是服务器
    明确回答，重试只是浪费时间。
    """
    last = (0, b"", {})
    for attempt in range(max(1, retry_net)):
        code, raw, hdr = http_once(url, method, data, headers, timeout)
        if code != 0:
            return code, raw, hdr
        last = (code, raw, hdr)
        if attempt < retry_net - 1:
            time.sleep(2.0 * (2 ** attempt))
    return last


def http_once(url, method="GET", data=None, headers=None, timeout=60):
    h = {"User-Agent": "github-sync/1.0", "Accept": "application/vnd.github+json"}
    h.update(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=body, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, raw, dict(r.headers)
    except urllib.error.HTTPError as e:
        return e.code, e.read(), dict(e.headers or {})
    except Exception as e:
        return 0, str(e).encode("utf-8"), {}


def api_headers(t=None):
    t = t or token()
    return {"Authorization": "Bearer " + t} if t else {}


def hr(c="-", n=78):
    print(c * n)


def sec(t):
    print()
    hr()
    print("  " + t)
    hr()


def say(msg=""):
    print(msg)


def retry(fn, attempts=4, base_delay=2.0, label=""):
    """对间歇性网络失败做指数退避重试。

    本机实测：GitHub 的可达性是**间歇性**的 —— 同一个域名几分钟内能从 0/6 变成 6/6。
    所以任何一次失败都**不足以判定不可用**，必须重试。
    返回 (结果, 最后一次的错误信息)；成功时错误为 None。
    """
    last = None
    for i in range(attempts):
        try:
            r = fn()
            if r is not None:
                return r, None
            last = "返回空"
        except Exception as e:
            last = str(e)
        if i < attempts - 1:
            time.sleep(base_delay * (2 ** i))
    return None, "%s重试 %d 次仍失败：%s" % ((label + "：") if label else "", attempts, last)


def probe_once(url):
    """单次探测一个 HTTPS 目标，返回 http 码（'000' 表示连不上）。"""
    c, out = run(["curl", "-s", "-o", os.devnull, "-w", "%{http_code}", "--max-time", "12", url],
                 timeout=25)
    return (out or "").strip().splitlines()[-1] if out and out.strip() else "000"


def probe_tcp(host, port, wait=8):
    r = subprocess.run(["bash", "-c", "timeout %d </dev/tcp/%s/%d" % (wait, host, port)],
                       capture_output=True)
    return r.returncode == 0


# ------------------------------------------------------------------ 1. probe

def do_probe(rounds=3):
    sec("1. GitHub 通道体检（本机网络实况）")

    https = [
        ("github.com:443  (git over HTTPS)", "https://github.com/"),
        ("api.github.com:443  (REST API)", "https://api.github.com/"),
        ("codeload.github.com:443  (整库 zip)", "https://codeload.github.com/"),
        ("raw.githubusercontent.com:443  (单文件)", "https://raw.githubusercontent.com/"),
    ]
    ports = [
        ("github.com:22  (git over SSH)", "github.com", 22),
        ("ssh.github.com:443  (SSH over 443)", "ssh.github.com", 443),
    ]

    print("  每个目标连测 %d 次 —— 本机 GitHub 可达性不稳定，单次结果不可信\n" % rounds)
    results = {}
    for name, url in https:
        hits, codes = 0, []
        for _ in range(rounds):
            c = probe_once(url)
            codes.append(c)
            if c != "000":
                hits += 1
        results[name] = hits / rounds
        verdict = "稳定" if hits == rounds else ("抖动" if hits else "不可达")
        print("  %-40s %d/%d  %-4s  %s" % (name, hits, rounds, verdict, " ".join(codes)))

    for name, host, port in ports:
        hits = sum(1 for _ in range(rounds) if probe_tcp(host, port))
        results[name] = hits / rounds
        verdict = "稳定" if hits == rounds else ("抖动" if hits else "不可达")
        print("  %-40s %d/%d  %-4s" % (name, hits, rounds, verdict))

    # SSH 是否到达认证阶段
    code, out = run(["git", "ls-remote", "ssh://git@github.com/octocat/Hello-World.git"],
                    env_extra={"GIT_SSH_COMMAND": SSH443}, timeout=45)
    ssh_auth = "Permission denied (publickey)" in out or "successfully authenticated" in out
    ssh_unreachable = "Could not connect" in out or "Connection refused" in out or code == 124
    print("  %-40s %s" % ("SSH-over-443 到达认证阶段",
                          "是（只差密钥）" if ssh_auth else ("否（连不上）" if ssh_unreachable else "否（%s）" % out[-60:])))

    print()
    say("  git 版本       : %s" % (run(["git", "--version"])[1] or "未安装"))
    say("  gh CLI         : %s" % ("已安装" if which("gh") else "未安装（本脚本不依赖它）"))
    say("  GITHUB_TOKEN   : %s" % ("已配置" if token() else "未配置"))
    say("  SSH 密钥       : %s" % ("有" if has_ssh_key() else "无"))

    sec("结论：读取路径的可用性")
    ssh_ok = results.get("ssh.github.com:443  (SSH over 443)", 0) > 0 and ssh_auth
    if ssh_ok:
        print("  ✅ A. git over SSH —— 传输可用（只差 SSH 密钥）。功能最全：分支/历史/合并都正常")
        print("       配置：python github_sync.py --setup-guide")
    elif results.get("github.com:22  (git over SSH)", 0) > 0 and ssh_auth:
        print("  ✅ A. git over SSH —— 传输可用（只差 SSH 密钥）")
    else:
        r = max(results.get("ssh.github.com:443  (SSH over 443)", 0),
                results.get("github.com:22  (git over SSH)", 0))
        print("  ⚠️ A. git over SSH —— 本次探测没打通（成功率 %.0f%%）；GitHub 可达性抖动，稍后重测可能就通" % (r * 100))

    api_rate = results.get("api.github.com:443  (REST API)", 0)
    if api_rate > 0:
        print("  ✅ B. GitHub API —— 可用（成功率 %.0f%%）%s"
              % (api_rate * 100, "" if token() else "；读公开库无需 token，私有库需要 GITHUB_TOKEN"))
        print("       读：zipball 整库 / contents 单文件   写：Git Data API 生成真实 commit")
    else:
        print("  ⚠️ B. GitHub API —— 本次没打通（成功率 0%%）；稍后重测")
    print("  ✅ C. WorkBuddy GitHub 连接器 —— OAuth 授权，不用在本机配密钥或 token（本机网络抖动时更稳）")

    unstable = any(0 < v < 1 for v in results.values())
    print()
    if unstable:
        print("  ⚠️ 检测到**抖动**：部分目标成功率在 0% 与 100% 之间。")
        print("     含义：git/API 操作会随机失败，不是配置问题。本脚本已内置重试（指数退避，4 次）。")
        print("     若频繁失败，建议改用连接器（方案 C），或在本机挂一个稳定的代理。")
    return 0


# ------------------------------------------------------------------ 2. status

def git_remote_url(cfg):
    return "ssh://git@github.com/%s.git" % cfg["repo"]


def local_tree_hashes(base=HERE):
    out = {}
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if f in SKIP_FILES:
                continue
            full = os.path.join(dp, f)
            rel = os.path.relpath(full, base).replace(os.sep, "/")
            out[rel] = sha256_file(full)
    return out


def git_publish_files():
    """返回 Git 认可的待发布文件，严格遵守 .gitignore。

    API 推送不能直接 os.walk 工作区，否则可能把 .env、测试产物和本地备份
    绕过 .gitignore 上传。要求仓库已初始化，让 Git 成为文件选择的唯一来源。
    """
    if not os.path.isdir(os.path.join(HERE, ".git")):
        raise RuntimeError("API 推送前必须先初始化 Git 仓库")
    code, out = run(["git", "ls-files", "-co", "--exclude-standard"])
    if code != 0:
        raise RuntimeError("无法取得 Git 文件清单：%s" % out)
    return [p for p in out.splitlines() if p and p != ".env"]


def do_status():
    cfg = load_config()
    sec("2. 三方状态：本地工作区 / GitHub 远端 / 部署产物")

    # 本地
    local = local_tree_hashes()
    say("  本地工作区  : %d 个文件" % len(local))
    say("  目录        : %s" % HERE)

    # git 状态
    if os.path.isdir(os.path.join(HERE, ".git")):
        say("  git 仓库    : 已初始化")
        for label, cmd in [("分支", ["git", "rev-parse", "--abbrev-ref", "HEAD"]),
                           ("HEAD", ["git", "log", "-1", "--format=%h %ad %s", "--date=format:%m-%d %H:%M"]),
                           ("远端", ["git", "remote", "-v"]),
                           ("未提交", ["git", "status", "--porcelain"])]:
            c, o = run(cmd)
            first = (o.splitlines() or [""])[0] if o else ""
            if label == "未提交":
                n = len([l for l in o.splitlines() if l.strip()]) if o else 0
                say("  %-11s : %d 个文件未提交" % (label, n))
            else:
                say("  %-11s : %s" % (label, first or "（无）"))
    else:
        say("  git 仓库    : 未初始化（--pull 仍可用，走 API 模式）")

    # 远端
    if not cfg.get("repo"):
        say()
        print("  ⚠️ 还没配置仓库。先跑：python github_sync.py --init owner/repo")
        return 0
    say()
    say("  远端仓库    : https://github.com/%s  (ref=%s)" % (cfg["repo"], cfg.get("ref", "main")))
    code, raw, _ = http("https://api.github.com/repos/%s/commits/%s"
                        % (cfg["repo"], cfg.get("ref", "main")), headers=api_headers())
    if code == 200:
        d = json.loads(raw)
        say("  远端 HEAD   : %s  %s" % (d["sha"][:7], (d["commit"]["message"] or "").splitlines()[0]))
        say("  远端时间    : %s" % d["commit"]["committer"]["date"])
    elif code == 404:
        say("  远端 HEAD   : 读不到（私有库需 GITHUB_TOKEN，或仓库/分支名不对）")
    elif code == 401:
        say("  远端 HEAD   : 鉴权失败（GITHUB_TOKEN 无效或过期）")
    else:
        say("  远端 HEAD   : 查询失败 http=%s" % code)

    # 部署产物
    idx = os.path.join(HERE, "index.html")
    dst = os.path.join(HERE, "dist", "index.html")
    say()
    if os.path.isfile(idx) and os.path.isfile(dst):
        same = open(idx, "rb").read() == open(dst, "rb").read()
        say("  部署产物    : dist/index.html %s index.html" % ("==" if same else "!= 不一致"))
    else:
        say("  部署产物    : 缺失（先跑 python verify.py）")

    # incoming
    if os.path.isdir(INCOMING):
        n = len([1 for dp, dn, fn in os.walk(INCOMING) for f in fn])
        say("  待审改动    : _incoming/ 有 %d 个文件（跑 --diff 看差异，--apply 落地）" % n)
    return 0


# ------------------------------------------------------------------ 3. pull

def fetch_via_api(cfg):
    """走 api.github.com 的 zipball：私有库需要 token。返回 zip 字节。"""
    ref = cfg.get("ref", "main")
    url = "https://api.github.com/repos/%s/zipball/%s" % (cfg["repo"], ref)
    code, raw, _ = http(url, headers=api_headers(), timeout=180)
    if code != 200:
        return None, "http=%s %s" % (code, raw[:200].decode("utf-8", "replace"))
    return raw, None


def fetch_via_git(cfg):
    """走 SSH-over-443 的 git 克隆。返回 zip 字节（打包成同样形态，便于统一处理）。"""
    import zipfile
    url = git_remote_url(cfg)
    ref = cfg.get("ref", "main")
    tmp = os.path.join(HERE, "_gitclone_tmp")
    if os.path.isdir(tmp):
        shutil.rmtree(tmp)
    env = {"GIT_SSH_COMMAND": SSH443}
    c, o = run(["git", "clone", "--depth", "1", "--branch", ref, url, tmp], env_extra=env, timeout=300)
    if c != 0:
        if os.path.isdir(tmp):
            shutil.rmtree(tmp)
        return None, o
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:
        for dp, dn, fn in os.walk(tmp):
            dn[:] = [d for d in dn if d != ".git"]
            for f in fn:
                full = os.path.join(dp, f)
                z.write(full, os.path.relpath(full, tmp).replace(os.sep, "/"))
    shutil.rmtree(tmp)
    return buf.getvalue(), None


def do_pull(force_api=False):
    import zipfile
    cfg = load_config()
    if not cfg.get("repo"):
        print("  ⚠️ 未配置仓库。跑：python github_sync.py --init owner/repo")
        return 1
    sec("3. 拉取远端到 _incoming/（不修改本地工作区）")

    raw = err = None
    if force_api or not os.path.isfile(os.path.expanduser("~/.ssh/id_ed25519")):
        say("  方式：GitHub API（zipball）")
        raw, err = fetch_via_api(cfg)
    else:
        say("  方式：git over SSH（ssh.github.com:443）")
        raw, err = fetch_via_git(cfg)
        if err:
            say("  SSH 方式失败，回退到 API：%s" % err.splitlines()[0][:100])
            raw, err = fetch_via_api(cfg)
    if err:
        print("  ❌ 拉取失败：%s" % err)
        print("     检查：① 仓库名/分支名是否正确 ② 私有库是否配了 GITHUB_TOKEN")
        print("           ③ 跑 python github_sync.py --probe 看通道")
        return 1

    if os.path.isdir(INCOMING):
        shutil.rmtree(INCOMING)
    os.makedirs(INCOMING)
    zf = zipfile.ZipFile(io.BytesIO(raw))
    names = zf.namelist()
    # zipball/git 都会带一层顶层目录，剥掉它
    prefix = ""
    tops = {n.split("/")[0] for n in names if "/" in n}
    if len(tops) == 1:
        prefix = list(tops)[0] + "/"
    n = 0
    for name in names:
        if name.endswith("/"):
            continue
        rel = name[len(prefix):] if prefix and name.startswith(prefix) else name
        if not rel:
            continue
        dest = os.path.join(INCOMING, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as f:
            f.write(zf.read(name))
        n += 1
    print("  ✅ 已取回 %d 个文件 → %s" % (n, os.path.relpath(INCOMING, HERE)))
    print("     下一步：python github_sync.py --diff  （看差异，不改本地）")
    return 0


# ------------------------------------------------------------------ 4. diff

def do_diff(brief=False):
    cfg = load_config()
    ref = cfg.get("ref", "main")
    sec("4. 差异对比：_incoming/（远端） vs 本地工作区")

    if not os.path.isdir(INCOMING):
        print("  没有 _incoming/。先跑：python github_sync.py --pull")
        return 1

    remote = local_tree_hashes(INCOMING)
    local = local_tree_hashes(HERE)

    added = sorted(set(remote) - set(local))
    removed = sorted(set(local) - set(remote))
    changed = sorted(k for k in set(remote) & set(local) if remote[k] != local[k])

    # 契约文件清单，用于标出"这个改动需要重点看"
    contract_files = set()
    cpath = os.path.join(HERE, "contract.json")
    if os.path.isfile(cpath):
        c = json.loads(io.open(cpath, encoding="utf-8").read())
        contract_files = set(c.get("frozen_contracts", {}).keys())
    sensitive = {"build/parser.js", "build/app.js", "dist/server.py", "contract.json",
                 "db/DB_SCHEMA.sql", "migrations/001_init.sql", "build/make_app.py",
                 "verify.py", "build/theme.css", "build/app.css", "build/render.js",
                 "build/exporter.js"}

    if not (added or removed or changed):
        print("  ✅ 远端与本地完全一致 —— 没有需要同步的改动。")
        return 0

    def flag(f):
        marks = []
        if f in sensitive:
            marks.append("★敏感")
        if f == "build/parser.js":
            marks.append("含对外契约")
        if f == "build/app.js":
            marks.append("含身份列/键名契约")
        return ("  " + " ".join(marks)) if marks else ""

    if added:
        print("\n  远端有、本地没有（新增） %d 个：" % len(added))
        for f in added:
            print("    + %-44s%s" % (f, flag(f)))
    if changed:
        print("\n  两边都有但内容不同（远端已改） %d 个：" % len(changed))
        for f in changed:
            print("    ~ %-44s%s" % (f, flag(f)))
    if removed:
        print("\n  本地有、远端没有（远端删了） %d 个：" % len(removed))
        for f in removed:
            print("    - %-44s" % f)

    print()
    print("  重点看这几类（改错了 verify.py 会拦，但先看懂更省事）：")
    print("    · build/parser.js  → Excel sheet 契约，改了会让已交付客户的模板失效")
    print("    · build/app.js     → insert 字段集 / localStorage 键名 / 名额限制")
    print("    · dist/server.py   → 坏链接兜底与 /.cloud 是否被遮蔽")
    print("    · db/ migrations/  → 需要同步写迁移并在 WorkBuddy 侧执行")
    print()
    print("  下一步：")
    print("    python github_sync.py --show <文件>     看某个文件的远端内容")
    print("    python github_sync.py --apply          接受远端改动（先自动备份）")
    return 0


def do_show(rel):
    src = os.path.join(INCOMING, rel.replace("/", os.sep))
    if not os.path.isfile(src):
        print("  _incoming/ 里没有 %s" % rel)
        return 1
    dst = os.path.join(HERE, rel.replace("/", os.sep))
    sec("远端内容：%s" % rel)
    if not os.path.isfile(dst):
        print("（本地无此文件，以下是远端全文）")
        print(io.open(src, encoding="utf-8", errors="replace").read())
        return 0
    import difflib
    old = io.open(dst, encoding="utf-8", errors="replace").read().splitlines()
    new = io.open(src, encoding="utf-8", errors="replace").read().splitlines()
    diff = list(difflib.unified_diff(old, new, "本地", "远端", lineterm="", n=3))
    if not diff:
        print("  无差异")
    else:
        print("\n".join(diff))
    return 0


# ------------------------------------------------------------------ 5. apply

def do_apply():
    sec("5. 应用远端改动到本地工作区")
    if not os.path.isdir(INCOMING):
        print("  没有 _incoming/。先跑 --pull")
        return 1
    remote = local_tree_hashes(INCOMING)
    local = local_tree_hashes(HERE)
    targets = sorted((set(remote) - set(local)) | {k for k in set(remote) & set(local) if remote[k] != local[k]})
    if not targets:
        print("  ✅ 无差异，不需要应用。")
        return 0

    ts = time.strftime("%Y%m%d_%H%M%S")
    bdir = os.path.join(BACKUP, ts)
    print("  将写入 %d 个文件；被覆盖的原文件备份到 _backup/%s/" % (len(targets), ts))
    for f in targets:
        print("    → %s" % f)
    print()
    ans = input("  确认应用？输入 y 继续（其它任意键取消）：").strip().lower()
    if ans != "y":
        print("  已取消，本地未改动。")
        return 0

    for rel in targets:
        src = os.path.join(INCOMING, rel.replace("/", os.sep))
        dst = os.path.join(HERE, rel.replace("/", os.sep))
        if os.path.isfile(dst):
            bk = os.path.join(bdir, rel.replace("/", os.sep))
            os.makedirs(os.path.dirname(bk), exist_ok=True)
            shutil.copy2(dst, bk)
        os.makedirs(os.path.dirname(dst) or HERE, exist_ok=True)
        shutil.copy2(src, dst)
    print("  ✅ 已应用 %d 个文件。备份：%s" % (len(targets), os.path.relpath(bdir, HERE)))
    print()
    print("  下一步必做：")
    print("    python verify.py      ← 必须全绿才谈部署")
    return 0


# ------------------------------------------------------------------ 6. push

def git_push(message):
    cfg = load_config()
    repo = cfg.get("repo")
    env = {"GIT_SSH_COMMAND": SSH443}
    if not os.path.isdir(os.path.join(HERE, ".git")):
        c, o = run(["git", "init", "-b", cfg.get("ref", "main")])
        print("  git init：%s" % (o or "ok"))
        run(["git", "remote", "add", "origin", git_remote_url(cfg)])
    run(["git", "add", "-A"])
    c, o = run(["git", "-c", "user.name=WorkBuddy", "-c", "user.email=workbuddy@local",
                "commit", "-m", message])
    print("  commit：%s" % (o.splitlines()[0] if o else ""))
    c, o = run(["git", "push", "-u", "origin", cfg.get("ref", "main")],
               env_extra=env, timeout=300, retry_net=4)
    if c == 0:
        print("  ✅ 已推送到 https://github.com/%s" % repo)
        return 0
    print("  ⚠️ git push 失败：%s" % o.splitlines()[0][:160])
    return 1


def api_push(message):
    """用 Git Data API 生成一个真实 commit（不依赖 SSH 密钥）。"""
    cfg = load_config()
    repo, ref = cfg["repo"], cfg.get("ref", "main")
    base = "https://api.github.com/repos/%s/git" % repo
    H = api_headers()
    if not token():
        return 1, "未配置 GITHUB_TOKEN"

    code, raw, _ = http("%s/ref/heads/%s" % (base, ref), headers=H)
    if code != 200:
        return 1, "读 ref 失败 http=%s" % code
    parent = json.loads(raw)["object"]["sha"]
    code, raw, _ = http("%s/commits/%s" % (base, parent), headers=H)
    if code != 200:
        return 1, "读 commit 失败 http=%s" % code
    base_tree = json.loads(raw)["tree"]["sha"]

    tree = []
    try:
        publish_files = git_publish_files()
    except RuntimeError as e:
        return 1, str(e)
    for rel in publish_files:
        full = os.path.join(HERE, rel.replace("/", os.sep))
        if not os.path.isfile(full):
            continue
        code, raw, _ = http("%s/blobs" % base, method="POST", headers=H,
                            data={"content": base64.b64encode(open(full, "rb").read()).decode(),
                                  "encoding": "base64"})
        if code not in (200, 201):
            return 1, "建 blob 失败 %s http=%s" % (rel, code)
        tree.append({"path": rel.replace("\\", "/"), "mode": "100644", "type": "blob",
                     "sha": json.loads(raw)["sha"]})
    code, raw, _ = http("%s/trees" % base, method="POST", headers=H,
                        data={"base_tree": base_tree, "tree": tree})
    if code not in (200, 201):
        return 1, "建 tree 失败 http=%s" % code
    new_tree = json.loads(raw)["sha"]
    code, raw, _ = http("%s/commits" % base, method="POST", headers=H,
                        data={"message": message, "tree": new_tree, "parents": [parent]})
    if code not in (200, 201):
        return 1, "建 commit 失败 http=%s" % code
    new_commit = json.loads(raw)["sha"]
    code, raw, _ = http("%s/refs/heads/%s" % (base, ref), method="PATCH", headers=H,
                        data={"sha": new_commit, "force": False})
    if code not in (200, 201):
        return 1, "更新 ref 失败 http=%s（可能被分支保护挡住）" % code
    return 0, new_commit[:7]


def do_push(message):
    sec("6. 推送本地改动到 GitHub")
    cfg = load_config()
    if not cfg.get("repo"):
        print("  ⚠️ 未配置仓库。跑：python github_sync.py --init owner/repo")
        return 1
    if not message:
        print("  ⚠️ 必须给提交说明：--push -m \"改了什么\"")
        return 1

    print("  步骤：先把改动同步到 dist/ 并跑门禁，再提交。")
    c, o = run([sys.executable, "verify.py"])
    if c != 0:
        print(o.strip().splitlines()[-3:] and "\n".join(o.strip().splitlines()[-8:]))
        print("  ❌ verify.py 未通过 —— 不要推送未验证的代码。先修完再推。")
        return 1
    print("  ✅ 门禁通过")

    has_key = has_ssh_key()
    if os.path.isdir(os.path.join(HERE, ".git")) or has_key:
        rc = git_push(message)
        if rc == 0:
            return 0
        print("  改用 API 模式重试（Git Data API）…")
    else:
        print("  无 SSH 密钥 → 用 API 模式（Git Data API）")

    rc, info = api_push(message)
    if rc == 0:
        print("  ✅ 已通过 API 推送，新 commit：%s" % info)
        return 0
    print("  ❌ 推送失败：%s" % info)
    print("     替代方案：配 SSH 密钥（--setup-guide），或用 WorkBuddy 的 GitHub 连接器。")
    return 1


# ------------------------------------------------------------------ 其他

def do_init(repo, ref):
    cfg = {"repo": repo, "ref": ref, "provider": "github",
           "_note": "本文件可提交到版本库，不含任何密钥。Token 走环境变量 GITHUB_TOKEN 或 .env。"}
    with io.open(CONFIG, "w", encoding="utf-8") as f:
        f.write(json.dumps(cfg, ensure_ascii=False, indent=2) + "\n")
    print("  ✅ 已写入 github.json：repo=%s ref=%s" % (repo, ref))
    print("     接着跑：python github_sync.py --probe")
    return 0


def do_setup_guide():
    sec("GitHub 协同配置指引")
    say("""  本机实测：GitHub 的各条通道**可达性抖动** —— 同一个域名几分钟内能从 0/6 变 6/6。
  所以任何单次失败都不代表"用不了"。脚本内置指数退避重试；若仍然频繁失败，
  建议改用连接器（方案 C），或在本机挂一个稳定的代理。
  先跑 `python github_sync.py --probe` 看待测通道的实时成功率，再选方案。

  三条通道，按稳健度排序：C（连接器）> B（API+Token）> A（SSH 密钥）。

  ── 方案 A：git over SSH（功能最全：分支/历史/合并都正常） ──────────
  第一次要做的（在 Git Bash 里跑）：

    # 1) 生成密钥（一路回车，可设空密码）
    ssh-keygen -t ed25519 -C "workbuddy-<你的邮箱>" -f ~/.ssh/id_ed25519

    # 2) 打印公钥，整段复制
    cat ~/.ssh/id_ed25519.pub

    # 3) 打开 https://github.com/settings/keys → New SSH key → 粘贴 → 保存

    # 4) 写 ~/.ssh/config（让 git 自动走 443，因为 22 端口更容易被挡）
    cat >> ~/.ssh/config <<'EOF'
    Host github.com
      HostName ssh.github.com
      Port 443
      User git
      IdentityFile ~/.ssh/id_ed25519
    EOF

    # 5) 验证（出现 "Hi xxx! You've successfully authenticated" 就成了）
    ssh -T git@github.com

  然后本脚本自动走 git 模式，clone/pull/push 都正常。

  ── 方案 B：API + Token（不想碰密钥就用这个） ──────────────────────
    # 1) https://github.com/settings/tokens → Fine-grained token
    #    权限：Contents = Read and write（只读就选 Read）
    # 2) 写进 .env（已被 .gitignore 忽略，不会进版本库）
    echo 'GITHUB_TOKEN=ghp_xxxxxxxx' >> .env

  读：zipball 整库、contents 单文件；写：Git Data API（会生成真实 commit）。

  ── 方案 C：WorkBuddy 的 GitHub 连接器（最省事） ───────────────────
    在 WorkBuddy 里装上 GitHub 连接器并授权，之后用自然语言就能
    "读仓库 / 拉改动 / 推提交 / 看 PR"，不需要本机配密钥或 token。

  ── 配好后 ────────────────────────────────────────────────────────
    python github_sync.py --init owner/repo --ref main
    python github_sync.py --probe
    python github_sync.py --status
""")
    return 0


def main():
    p = argparse.ArgumentParser(add_help=True, description="GitHub 协同同步（读取为主，非破坏性）")
    p.add_argument("--probe", action="store_true", help="连通性体检")
    p.add_argument("--status", action="store_true", help="三方状态")
    p.add_argument("--pull", action="store_true", help="拉远端到 _incoming/（不改本地）")
    p.add_argument("--api", action="store_true", help="--pull 时强制用 API 模式")
    p.add_argument("--diff", action="store_true", help="比对 _incoming/ 与本地")
    p.add_argument("--show", metavar="FILE", help="打印某文件的远端内容与差异")
    p.add_argument("--apply", action="store_true", help="把 _incoming/ 应用到本地（先备份）")
    p.add_argument("--push", action="store_true", help="提交并推送本地改动")
    p.add_argument("-m", "--message", default="", help="--push 的提交说明")
    p.add_argument("--init", metavar="OWNER/REPO", help="写入 github.json")
    p.add_argument("--ref", default="main", help="分支名（默认 main）")
    p.add_argument("--setup-guide", action="store_true", help="配置指引")
    a = p.parse_args()

    if a.init:
        return do_init(a.init, a.ref)
    if a.setup_guide:
        return do_setup_guide()
    if a.probe:
        return do_probe()
    if a.status:
        return do_status()
    if a.pull:
        return do_pull(force_api=a.api)
    if a.show:
        return do_show(a.show)
    if a.diff:
        return do_diff()
    if a.apply:
        return do_apply()
    if a.push:
        return do_push(a.message)

    print(__doc__)
    return 0


if __name__ == "__main__":
    sys.exit(main())
