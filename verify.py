# -*- coding: utf-8 -*-
"""回传门禁：Codex（或任何外部环境）改完代码后，跑这一个脚本就能判断「能不能拿去部署」。

为什么需要它
------------
项目是「单文件 HTML + 一个静态服务器」，没有类型系统、没有 linter、没有 CI。
最危险的不是写错语法（那会立刻报错），而是**静默破坏对外契约**：

  · 动了 parser.js 的 SHEETS 列表 → 已交付客户的 Excel 模板突然少渲染一块，不报错；
  · 在 insert 里又加回 created_by → 又一次 invalid input syntax for type uuid 线上事故；
  · 改了通知的 localStorage 键名 → 所有老用户的「已读/已弹」记录凭空消失；
  · 动了 dist/server.py → 坏链接兜底或 /.cloud 网关遮蔽，线上才暴露。

这些都不会在本地开发时被发现，所以必须用机器检查代替人工 review。

它做什么
--------
  1. 环境检查（Python / node / Chrome 是否可用，缺哪个会影响哪项）
  2. 依赖校验（vendor/ 与 deps.lock.json 的 SHA-256 是否一致）
  3. 重建应用（build/make_app.py）
  4. 产物检查（index.html 存在、体积合理、3 个依赖 script 都在）
  5. 静态自检（check_hazard / check_wiring / probe_scripts）
  6. **契约检查**（contract.json，本文档的核心）
  7. 部署目录同步检查（dist/index.html 与 index.html 是否一致）

用法
----
  python verify.py            跑全部检查
  python verify.py --quick    跳过依赖下载相关与 node 依赖项（离线环境用）

退出码：0 = 全部通过（可以部署）；1 = 有 FAIL（不要部署）
"""
import hashlib
import io
import json
import os
import re
import subprocess
import sys

# Windows PowerShell may expose a legacy GBK console.  Force UTF-8 so this
# script and the child checks can safely print Chinese text and status marks.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
CONTRACT = os.path.join(HERE, "contract.json")

FAILS = []
WARNS = []
PASSES = 0


# ------------------------------------------------------------------ 输出工具

def sec(t):
    print("\n" + "=" * 78)
    print("  " + t)
    print("=" * 78)


def ok(msg):
    global PASSES
    PASSES += 1
    print("  [OK]   " + msg)


def bad(msg, detail=None):
    FAILS.append(msg)
    print("  [FAIL] " + msg)
    if detail:
        for line in str(detail).splitlines():
            print("         " + line)


def warn(msg):
    WARNS.append(msg)
    print("  [WARN] " + msg)


def info(msg):
    print("  [ .. ] " + msg)


def rd(*parts):
    p = os.path.join(HERE, *parts)
    if not os.path.isfile(p):
        return None
    with io.open(p, encoding="utf-8", errors="replace") as f:
        return f.read()


def sha256_file(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def run(cmd, cwd=None):
    env = os.environ.copy()
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    r = subprocess.run(cmd, cwd=cwd or HERE, env=env, capture_output=True, text=True,
                       encoding="utf-8", errors="replace")
    return r.returncode, (r.stdout or "") + (r.stderr or "")


def eval_int_expr(expr):
    """只允许 数字 /空格/*/+/- 的极简表达式求值（避免 eval）。"""
    e = re.sub(r"\s+", "", expr)
    if not re.fullmatch(r"[0-9+\-*]+", e):
        return None
    try:
        return eval(e, {"__builtins__": {}}, {})
    except Exception:
        return None


# ------------------------------------------------------------------ 提取工具

def extract_js_array(src, varname):
    m = re.search(r"var\s+%s\s*=\s*\[(.*?)\]\s*;" % re.escape(varname), src, re.S)
    if not m:
        return None
    return re.findall(r"'([^']*)'", m.group(1))


def find_insert_objects(src):
    """找出所有 .insert({ ... }) 的顶层键名，返回 [(行号, [键名...])]。

    需要正确跨大括号匹配：datasets 那条 insert 是多行的。
    """
    out = []
    for m in re.finditer(r"\.insert\(\s*\{", src):
        start = src.index("{", m.start())
        depth, i = 0, start
        while i < len(src):
            c = src[i]
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    break
            i += 1
        obj = src[start:i + 1]
        line = src[:start].count("\n") + 1
        # 只取深度 1 的键
        keys, depth, buf = [], 0, ""
        for c in obj[1:-1]:
            if c in "{([":
                depth += 1
            if c in "})]":
                depth -= 1
            if c == "," and depth == 0:
                keys.append(buf)
                buf = ""
            else:
                buf += c
        keys.append(buf)
        names = []
        for kv in keys:
            km = re.match(r"\s*([A-Za-z_$][\w$]*)\s*:", kv)
            if km:
                names.append(km.group(1))
        out.append((line, names))
    return out


def extract_policies(sql):
    return sorted(set(re.findall(r"CREATE\s+POLICY\s+(\w+)", sql)))


def extract_tables(sql):
    return sorted(set(re.findall(r"CREATE\s+TABLE\s+(?:public\.)?(\w+)", sql)))


# ------------------------------------------------------------------ 各项检查

def check_env():
    sec("1. 环境检查")
    v = sys.version_info
    info("Python %d.%d.%d  (%s)" % (v.major, v.minor, v.micro, sys.executable))
    if v < (3, 8):
        bad("Python 版本过低（需要 >= 3.8）")
    else:
        ok("Python 版本满足要求")

    node = None
    for c in (os.environ.get("NODE_BIN"), r"C:\Users\27789\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"):
        if c and os.path.isfile(c):
            node = c
            break
    if not node:
        import shutil
        node = shutil.which("node")
    if node:
        info("node: %s" % node)
        ok("node 可用（script 块语法检查会真正执行）")
    else:
        warn("未找到 node —— probe_scripts.py 这项会跳过。装 node 后重跑可覆盖全部检查。")

    chrome = None
    for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
              r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"):
        if os.path.isfile(c):
            chrome = c
            break
    if chrome:
        info("Chrome: %s" % chrome)
    else:
        info("未找到 Chrome —— 端到端测试台与截图需要它，但本脚本不强制（可选）")


def check_deps(quick):
    sec("2. 依赖校验（vendor/ vs deps.lock.json）")
    lock = rd("deps.lock.json")
    if not lock:
        warn("没有 deps.lock.json，跳过")
        return
    d = json.loads(lock)
    for it in d.get("runtime_browser_deps", []):
        vp = os.path.join(HERE, it["vendor_path"])
        if not os.path.isfile(vp):
            bad("vendor 缺失：%s" % it["vendor_path"], "跑 python vendor_deps.py --fetch 重新下载")
            continue
        got = sha256_file(vp)
        if got == it["sha256"]:
            tag = "（浮动标签 @dev，锁定值）" if it.get("is_floating") else ""
            ok("%s  %s  sha256 一致%s" % (it["name"], it["resolved_version"], tag))
        else:
            if it.get("is_floating"):
                warn("%s（@dev 浮动标签）vendor 文件已变化：%s\n"
                     "         锁记录 %s\n         实际   %s\n"
                     "         → 这可能是 CDN 上的 dev 版本更新了。若是主动升级，请同步更新 deps.lock.json。"
                     % (it["name"], it["vendor_path"], it["sha256"], got))
            else:
                bad("%s sha256 不一致（固定版本号不该变）" % it["name"],
                    "期望 %s\n实际 %s" % (it["sha256"], got))


def check_build():
    sec("3. 重建应用（build/make_app.py）")
    code, out = run([sys.executable, os.path.join("build", "make_app.py")])
    if code != 0:
        bad("构建失败", out.strip()[-1500:])
        return False
    ok("构建成功：" + (out.strip().splitlines()[-1] if out.strip() else ""))
    return True


def check_artifact(quick):
    sec("4. 产物检查（index.html）")
    idx = os.path.join(HERE, "index.html")
    if not os.path.isfile(idx):
        bad("index.html 不存在")
        return False
    size = os.path.getsize(idx)
    info("index.html  %d 字节" % size)
    if size < 150000:
        bad("index.html 体积异常偏小（%d 字节），可能拼装不完整（正常约 240KB+）" % size)
    else:
        ok("体积正常")

    s = rd("index.html")
    for needle, label in [
        ("WorkBuddyCloud.createWorkBuddyCloud", "云服务 SDK 调用"),
        ("cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk", "SDK script 标签"),
        ("cdn.jsdelivr.net/npm/xlsx@", "SheetJS script 标签"),
        ("cdn.jsdelivr.net/npm/jszip@", "JSZip script 标签"),
        ("CuParser", "解析器已内联"),
        ("CuExport", "导出引擎已内联"),
    ]:
        if needle in s:
            ok("产物包含 %s" % label)
        else:
            bad("产物缺少 %s（找 %r）" % (label, needle))
    return True


def check_static(quick):
    sec("5. 静态自检")
    for script, label in [("check_hazard.py", "危险字符扫描（</script> 未转义）"),
                          ("check_wiring.py", "DOM id 接线一致性")]:
        code, out = run([sys.executable, os.path.join("build", script)])
        if code == 0:
            tail = [l for l in out.strip().splitlines() if l.strip()]
            ok("%s —— %s" % (label, tail[-1] if tail else "通过"))
        else:
            bad("%s 未通过" % label, out.strip()[-1200:])

    code, out = run([sys.executable, os.path.join("build", "probe_scripts.py"), "../index.html"])
    if code != 0 and "No such file" in out:
        warn("probe_scripts.py 无法运行（缺少 node？）—— 跳过 script 块检查")
    elif "BROKEN BLOCKS = 0" in out:
        ok("script 块完整性 —— 0 个断裂块")
    else:
        bad("script 块完整性未通过", out.strip()[-1500:])


def check_contract():
    sec("6. 契约检查（contract.json）—— 本脚本的核心")
    c = json.loads(rd("contract.json"))
    fc = c["frozen_contracts"]

    # ---- 6.1 Excel 契约 ----
    parser = rd("build", "parser.js")
    if parser is None:
        bad("缺少 build/parser.js")
    else:
        sheets = extract_js_array(parser, "SHEETS")
        if sheets is None:
            bad("parser.js 里找不到 var SHEETS = [...] 声明（契约无法校验）")
        elif sheets == fc["excel_sheets"]:
            ok("Excel sheet 契约一致（%d 个 sheet，顺序一致）" % len(sheets))
        else:
            only_old = [x for x in fc["excel_sheets"] if x not in sheets]
            only_new = [x for x in sheets if x not in fc["excel_sheets"]]
            bad("Excel sheet 契约被改动 —— 会让已交付客户的模板失效",
                "少了：%s\n多了：%s\n顺序变化：%s" % (
                    only_old or "无", only_new or "无",
                    "是" if (not only_old and not only_new) else "见上下两行"))

        kl = None
        hdr_ok = all(h in parser for h in fc["kline_header"])
        if hdr_ok:
            ok("KLINE 表头字段齐全（%s）" % "、".join(fc["kline_header"]))
        else:
            miss = [h for h in fc["kline_header"] if h not in parser]
            bad("KLINE 表头字段缺失：%s" % "、".join(miss),
                "客户 Excel 的 KLINE sheet 会解析不出数据")

    risk_parser = rd("build", "risk_parser.js")
    if risk_parser is None:
        bad("缺少 build/risk_parser.js")
    else:
        missing = []
        for group in fc.get("risk_log_required_headers", []):
            alternatives = group.split("|")
            if not any(h in risk_parser for h in alternatives):
                missing.append(group)
        if missing:
            bad("风险日志必填表头契约缺失：%s" % "、".join(missing))
        else:
            ok("风险日志必填表头契约一致")

    # ---- 6.2 身份列禁令（线上事故回归哨兵）----
    appjs = rd("build", "app.js")
    if appjs is None:
        bad("缺少 build/app.js")
    else:
        inserts = find_insert_objects(appjs)
        if not inserts:
            bad("app.js 里找不到任何 .insert(...) —— 契约无法校验")
        else:
            info("扫到 %d 处 insert：%s" % (
                len(inserts), "；".join("#L%d [%s]" % (ln, ",".join(ks)) for ln, ks in inserts)))
            offenders = []
            for ln, keys in inserts:
                for f in fc["forbidden_insert_columns"]:
                    if f in keys:
                        offenders.append("L%d 的 insert 里出现了 %s" % (ln, f))
            if offenders:
                bad("客户端 insert 携带了身份列（会造成线上 invalid input syntax 事故）",
                    "\n".join(offenders) + "\n身份必须交给列默认值 auth.uid() 生成，客户端不要传。")
            else:
                ok("insert 字段集干净（不含 %s）" % "、".join(fc["forbidden_insert_columns"]))

        # ---- 6.3 限额与键名 ----
        m = re.search(r"var\s+MAX_UPLOAD\s*=\s*([^;]+);", appjs)
        v = eval_int_expr(m.group(1)) if m else None
        if v == fc["max_upload_bytes"]:
            ok("上传上限一致（%d 字节）" % v)
        else:
            bad("上传上限被改动", "契约 %s，源码 %s" % (fc["max_upload_bytes"], v))

        m = re.search(r"var\s+RISK_MAX_UPLOAD\s*=\s*([^;]+);", appjs)
        v = eval_int_expr(m.group(1)) if m else None
        if v == fc.get("risk_log_max_upload_bytes"):
            ok("风险日志上传上限一致（%d 字节）" % v)
        else:
            bad("风险日志上传上限与契约不一致",
                "契约 %s，源码 %s" % (fc.get("risk_log_max_upload_bytes"), v))

        prefix = fc.get("risk_log_storage_prefix", "")
        if prefix and prefix in appjs:
            ok("风险日志存储目录一致（%s）" % prefix)
        else:
            bad("风险日志存储目录与契约不一致", "契约 %s" % prefix)

        m = re.search(r"var\s+SEND_COOLDOWN_MS\s*=\s*(\d+)", appjs)
        v = int(m.group(1)) if m else None
        if v == fc["send_cooldown_ms"]:
            ok("验证码冷却一致（%d 毫秒）" % v)
        else:
            bad("验证码冷却被改动", "契约 %s，源码 %s" % (fc["send_cooldown_ms"], v))

        m = re.search(r"body\.length\s*>\s*(\d+)", appjs)
        v = int(m.group(1)) if m else None
        if v == fc["notif_body_max_chars"]:
            ok("通知正文上限一致（%d 字）" % v)
        else:
            bad("通知正文上限被改动", "契约 %s，源码 %s" % (fc["notif_body_max_chars"], v))

        for which, expect in fc["ls_keys"].items():
            varname = "NOTIF_SEEN_KEY" if which == "seen" else "NOTIF_POPPED_KEY"
            m = re.search(r"var\s+%s\s*=\s*'([^']+)'" % varname, appjs)
            v = m.group(1) if m else None
            if v == expect:
                ok("localStorage 键 %s 一致（%s）" % (which, v))
            else:
                bad("localStorage 键 %s 被改动 —— 老用户的已读/已弹记录会全部丢失" % which,
                    "契约 %s，源码 %s" % (expect, v))

    # ---- 6.4 云服务凭据 ----
    if appjs:
        for key, label in [("endpoint", "云服务端点"), ("publishableKey", "publishableKey")]:
            expect = c["cloud"][key]
            if expect in appjs:
                ok("%s 未变" % label)
            else:
                bad("%s 被改动（会导致连不上云服务 / 换错环境）" % label,
                    "契约 %s" % expect)

    # ---- 6.5 数据库策略（两份文件 + 一致性）----
    sqls = {}
    for rel in ("migrations/001_init.sql", "db/DB_SCHEMA.sql"):
        t = rd(*rel.split("/"))
        if t is None:
            bad("缺少 %s" % rel)
            continue
        sqls[rel] = t
        pol = extract_policies(t)
        if pol == fc["db_policies"]:
            ok("%s 策略一致（%d 条）" % (rel, len(pol)))
        else:
            bad("%s 的策略清单与契约不符" % rel,
                "契约：%s\n实际：%s" % (", ".join(fc["db_policies"]), ", ".join(pol)))
        tabs = extract_tables(t)
        if tabs == fc["db_tables"]:
            ok("%s 表清单一致（%d 张）" % (rel, len(tabs)))
        else:
            bad("%s 的表清单与契约不符" % rel,
                "契约：%s\n实际：%s" % (", ".join(fc["db_tables"]), ", ".join(tabs)))
    # 两份文件必须同步，否则文档与可执行版本会分叉
    if len(sqls) == 2:
        a, b = (extract_policies(v) for v in sqls.values())
        if a == b:
            ok("migrations/001_init.sql 与 db/DB_SCHEMA.sql 策略同步")
        else:
            bad("迁移文件与结构文档的策略不一致（改一处忘改另一处）",
                "migrations: %s\ndb: %s" % (", ".join(a), ", ".join(b)))

    # ---- 6.6 部署服务器 ----
    sp = os.path.join(HERE, "dist", "server.py")
    if not os.path.isfile(sp):
        bad("缺少 dist/server.py")
    else:
        raw = open(sp, "rb").read()
        got = hashlib.sha256(raw).hexdigest()
        if got == fc["server_py_sha256"]:
            ok("dist/server.py 未被改动（sha256 一致）")
        else:
            bad("dist/server.py 被改动 —— 它决定坏链接兜底与 /.cloud 不被遮蔽两个线上行为",
                "契约 sha256 %s\n实际 sha256 %s\n字节 %d vs %d\n"
                "若确实需要改，请同时更新 contract.json，并在 docs/DEPLOY.md 记录原因。"
                % (fc["server_py_sha256"], got, len(raw), fc["server_py_bytes"]))
        s = raw.decode("utf-8", "replace")
        for needle in fc["server_must_block"]:
            if needle in s:
                ok("server.py 仍显式排除 %s（不遮蔽云服务网关）" % needle)
            else:
                bad("server.py 不再排除 %s —— 会把云服务接口遮蔽成 HTML" % needle)
        if "_serve_index" in s:
            ok("server.py 保留兜底路由（未命中路径回退 index.html）")
        else:
            bad("server.py 的兜底路由消失 —— 坏链接会暴露 Python 原生 404 页")


def check_dist_sync():
    sec("7. 部署目录同步检查")
    a = os.path.join(HERE, "index.html")
    b = os.path.join(HERE, "dist", "index.html")
    if not os.path.isfile(b):
        bad("dist/index.html 不存在（部署会上传空/旧内容）")
        return
    if open(a, "rb").read() == open(b, "rb").read():
        ok("dist/index.html 与 index.html 一致（可以部署）")
    else:
        bad("dist/index.html 与 index.html 不一致 —— 构建脚本没有同步部署产物",
            "重新运行 python verify.py；build/make_app.py 应同时生成两份产物。")


def _load_sync_module():
    """把 github_sync.py 作为模块载入，用于**功能性**校验（而非字符串匹配）。

    字符串匹配挡不住"看起来还在、其实已经坏了"的改动 —— 第一次写这节检查时
    就被自己绕过了：把 `GIT_CONFIG_KEY_%d` 改成 `GIT_CONFIG_KEY_DISABLED_%d`，
    子串断言照样通过，但运行时 git 会拿不到 safe.directory 而全面失败。
    所以这里直接 import 并调用真函数，断言它的**返回值**。
    """
    import importlib.util
    path = os.path.join(HERE, "github_sync.py")
    spec = importlib.util.spec_from_file_location("_wb_github_sync", path)
    mod = importlib.util.module_from_spec(spec)
    # 导入会顺带写出 __pycache__/github_sync.*.pyc —— 门禁不该有副作用，临时关掉。
    old = sys.dont_write_bytecode
    sys.dont_write_bytecode = True
    try:
        spec.loader.exec_module(mod)
    finally:
        sys.dont_write_bytecode = old
    return mod


def check_sync_channel():
    """校验两平台协同通道（GitHub 中转）本身没被改坏。

    为什么把它放进门禁：`github_sync.py` 是 Codex → WorkBuddy 的**唯一回传路径**。
    它一旦被删掉、写坏，或"优化"回已知不可靠的做法，回传就断了；而这种断法
    在业务代码上是看不出来的（verify 前七节全绿也照样断）。所以这里守三条不变量：
      ① 工具与文档存在，且脚本仍能被 Python 解析；
      ② `git_env_extra()` 真的注入了 safe.directory（否则本机 git 全命令失败）；
      ③ `git_remote_url()` 走 ssh://，不退化到 https（本机实测最不稳定的一条路）。
    ②③ 是调用真函数的**功能**断言，不是文本搜索 —— 改坏了就一定会红。
    """
    sec("8. 协同通道检查（GitHub 中转）")

    tool = os.path.join(HERE, "github_sync.py")
    if not os.path.isfile(tool):
        bad("github_sync.py 不存在 —— Codex 改完的源码没有回传通道了")
    else:
        try:
            compile(io.open(tool, encoding="utf-8").read(), "github_sync.py", "exec")
            ok("github_sync.py 存在且语法有效")
        except SyntaxError as e:
            bad("github_sync.py 语法错误（第 %s 行）：%s" % (e.lineno, e.msg),
                "回传工具坏了就跑不了 --pull/--diff/--apply，先修好再交付。")

    mod = None
    if os.path.isfile(tool):
        try:
            mod = _load_sync_module()
        except Exception as e:
            bad("github_sync.py 无法作为模块载入：%s" % e)

    if mod is not None:
        # ② safe.directory 必须真的注入（功能断言）
        try:
            env = mod.git_env_extra()
            n = int(env.get("GIT_CONFIG_COUNT") or 0)
            keys = [env.get("GIT_CONFIG_KEY_%d" % i) for i in range(n)]
            vals = [env.get("GIT_CONFIG_VALUE_%d" % i) for i in range(n)]
            if "safe.directory" in keys and any(v for v in vals):
                ok("git_env_extra() 真的注入 safe.directory（防 .git 属主不符导致 git 全失败）")
            else:
                bad("git_env_extra() 没有注入 safe.directory（keys=%s）" % keys,
                    "本机 .git 属主与当前用户不一致，缺了这条 git 会全命令失败、并连带打断 API 推送。")
        except Exception as e:
            bad("git_env_extra() 调用失败：%s" % e)

        # ③ 克隆必须走 ssh://（功能断言）
        try:
            url = mod.git_remote_url({"repo": "owner/repo"})
            if url.startswith("ssh://"):
                ok("git_remote_url() 走 ssh://（避开本机最不稳定的 https 克隆）")
            else:
                bad("git_remote_url() 返回了非 ssh 地址：%s" % url,
                    "https 直连克隆在本机实测常 0/3，改回 ssh://git@github.com/...")
        except Exception as e:
            bad("git_remote_url() 调用失败：%s" % e)

    docs = [("docs/GITHUB_SYNC.md", "协同说明"), ("AGENTS.md", "Codex 协作规则")]
    missing = [d for d, _ in docs if not os.path.isfile(os.path.join(HERE, d))]
    if missing:
        bad("协同文档缺失：%s" % "、".join(missing))
    else:
        ok("协同文档齐备（GITHUB_SYNC.md + AGENTS.md）")

    gi = os.path.join(HERE, ".gitignore")
    need = ["/_incoming/", "/_backup/", "/_gitclone_tmp/", ".env"]
    if not os.path.isfile(gi):
        bad(".gitignore 不存在（同步产物会被误提交）")
    else:
        gsrc = io.open(gi, encoding="utf-8").read()
        lack = [n for n in need if n not in gsrc]
        if lack:
            bad(".gitignore 未忽略：%s" % "、".join(lack),
                "同步产物/密钥若被提交会污染仓库，补上后再交付。")
        else:
            ok(".gitignore 覆盖同步产物与 .env")


# ------------------------------------------------------------------ 入口

def main(argv):
    quick = "--quick" in argv
    print("铜数据看板 · 订阅版 —— 回传门禁 verify.py")
    print("仓库：%s" % HERE)
    if quick:
        print("模式：--quick")

    check_env()
    check_deps(quick)
    built = check_build()
    if built:
        check_artifact(quick)
        check_static(quick)
    check_contract()
    check_dist_sync()
    check_sync_channel()
    sec("9. 期货工具箱缓存与路由回归")
    for name in ("server.py", "futures_service.py", "futures_seed.json"):
        source = os.path.join(HERE, "build", name)
        target = os.path.join(HERE, "dist", name)
        if os.path.isfile(target) and open(source, "rb").read() == open(target, "rb").read():
            ok("期货工具箱运行文件同步：" + name)
        else:
            bad("期货工具箱运行文件未同步：" + name)
    code, output = run([sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_futures.py", "-v"])
    if code == 0:
        ok("期货工具箱缓存、解析和路由回归通过")
    else:
        bad("期货工具箱回归失败", output)
    fc = json.load(open(os.path.join(HERE, "contract.json"), encoding="utf-8"))["frozen_contracts"]["futures_workspace"]
    js = open(os.path.join(HERE, "build", "futures.js"), encoding="utf-8").read()
    if fc["favorites_key_prefix"] in js and fc["snapshot_key_prefix"] in js:
        ok("期货工具箱新增 localStorage 键契约一致")
    else:
        bad("期货工具箱 localStorage 键契约被改动")

    # 前端标签 vs 后端抓取白名单：必须完全一致（含顺序，首个即默认分类）。
    # 只删一边的后果——留标签：点一下就 400；留后端：没人看的分类仍每 6 小时去抓一次。
    # 2026-09-18 下线「期货公司」「期货软件」时加这条，防止以后再出现半截改动。
    svc = rd("build", "futures_service.py") or ""
    m_backend = re.search(r"SOURCES = \{(.*?)\n\}", svc, re.S)
    m_front = re.search(r"var categories = \[(.*?)\];", js, re.S)
    backend = re.findall(r"'([a-z][a-z0-9_]*)': \(", m_backend.group(1)) if m_backend else []
    front = re.findall(r"\['([a-z][a-z0-9_]*)'", m_front.group(1)) if m_front else []
    if backend and backend == front:
        ok("期货工具箱分类一致（前端标签 == 后端抓取白名单）：%s" % "/".join(backend))
    else:
        bad("期货工具箱分类不一致：前端 %s / 后端 %s" % (front or "解析失败", backend or "解析失败"),
            "两侧必须同时增删；只改一边会出现「标签点了就 400」或「无人访问仍在抓取」。")

    sec("结论")
    print("  通过 %d 项 / 警告 %d 项 / 失败 %d 项" % (PASSES, len(WARNS), len(FAILS)))
    if WARNS:
        print("\n  警告（不阻塞部署，但建议看一眼）：")
        for w in WARNS:
            print("    · " + w.splitlines()[0])
    if FAILS:
        print("\n  ❌ 失败项（**不要部署**，先修完再跑一遍）：")
        for f in FAILS:
            print("    · " + f)
        print("\n  提示：失败项分两类 ——")
        print("    · 「契约」类：说明你改了对外承诺。要么改回代码，要么按 docs/HANDOFF.md")
        print("      的流程正式变更契约（改代码 + 改 contract.json + 写迁移 + 通知客户）。")
        print("    · 「工程」类：构建/自检/同步问题，按上面给出的命令修即可。")
        return 1

    print("\n  ✅ 全部通过。下一步：")
    print("     然后在 WorkBuddy 里说「覆盖上线」→ 部署 dist/ 目录")
    print("     部署后按 docs/DEPLOY.md 的验收清单逐条 curl 复核")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
