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
    """找出所有 .insert({ ... }) / .upsert({ ... }) 的顶层键名，返回 [(行号, [键名...])]。

    需要正确跨大括号匹配：datasets 那条 insert 是多行的。
    ⚠️ 键名允许带引号 —— 否则 `"owner_id": x` 这种写法能绕过哨兵。
    """
    out = []
    for m in re.finditer(r"\.(?:insert|upsert)\(\s*\{", src):
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
            km = re.match(r"\s*[\"']?([A-Za-z_$][\w$]*)[\"']?\s*:", kv)
            if km:
                names.append(km.group(1))
        out.append((line, names))
    return out


def strip_sql_comments(sql):
    """去掉 -- 行注释，供清单类提取使用。

    ⚠️ 提取器扫的是**全文**，注释里只要拼出完整的 `CREATE POLICY xxx` 就会被
    当成真语句（2026-09-21 加 002 时踩到：注释里解释"PostgreSQL 没有
    CREATE POLICY IF NOT EXISTS 写法"，结果抓出一个名为 IF 的策略）。
    注释是给人读的，不该影响门禁判据。
    """
    return "\n".join(ln.split("--")[0] for ln in sql.splitlines())


def extract_policies(sql):
    return sorted(set(re.findall(r"CREATE\s+POLICY\s+(\w+)", strip_sql_comments(sql))))


def extract_tables(sql):
    return sorted(set(re.findall(r"CREATE\s+TABLE\s+(?:public\.)?(\w+)", strip_sql_comments(sql))))


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
    # ⚠️ 哨兵是**结构化**的：只解析 .insert/.upsert 紧跟着的对象字面量，不做全文搜字符串。
    #    因为 build/projects.js 里的 IDENTITY_COLS 数组本身就含有
    #    'owner_id' / 'created_by' 这两个字面量，全文搜必然假红。
    # ⚠️ 结构化扫描有个盲区：字段集若是函数拼出来的（projects.js 的 insertRows/upsertRows
    #    调 fieldsOf()），就扫不到任何字面量。那一侧的守卫交给
    #    `node build/check_projects.js` 的「库字段 6 条」——它断言 fieldsOf 的键集
    #    既不含身份列、又与 COLS 一一对应。两道互补，缺一不可。
    # 后面 6.3/6.4 还要用 app.js 的源码，这里先取出来复用（别在循环里改名把它丢了）
    appjs = rd("build", "app.js")
    for fname in ("app.js", "projects.js"):
        fsrc = appjs if fname == "app.js" else rd("build", fname)
        if fsrc is None:
            bad("缺少 build/" + fname)
            continue
        inserts = find_insert_objects(fsrc)
        if not inserts:
            if fname == "app.js":
                bad("app.js 里找不到任何 .insert(...) —— 契约无法校验")
            else:
                info("%s 里没有字面量 insert（字段由 fieldsOf() 拼装，"
                     "身份列守卫见 check_projects.js 的「库字段」断言）" % fname)
            continue
        info("%s 扫到 %d 处 insert：%s" % (
            fname, len(inserts),
            "；".join("#L%d [%s]" % (ln, ",".join(ks)) for ln, ks in inserts)))
        offenders = []
        for ln, keys in inserts:
            for f in fc["forbidden_insert_columns"]:
                if f in keys:
                    offenders.append("%s L%d 的 insert 里出现了 %s" % (fname, ln, f))
        if offenders:
            bad("客户端 insert 携带了身份列（会造成线上 invalid input syntax 事故）",
                "\n".join(offenders) + "\n身份必须交给列默认值 auth.uid() 生成，客户端不要传。")
        else:
            ok("%s 的 insert 字段集干净（不含 %s）" % (fname, "、".join(fc["forbidden_insert_columns"])))

    # ---- 6.2b 存储层确实在云端（需求「数据保存到服务器而非本地」的回归哨兵）----
    # 防的是这条需求静默回退：有人把 load/save 改回 localStorage，功能照跑、测试照绿，
    # 但数据又变回"只在这台机器上"。这里从源码形态上把它钉住。
    projs = rd("build", "projects.js")
    if projs is None:
        bad("缺少 build/projects.js")
    else:
        m = re.search(r"var\s+TABLE\s*=\s*['\"](\w+)['\"]", projs)
        if m and m.group(1) in fc["db_tables"]:
            ok("projects.js 的数据表 %s 在契约 db_tables 内" % m.group(1))
        else:
            bad("projects.js 的数据表不在契约 db_tables 内",
                "源码取到：%s\n契约：%s" % (m.group(1) if m else "（没找到 TABLE 常量）",
                                        ", ".join(fc["db_tables"])))
        cloud_calls = re.findall(r"\.from\(\s*TABLE\s*\)", projs)
        ls_full = re.findall(r"localStorage\.setItem\(\s*LS_KEY", projs)
        if len(cloud_calls) >= 5 and not ls_full:
            ok("projects.js 读写全走云表（%d 处），无本地全量写入" % len(cloud_calls))
        else:
            bad("projects.js 的存储层不在云端，「数据保存到服务器」这条需求未生效",
                "云表调用 %d 处（期望 ≥5）；对 LS_KEY 的全量写入 %d 处（期望 0）"
                % (len(cloud_calls), len(ls_full)))

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

    # ---- 6.5 数据库策略（迁移汇总 + 结构文档 + 一致性）----
    # 契约描述的是**最终状态**，而最终状态是「001 + 002 + …」全部迁移叠加的结果。
    # ⚠️ 所以要对 migrations/ 下**全部** *.sql 取并集再比 —— 2026-09-21 加了 002
    # 之后才发现旧写法（只读 001）会与「001 已应用、不要再改」的铁律互相打架：
    # 不动 001 就永远差一条策略，改 001 又会让老环境与新环境分叉。
    # 并集还顺带获得一个好处：迁移之间重复建同名策略（会 42710 报错）能被查出来。
    mig_files = sorted(os.path.join(HERE, "migrations", f)
                       for f in os.listdir(os.path.join(HERE, "migrations"))
                       if f.endswith(".sql"))
    if not mig_files:
        bad("migrations/ 下没有找到任何 .sql")
    agg_pol, agg_tab, dup_pol = set(), set(), set()
    for path in mig_files:
        t = open(path, encoding="utf-8").read()
        # ⚠️ 必须复用 extract_policies（它带 CREATE 前缀）——
        # 自己写 `CREATE\s+POLICY\s+(\w+)` 的近似版会漏掉前缀，
        # 把 `DROP POLICY IF EXISTS foo` 里的 IF 当成策略名（2026-09-21 踩过）。
        for n in extract_policies(t):
            if n in agg_pol:
                dup_pol.add(n)
            agg_pol.add(n)
        agg_tab.update(extract_tables(t))
    if dup_pol:
        bad("迁移之间有重复的 CREATE POLICY（重跑会报 42710 策略已存在）",
            "重复：%s" % ", ".join(sorted(dup_pol)))
    mig_pol, mig_tab = sorted(agg_pol), sorted(agg_tab)
    if mig_pol == fc["db_policies"]:
        ok("migrations/*.sql 汇总策略一致（%d 条 / %d 个文件）" % (len(mig_pol), len(mig_files)))
    else:
        bad("migrations/*.sql 汇总后的策略清单与契约不符",
            "契约：%s\n实际：%s" % (", ".join(fc["db_policies"]), ", ".join(mig_pol)))
    if mig_tab == fc["db_tables"]:
        ok("migrations/*.sql 汇总表清单一致（%d 张）" % len(mig_tab))
    else:
        bad("migrations/*.sql 汇总后的表清单与契约不符",
            "契约：%s\n实际：%s" % (", ".join(fc["db_tables"]), ", ".join(mig_tab)))

    schema_t = rd("db", "DB_SCHEMA.sql")
    if schema_t is None:
        bad("缺少 db/DB_SCHEMA.sql")
    else:
        pol, tabs = extract_policies(schema_t), extract_tables(schema_t)
        if pol == fc["db_policies"]:
            ok("db/DB_SCHEMA.sql 策略一致（%d 条）" % len(pol))
        else:
            bad("db/DB_SCHEMA.sql 的策略清单与契约不符",
                "契约：%s\n实际：%s" % (", ".join(fc["db_policies"]), ", ".join(pol)))
        if tabs == fc["db_tables"]:
            ok("db/DB_SCHEMA.sql 表清单一致（%d 张）" % len(tabs))
        else:
            bad("db/DB_SCHEMA.sql 的表清单与契约不符",
                "契约：%s\n实际：%s" % (", ".join(fc["db_tables"]), ", ".join(tabs)))
        # 迁移汇总与结构文档必须同步，否则文档与实际会分叉
        if mig_pol == pol:
            ok("migrations/*.sql 汇总 与 db/DB_SCHEMA.sql 策略同步")
        else:
            bad("迁移汇总与结构文档的策略不一致（改一处忘改另一处）",
                "migrations/*.sql 汇总：%s\ndb/DB_SCHEMA.sql: %s" % (", ".join(mig_pol), ", ".join(pol)))

    # ---- 6.5b 列级授权一致性（access_grants 的 UPDATE 权限）----
    # 2026-09-21 加 002 时踩到的坑：策略只管"行"，GRANT 才管"列"。两者必须各就各位。
    # 只用一条正则查"某列是否被授出"，因为这里的失效模式是**静默**的：
    #   · 只授 last_seen_at → 心跳正常，但运营台「开通/暂停」按钮报 42501（当时险些上线）
    #   · 表级 GRANT UPDATE 复活 → 客户可自助改 status 提权（安全底线失守）
    # 两种都不报错、不崩页面，只能靠门禁拦。
    grant_src = "".join(open(p, encoding="utf-8").read() for p in mig_files) + "\n" + (schema_t or "")

    def has_col_grant(col):
        return re.search(r"GRANT\s+UPDATE\s*\([^)]*\b%s\b[^)]*\)\s*ON\s+public\.access_grants"
                         % re.escape(col), grant_src, re.I) is not None

    table_level = re.search(r"GRANT\s+UPDATE\s+ON\s+public\.access_grants", grant_src, re.I)
    if table_level:
        bad("access_grants 存在表级 GRANT UPDATE —— 客户可自助改 status / expires_at 提权",
            "命中：%s\n应改为列级 GRANT UPDATE (…)，并把行边界交给 RLS 策略。"
            % table_level.group(0))
    else:
        ok("access_grants 无表级 UPDATE 授权（已收口为列级）")

    if has_col_grant("last_seen_at"):
        ok("access_grants 授予了 last_seen_at 列（心跳可写）")
    else:
        bad("access_grants 未授予 last_seen_at 列 —— 心跳会恒 42501 且被前端静默吞掉")

    # 运营台走的是同一个 authenticated 角色，它的 update(patch) 必须能落到这些列上。
    # 缺任意一列 ⇒ 运营台自己先挂（这是当时差点漏掉的那条）。
    op_cols = ["status", "plan", "expires_at", "updated_at", "note"]
    lack = [c for c in op_cols if not has_col_grant(c)]
    if not lack:
        ok("access_grants 授予了运营台改状态所需的 %d 列" % len(op_cols))
    else:
        bad("access_grants 缺少运营台所需的列级 UPDATE 授权",
            "缺：%s\n运营台与客户共用 authenticated 角色，缺列会让「开通/暂停」按钮报 42501。"
            % ", ".join(lack))

    # 反向：提权面列绝不能被授出
    for danger in ["owner_id", "id", "created_at"]:
        if has_col_grant(danger):
            bad("access_grants 非法授予了提权面列 %s 的 UPDATE 权限" % danger)
        else:
            ok("access_grants 未授予提权面列 %s" % danger)

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

    # ---- 热点推荐数据源：改了源文件忘了构建（或忘了进白名单）会静默发旧数据 ----
    # 为什么必须查：这个文件是**每晚由脚本重写**的，最容易出现「本地更新了、
    # dist/ 还是昨天的」。而它只在页面上以「更新于 X」呈现，肉眼很难发现是旧的。
    src = os.path.join(HERE, "assets", "hot-projects.json")
    dst = os.path.join(HERE, "dist", "assets", "hot-projects.json")
    if not os.path.isfile(src):
        bad("assets/hot-projects.json 不存在 —— 热点推荐会没有数据",
            "跑 python build/refresh_hot.py 生成。")
    else:
        try:
            feed = json.loads(io.open(src, encoding="utf-8").read())
        except Exception as e:
            feed = None
            bad("assets/hot-projects.json 不是合法 JSON —— 前端会静默显示「没读到」", str(e)[:160])
        if feed is not None:
            items = feed.get("items")
            if not isinstance(feed.get("updated_at"), str) or not feed.get("updated_at"):
                bad("热点数据缺 updated_at —— 页面上「更新于」会是空的")
            elif not isinstance(items, list) or not items:
                bad("热点数据的 items 为空 —— 白跑一次抓取，页面上没有内容")
            else:
                need = ("name", "url", "category", "stars", "found_at")
                broken = [x.get("name") or "?" for x in items
                          if not isinstance(x, dict) or any(k not in x for k in need)]
                if broken:
                    bad("热点数据有 %d 条缺必填字段（%s）—— 收进个人库会落成空行"
                        % (len(broken), ", ".join(broken[:3])), "必填：" + "/".join(need))
                else:
                    ok("热点数据合法（%d 个项目，更新于 %s）"
                       % (len(items), feed["updated_at"]))
                if not os.path.isfile(dst):
                    bad("dist/assets/hot-projects.json 缺失 —— 线上拿不到热点数据",
                        "检查 build/make_app.py 的 assets 白名单是否包含 hot-projects.json。")
                elif open(src, "rb").read() == open(dst, "rb").read():
                    ok("dist/assets/hot-projects.json 与源文件逐字节一致")
                else:
                    bad("dist/assets/hot-projects.json 与源文件不一致 —— 线上会是旧数据",
                        "重新运行 python verify.py 触发重建。")


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
