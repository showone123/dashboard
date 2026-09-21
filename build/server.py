# -*- coding: utf-8 -*-
"""静态服务（带兜底路由）与公开期货工具箱缓存接口。

存在意义：分享出去的链接经常被 IM / 富文本吞掉或多带一个字符，
落到沙箱默认的静态服务器上就会直接暴露一页 Python 原生报错
（"Error code: 404 / Nothing matches the given URI"），对客户非常难看。
这里把任何未命中的路径都交回 index.html，客户端永远只看到应用本体。

/.cloud/* 属于云服务网关的命名空间（Auth / Database / Storage），
本服务一律不处理，避免用 HTML 遮蔽掉登录接口。
"""
import json
from urllib.parse import parse_qs, urlsplit
from futures_service import Cache
from stocks_service import snapshot
from financial_service import query
import mimetypes
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, "index.html")
# 服务端自身文件与隐藏文件不做静态暴露
BLOCKED = {"server.py", "futures_service.py", "stocks_service.py", "financial_service.py"}
CACHE = Cache(os.environ.get("FUTURES_CACHE_DIR", os.path.join(ROOT, "..", ".futures-cache")),
              os.path.join(ROOT, "futures_seed.json"))


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    # ---------- 输出 ----------
    def _write(self, ctype, body):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_index(self):
        try:
            with open(INDEX, "rb") as f:
                body = f.read()
        except OSError:
            self.send_error(500, "index.html missing")
            return
        self._write("text/html; charset=utf-8", body)

    def _serve_file(self, target):
        try:
            with open(target, "rb") as f:
                body = f.read()
        except OSError:
            return self._serve_index()
        ctype = mimetypes.guess_type(target)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype in (
            "application/javascript", "application/json", "image/svg+xml"
        ):
            ctype += "; charset=utf-8"
        self._write(ctype, body)

    # ---------- 路由 ----------
    def _resolve(self, path):
        """命中真实文件则返回绝对路径，否则返回 None。

        normpath 会把 '/index.html/' 这类尾部斜杠抹平，
        因此带尾斜杠的坏链接也会被正确兜底。
        """
        rel = path.lstrip("/")
        if not rel:
            return None
        target = os.path.normpath(os.path.join(ROOT, rel))
        if not target.startswith(ROOT + os.sep):
            return None
        if (os.path.basename(target) in BLOCKED or target.endswith((".py", ".pyc"))
                or any(part.startswith(".") or part == "__pycache__" for part in rel.replace("\\", "/").split("/"))):
            return None
        return target if os.path.isfile(target) else None

    def _handle(self):
        path = self.path.split("?", 1)[0].split("#", 1)[0]

        # 云服务命名空间：不处理，交回网关
        if path.startswith("/.cloud"):
            self.send_error(404, "not handled by app")
            return

        if path in ("", "/", "/index.html"):
            return self._serve_index()

        target = self._resolve(path)
        if target:
            return self._serve_file(target)

        # 兜底：任何未命中的路径都返回应用本体，客户看不到原生 404 页
        self._serve_index()

    def _futures(self, refresh=False):
        query = parse_qs(urlsplit(self.path).query)
        key = query.get("category", ["futures"])[0]
        if len(key) > 40:
            self.send_error(400, "Invalid category")
            return
        try:
            action = CACHE.refresh(key, force=True) if refresh else None
            payload = CACHE.snapshot(key)
        except ValueError:
            self.send_error(400, "Unknown category")
            return
        payload["action"] = action
        self._write("application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode("utf-8"))

    def do_POST(self):
        if urlsplit(self.path).path == "/api/finance/query":
            if self.headers.get("X-FluxDesk-Request") != "1":
                self.send_error(403)
                return
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 0 < length <= 8192:
                    raise ValueError("Invalid request size")
                body = json.loads(self.rfile.read(length))
                payload = query(body.get("id"), body.get("params"), self.client_address[0])
            except (ValueError, TypeError, AttributeError):
                self.send_error(400, "Invalid finance query")
                return
            except RuntimeError:
                self.send_error(503, "Finance data unavailable")
                return
            except Exception:
                self.send_error(503, "Finance data unavailable")
                return
            self._write("application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            return
        if urlsplit(self.path).path != "/api/futures/refresh":
            self.send_error(404)
            return
        # 跨站防护只靠这个自定义头，不要再拿 Origin 去比对 Host（2026-09-18 修正）。
        # 理由：自定义头不是 CORS 安全头，跨域 fetch 必先触发预检，而本服务不返回任何
        # Access-Control-* 头（OPTIONS 直接 501），浏览器会拦掉真实请求；form 提交又
        # 无法设置自定义头。两道真实攻击路径都在这里就死了。
        # 反面教训：平台边缘网关不向应用转发可用的 Host（显式指定也没用），浏览器对
        # POST 必定带 Origin，于是 "Origin != Host" 恒真 → 所有真实用户的刷新请求全被
        # 403；而命令行不带 Origin 反而 200，极易自测"通过"。
        if self.headers.get("X-FluxDesk-Request") != "1":
            self.send_error(403)
            return
        self._futures(refresh=True)

    def do_GET(self):
        if urlsplit(self.path).path == "/api/futures":
            return self._futures()
        if urlsplit(self.path).path == "/api/stocks":
            if self.headers.get("X-FluxDesk-Request") != "1":
                self.send_error(403)
                return
            codes = parse_qs(urlsplit(self.path).query).get("codes", [""])[0].split(",")
            try:
                payload = snapshot(codes)
            except ValueError:
                self.send_error(400, "Invalid stock codes")
                return
            except Exception:
                self.send_error(503, "Stock data unavailable")
                return
            self._write("application/json; charset=utf-8", json.dumps(payload, ensure_ascii=False).encode("utf-8"))
            return
        self._handle()

    def do_HEAD(self):
        self._handle()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    CACHE.start_background()
    port = int(os.environ.get("PORT", "3000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
