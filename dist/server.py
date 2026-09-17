# -*- coding: utf-8 -*-
"""单文件静态服务（带兜底路由）。

存在意义：分享出去的链接经常被 IM / 富文本吞掉或多带一个字符，
落到沙箱默认的静态服务器上就会直接暴露一页 Python 原生报错
（"Error code: 404 / Nothing matches the given URI"），对客户非常难看。
这里把任何未命中的路径都交回 index.html，客户端永远只看到应用本体。

/.cloud/* 属于云服务网关的命名空间（Auth / Database / Storage），
本服务一律不处理，避免用 HTML 遮蔽掉登录接口。
"""
import mimetypes
import os
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.abspath(__file__))
INDEX = os.path.join(ROOT, "index.html")
# 服务端自身文件与隐藏文件不做静态暴露
BLOCKED = {"server.py"}


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
        if os.path.basename(target) in BLOCKED or os.path.basename(target).startswith("."):
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

    def do_GET(self):
        self._handle()

    def do_HEAD(self):
        self._handle()

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "3000"))
    ThreadingHTTPServer(("0.0.0.0", port), Handler).serve_forever()
