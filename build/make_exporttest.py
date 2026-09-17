# -*- coding: utf-8 -*-
"""生成导出功能的自检页：build/export_test.html

用途：在没有登录态的情况下（登录必须走线上域名），单独验证导出引擎——
      1. CuExport.buildHtml(DATA) 产出的单文件 HTML 是否自包含、可独立渲染；
      2. CuExport.renderPoster(DATA) 画出的长图是否正常（像素尺寸 + 实际内容）。

流程：
  1. 本脚本生成 export_test.html（内联 theme + render + exporter + 种子数据）；
  2. 无头 Chrome --dump-dom 跑它，页面把两个产物塞进 <textarea> 承载；
  3. 本脚本再把产物解出来落盘：build/out_export.html、build/out_poster.png。

为什么用 <textarea> 承载而不是 <script type="text/plain">：
  导出的 HTML 里本身含字面量 </script>，塞进 <script> 会被解析器当场截断。
  <textarea> 只在 </textarea> 处结束，安全。
"""
import base64
import html as ihtml
import json
import os
import re
import sys

BUILD = os.path.dirname(os.path.abspath(__file__))


def rd(n):
    with open(os.path.join(BUILD, n), encoding="utf-8") as f:
        return f.read()


theme = rd("theme.css")
render = rd("render.js")
exporter = rd("exporter.js")
seed = rd("copper_data.json").replace("<", "\\u003c")

TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>Export self-test</title>
<style id="wbTheme">
__THEME__
</style>
</head>
<body>
<pre id="out">running…</pre>
<div id="mount"></div>
<!-- 承载产物：必须放在测试脚本之前，否则 getElementById 拿到 null -->
<textarea id="htmlOut"></textarea>
<textarea id="pngData"></textarea>
<script id="wbRenderJs">
__RENDER__
</script>
<script>
__EXPORTER__
</script>
<script id="cuSeed" type="application/json">__SEED__</script>
<script>
(function () {
  var info = { steps: [] };
  try {
    var D = JSON.parse(document.getElementById('cuSeed').textContent);
    window.__D = D;

    /* ---- 1) 单文件 HTML ---- */
    var html = CuExport.buildHtml(D);
    /* 注意：必须是 textContent（写入 DOM 子文本节点），
       因为 --dump-dom 序列化的是 DOM 树，读不到 .value 这个属性。 */
    document.getElementById('htmlOut').textContent = html;
    info.htmlChars = html.length;
    info.html_kb = (html.length / 1024).toFixed(1);
    info.html_hasRender = html.indexOf('window.CuRender') >= 0;
    info.html_hasTheme = html.indexOf('.topbar') >= 0;
    info.html_hasData = html.indexOf('cu2610') >= 0;
    info.html_startsDoctype = html.slice(0, 15).indexOf('<!DOCTYPE html>') === 0;
    /* 导出文件里 script 闭合标签的净个数 / 开标签个数，应配平 */
    var TAG_OPEN = '<' + 'script>';
    var TAG_CLOSE = '<' + '/' + 'script>';
    info.html_scriptCloseCount = (html.split(TAG_CLOSE).length - 1);
    info.html_scriptOpenCount = (html.split(TAG_OPEN).length - 1);
    /* 有无外链依赖（除字体外应为 0 个 http 引用） */
    info.html_extRefs = (html.match(/https?:[/][/]/g) || []).length;

    /* ---- 2) 长图 ---- */
    var sz = CuExport.posterSize(D);
    info.posterW = sz.w;
    info.posterH = sz.h;
    var cv = CuExport.renderPoster(D, { scale: 2 });
    info.canvasW = cv.width;
    info.canvasH = cv.height;

    var c2 = cv.getContext('2d');
    var pts = [[20, 20], [Math.floor(cv.width / 2), 200], [Math.floor(cv.width / 2), 900],
               [Math.floor(cv.width / 2), 1800], [Math.floor(cv.width / 2), 2600],
               [Math.floor(cv.width / 2), cv.height - 60]];
    var hits = 0;
    pts.forEach(function (p) {
      if (p[1] < cv.height) {
        var d = c2.getImageData(p[0], p[1], 1, 1).data;
        if (d[3] > 0) hits++;
      }
    });
    info.opaqueProbes = hits + '/' + pts.length;

    /* 非背景像素占比（底色 #0a0e17 = 10,14,23），判断"是否真的画了东西" */
    var img = c2.getImageData(0, 0, cv.width, cv.height).data;
    var nonBg = 0, sampled = 0;
    for (var i = 0; i < img.length; i += 4 * 37) {
      sampled++;
      if (Math.abs(img[i] - 10) > 8 || Math.abs(img[i + 1] - 14) > 8 || Math.abs(img[i + 2] - 23) > 8) nonBg++;
    }
    info.nonBgRatio = (nonBg / sampled * 100).toFixed(2) + '%';

    /* 主色检测：确认红色/绿色/金色都出现过（涨跌与高亮） */
    var seen = {};
    var dd = c2.getImageData(0, 0, cv.width, cv.height).data;
    for (var j = 0; j < dd.length; j += 4 * 53) {
      var r = dd[j], g = dd[j + 1], b = dd[j + 2];
      if (r > 180 && g < 90 && b < 90) seen.red = 1;
      if (g > 150 && r < 90 && b < 130) seen.green = 1;
      if (r > 200 && g > 150 && b < 90) seen.gold = 1;
    }
    info.colors = Object.keys(seen).join('+') || 'none';

    document.getElementById('pngData').textContent = cv.toDataURL('image/png');

    /* 把长图挂进页面，便于 --screenshot 肉眼复核 */
    cv.style.width = '540px';
    cv.style.height = 'auto';
    document.getElementById('mount').appendChild(cv);

    info.ok = true;
  } catch (e) {
    info.ok = false;
    info.err = String((e && e.stack) || e);
  }
  document.getElementById('out').textContent = JSON.stringify(info, null, 2);
})();
</script>
</body>
</html>
"""


def generate():
    out = (TPL.replace("__THEME__", theme)
              .replace("__RENDER__", render)
              .replace("__EXPORTER__", exporter)
              .replace("__SEED__", seed))
    dest = os.path.join(BUILD, "export_test.html")
    with open(dest, "w", encoding="utf-8") as f:
        f.write(out)
    print("saved:", dest, len(out), "chars")


def harvest(dom_path=None):
    """从 --dump-dom 的结果里把两个产物解出来落盘。"""
    dom_path = dom_path or os.path.join(BUILD, "export_dom.html")
    h = open(dom_path, encoding="utf-8", errors="replace").read()

    m = re.search(r'<pre id="out">(.*?)</pre>', h, re.S)
    print("===== self-test report =====")
    print(ihtml.unescape(m.group(1)).strip() if m else "NO OUT")

    def grab(tid):
        mm = re.search(r'<textarea id="' + tid + r'">(.*?)</textarea>', h, re.S)
        return ihtml.unescape(mm.group(1)) if mm else ""

    out_html = grab("htmlOut")
    if out_html:
        p = os.path.join(BUILD, "out_export.html")
        with open(p, "w", encoding="utf-8") as f:
            f.write(out_html)
        print("\nwrote:", p, len(out_html), "chars")

    png = grab("pngData").strip()
    if png.startswith("data:image/png;base64,"):
        raw = base64.b64decode(png.split(",", 1)[1])
        p = os.path.join(BUILD, "out_poster.png")
        with open(p, "wb") as f:
            f.write(raw)
        print("wrote:", p, len(raw), "bytes")
    else:
        print("\nPNG MISSING (len=%d)" % len(png))


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "harvest":
        harvest(sys.argv[2] if len(sys.argv) > 2 else None)
    else:
        generate()
