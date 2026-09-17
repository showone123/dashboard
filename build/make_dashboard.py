# -*- coding: utf-8 -*-
"""把 theme.css + render.js + copper_data.json 组装成单文件本地看板。"""
import json, os

BUILD = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(BUILD, "copper_data.json"), encoding="utf-8") as f:
    raw = f.read()
with open(os.path.join(BUILD, "theme.css"), encoding="utf-8") as f:
    css = f.read()
with open(os.path.join(BUILD, "render.js"), encoding="utf-8") as f:
    js = f.read()

D = json.loads(raw)
date_compact = D["meta"]["date"].replace("-", "")

HTML = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>有色金属研究院·铜期货数据看板 · __DATE__</title>
<style>
__CSS__
</style>
</head>
<body>
<div id="cuRoot"></div>
<script id="cuSeed" type="application/json">__DATA__</script>
<script>
__JS__
(function(){
  var D = JSON.parse(document.getElementById('cuSeed').textContent);
  CuRender.mount(document.getElementById('cuRoot'), D);
})();
</script>
</body>
</html>
"""

out_html = (HTML.replace("__CSS__", css)
                .replace("__JS__", js)
                .replace("__DATE__", D["meta"]["date"])
                .replace("__DATA__", raw))

dest = r"D:\Deskop\铜数据看板_%s.html" % date_compact
with open(dest, "w", encoding="utf-8") as f:
    f.write(out_html)
print("saved:", dest, len(out_html), "bytes")
