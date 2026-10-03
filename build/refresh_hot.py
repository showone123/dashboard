# -*- coding: utf-8 -*-
"""抓取 GitHub 升星最快的项目 → assets/hot-projects.json

存在意义：把"每晚找新星"这件事从"靠模型临场刮网页"变成一条**确定性命令**。
模型只负责它擅长的部分（一句话中文简介 + 商业价值判断），取数/去重/分类交给脚本。

用法：
    python build/refresh_hot.py                          # 抓日榜+周榜，写 assets/hot-projects.json
    python build/refresh_hot.py --top 24                 # 取前 N 个（默认 20）
    python build/refresh_hot.py --biz _verify/biz.json   # 叠加中文简介/商业价值（模型产出）
    python build/refresh_hot.py --dry-run                # 只打印不落盘（排查用）

--biz 覆盖文件格式（键是 owner/repo，三个字段都可选）：
    {"obra/superpowers": {"zh": "中文一句话", "biz": "商业价值一句话", "category": "开发者工具"}}

依赖：纯标准库。读 GITHUB_TOKEN（环境变量优先，其次 wb-checkout/.env）。

★ 解析要点（2026-10-03 实测 GitHub trending 的 DOM，别再凭印象写正则）：
  trending 页是服务端渲染的静态 HTML，每条一个 `<article class="Box-row">`。
  ① 仓库 slug **只能**从 `<h2>` 内部的 href 拿 —— 头部那个 Star 按钮的
     `href="/login?return_to=..."` 也在附近，不限定在 h2 里就会抓错。
  ② `<a>` 上挂着几十个 `data-hydro-click` 属性，星标数字还被 `<svg>` 隔开，
     所以**先把标签全剥掉、再跑数字正则**，比在标签丛里写正则稳得多。
  ③ 剥完的文本形态是：
     `> Star owner / repo <简介> <语言> <总星> <分叉> Built by <N> stars today`
"""
import argparse
import html as HTML
import io
import json
import os
import re
import socket
import sys
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")
TIMEOUT = 25
TRENDING = "https://github.com/trending?since=%s"

# 分类关键词表：**顺序有意义**（先命中的赢），具体词放前面、泛化词放后面。
RULES = [
    ("量化交易", ["trading", "quant", "backtest", "stock", "finance", "financial", "invest",
                  "broker", "portfolio", "market data", "期货", "交易", "行情"]),
    ("爬虫采集", ["scrap", "crawl", "spider", "read & search", "aggregat", "browser agent"]),
    ("数据库", ["database", "postgres", "mysql", "sqlite", "clickhouse", "vector db",
                "time-series", "timeseries", "knowledge graph"]),
    ("运维部署", ["kubernetes", "docker", "sandbox", "deploy", "infra", "self-host", "selfhost",
                  "gateway", "runtime", "proxy"]),
    ("前端 UI", ["design system", "design language", "ui kit", "css", "tailwind",
                 "component librar", "figma", "animation"]),
    ("数据分析", ["analytics", "dashboard", "visualiz", "chart", "etl", "data pipeline"]),
    ("文档知识库", ["note-taking", "notes", "wiki", "knowledge base", "obsidian", "markdown",
                    "docs site"]),
    ("AI / LLM", ["llm", "agent", "gpt", "claude", "openai", "anthropic", "gemini", "model",
                  "inference", "embedding", "rag", "prompt", "diffusion", "voice", "speech",
                  "transcri", "tts", "whisper", "skill", "mcp"]),
    # ⚠️ 「学习资源」要排在 AI/LLM **之后**，且不能用裸 "learn" ——
    #    实测 "Agent Memory That Learn**s**" 会被抢先判成学习资源（假分类）。
    ("学习资源", ["learn to", "learn it", "learning path", "tutorial", "course",
                  "from scratch", "awesome-", "awesome list", "curated list",
                  "roadmap", "handbook", "zero to"]),
    ("效率工具", ["cli", "terminal", "productivity", "automat", "workflow", "video", "audio",
                  "convert", "generator", "editor", "player", "download", "sync"]),
    ("后端服务", ["server", "api", "framework", "orchestrat", "sdk", "grpc"]),
    ("开发者工具", ["code", "dev tool", "linter", "formatter", "debug", "compiler", "ide",
                    "copilot", "refactor", "token"]),
]

RE_ARTICLE = '<article class="Box-row"'
RE_H2 = re.compile(r"<h2[^>]*>([\s\S]*?)</h2>")
RE_H2_HREF = re.compile(r'href="/([^"/]+)/([^"/]+)"')
RE_LANG = re.compile(r'itemprop="programmingLanguage"[^>]*>\s*([^<]+?)\s*<')
RE_DESC = re.compile(r'<p class="col-9[^"]*">([\s\S]*?)</p>')
RE_STARFORK = re.compile(r"([\d,]+)\s+([\d,]+)\s+Built by")
RE_PERIOD = re.compile(r"([\d,]+)\s+stars?\s+(?:today|this week)")


def env_token():
    tok = os.environ.get("GITHUB_TOKEN")
    if tok:
        return tok.strip()
    try:
        with io.open(os.path.join(ROOT, ".env"), encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if line.startswith("GITHUB_TOKEN="):
                    return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def get(url, token="", tries=3):
    """带重试的 GET。GitHub 可达性会抖，单次失败不代表不通。"""
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Accept": "application/vnd.github+json" if "api.github.com" in url else "text/html",
    })
    if token:
        req.add_header("Authorization", "Bearer " + token)
    last = None
    for _ in range(tries):
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                return r.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            last = "HTTP %s" % e.code
            if e.code in (401, 403, 404, 429):   # 限流/无权限，重试没意义
                break
        except (urllib.error.URLError, socket.timeout, OSError) as e:
            last = str(e)[:80]
    raise RuntimeError(last or "unknown error")


def num(s):
    return int(s.replace(",", "")) if s else 0


def plain(chunk):
    """剥掉标签 + 反转义 + 折叠空白（见文件头 ★ ②）。"""
    return re.sub(r"\s+", " ", HTML.unescape(re.sub(r"<[^>]+>", " ", chunk))).strip()


def parse_trending(html, period):
    out = []
    for chunk in html.split(RE_ARTICLE)[1:]:
        h2 = RE_H2.search(chunk)
        if not h2:
            continue
        link = RE_H2_HREF.search(h2.group(1))   # 见 ★ ①：只在 h2 内找
        if not link:
            continue
        d = RE_DESC.search(chunk)
        desc = plain(d.group(1)) if d else ""
        lang = RE_LANG.search(chunk)
        text = plain(chunk)
        sf = RE_STARFORK.search(text)
        pd = RE_PERIOD.search(text)
        out.append({
            "slug": "%s/%s" % (link.group(1), link.group(2)),
            "description": desc,
            "language": lang.group(1) if lang else "",
            "stars": num(sf.group(1)) if sf else 0,
            "forks": num(sf.group(2)) if sf else 0,
            period: num(pd.group(1)) if pd else 0,
        })
    return out


def from_search(token, days=7):
    """兜底：trending 页解析不出来时，用搜索 API 找「新建 + 高星」。"""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d")
    url = ("https://api.github.com/search/repositories?q=created:%3E" + since +
           "&sort=stars&order=desc&per_page=40")
    data = json.loads(get(url, token))
    return [{"slug": it["full_name"], "description": it.get("description") or "",
             "language": it.get("language") or "", "stars": it.get("stargazers_count", 0),
             "forks": it.get("forks_count", 0), "stars_week": 0}
            for it in data.get("items", [])]


def classify(text):
    low = text.lower()
    for cat, keys in RULES:
        if any(k in low for k in keys):
            return cat
    return "其他"


def openness_of(repo):
    spdx = ((repo or {}).get("license") or {}).get("spdx_id") or ""
    return "完全开源" if spdx and spdx not in ("NOASSERTION", "NONE") else "源码可见"


def merge(rows):
    """日榜 ∪ 周榜：同一仓库合并，heat 用于排序。"""
    by = {}
    for r in rows:
        slug = r["slug"].lower()
        cur = by.setdefault(slug, {"slug": r["slug"], "description": r["description"],
                                   "language": r["language"], "stars": r["stars"],
                                   "forks": r["forks"], "stars_today": 0, "stars_week": 0})
        for k in ("stars_today", "stars_week", "stars", "forks"):
            cur[k] = max(cur.get(k) or 0, r.get(k) or 0)
        for k in ("description", "language"):
            if not cur[k]:
                cur[k] = r[k]
    for it in by.values():
        # 日榜与周榜量纲不同，用「日增 × 7」折算成可比的周增
        it["heat"] = max(it["stars_week"], it["stars_today"] * 7)
    return sorted(by.values(), key=lambda x: (-x["heat"], -x["stars"]))


def enrich(it, token):
    """用 repos API 校正星数/语言/许可 —— trending 页是快照，API 才准。"""
    try:
        repo = json.loads(get("https://api.github.com/repos/" + it["slug"], token))
    except Exception:
        it["verified"] = False
        return it
    it["verified"] = True
    it["stars"] = repo.get("stargazers_count", it["stars"])
    it["forks"] = repo.get("forks_count", it["forks"])
    it["language"] = repo.get("language") or it["language"]
    it["description"] = repo.get("description") or it["description"]
    it["license"] = ((repo.get("license") or {}).get("spdx_id") or "") or ""
    it["created_at"] = (repo.get("created_at") or "")[:10]
    it["pushed_at"] = (repo.get("pushed_at") or "")[:10]
    it["archived"] = bool(repo.get("archived"))
    it["openness"] = openness_of(repo)
    return it


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(ROOT, "assets", "hot-projects.json"))
    ap.add_argument("--top", type=int, default=20)
    ap.add_argument("--biz", default="")
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()

    token = env_token()
    print("token: %s" % ("有" if token else "无（匿名 60 次/时）"))

    rows, used = [], []
    for period, since in (("stars_today", "daily"), ("stars_week", "weekly")):
        try:
            got = parse_trending(get(TRENDING % since, token), period)
            print("trending %-7s : %d 条" % (since, len(got)))
            rows += got
            used.append("https://github.com/trending?since=" + since)
        except Exception as e:
            print("trending %-7s : 失败 %s" % (since, e))
    if not rows:
        print("两条 trending 都没拿到 → 退回搜索 API 兜底")
        rows = from_search(token)
        used.append("api.github.com/search/repositories (created:>7d, sort:stars)")

    cand = merge(rows)[:a.top]
    print("候选 %d 个（去重后按升星速度排序）" % len(cand))

    biz = {}
    if a.biz:
        with io.open(a.biz, encoding="utf-8") as f:
            biz = json.load(f)

    items = []
    for it in cand:
        it = enrich(it, token)
        o = biz.get(it["slug"]) or {}
        hot = []
        if it["stars_today"]:
            hot.append("日榜 +%s" % format(it["stars_today"], ","))
        if it["stars_week"]:
            hot.append("周榜 +%s" % format(it["stars_week"], ","))
        items.append({
            "name": it["slug"],
            "url": "https://github.com/" + it["slug"],
            "category": o.get("category") or classify(
                " ".join([it["slug"], it["description"], it.get("language") or ""])),
            "summary": o.get("zh") or it["description"] or "（仓库未写简介）",
            "biz": o.get("biz") or "",
            "openness": it.get("openness") or "源码可见",
            "stars": it["stars"],
            "verified": it.get("verified", False),
            "language": it.get("language") or "",
            "license": it.get("license") or "",
            "stars_today": it["stars_today"],
            "stars_week": it["stars_week"],
            "heat": it["heat"],
            "created_at": it.get("created_at") or "",
            "pushed_at": it.get("pushed_at") or "",
            "note": "热点推荐 · " + " · ".join(hot) if hot else "热点推荐",
            "found_at": datetime.now().strftime("%Y-%m-%d"),
        })

    feed = {"updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
            "sources": used, "count": len(items), "items": items}
    out = json.dumps(feed, ensure_ascii=False, indent=1)

    if a.dry_run:
        print(out[:2000])
        return 0
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    with io.open(a.out, "w", encoding="utf-8") as f:
        f.write(out + "\n")
    print("saved: %s  (%d 个项目, %d 字节)" % (a.out, len(items), len(out)))
    miss = [x["name"] for x in items if not x["biz"]]
    if miss:
        print("⚠️ 未写商业价值 %d 个：%s" % (len(miss), ", ".join(miss)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
