# -*- coding: utf-8 -*-
"""生成导出二级界面的视觉预览页：build/export_ui.html

线上应用要登录才能看到界面，这个预览页把 index.html 里的导出弹窗整块抠出来，
配上真实的 theme.css / app.css，把默认态改成"已选 PNG 长图"并渲染一张真实的长图缩略图，
这样就能直接截图肉眼确认样式、层级、间距没问题。
"""
import io
import json
import os
import re

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)


def rd(p):
    with io.open(p, encoding="utf-8") as f:
        return f.read()


index = rd(os.path.join(ROOT, "index.html"))
theme = rd(os.path.join(BUILD, "theme.css"))
appcss = rd(os.path.join(BUILD, "app.css"))
render = rd(os.path.join(BUILD, "render.js"))
exporter = rd(os.path.join(BUILD, "exporter.js"))
seed = rd(os.path.join(BUILD, "copper_data.json")).replace("<", "\\u003c")

# 抠出导出弹窗那一整块
m = re.search(r'<div class="exmodal hidden" id="exModal">.*?\n</div>\n', index, re.S)
if not m:
    raise SystemExit("没能从 index.html 里定位到 exModal 区块")
modal = m.group(0)

# 默认态改成已选 PNG：弹窗显示、PNG 面板显示、HTML 面板隐藏
modal = modal.replace('<div class="exmodal hidden" id="exModal">', '<div class="exmodal" id="exModal">')
modal = modal.replace('<button class="exopt on" id="exOptHtml"', '<button class="exopt" id="exOptHtml"')
modal = modal.replace('<button class="exopt" id="exOptPng"', '<button class="exopt on" id="exOptPng"')
modal = modal.replace('<div class="expane hidden" id="exPanePng">', '<div class="expane" id="exPanePng">')
modal = modal.replace('<div class="exnote" id="exHtmlNote"></div>',
                      '<div class="exnote" id="exHtmlNote">包含完整样式与渲染脚本，双击即开，离线可用。</div>')
# 预览区占位文字换成画布
modal = modal.replace('<div class="exph">选择 PNG 长图后，这里会显示预览…</div>',
                      '<canvas id="pv"></canvas>')
# 顶部提示文案
modal = modal.replace('<div class="exseg" id="exScaleSeg">',
                      '<div class="exseg" id="exScaleSeg">')
modal = modal.replace('<span class="exlabel" id="exScaleNote"></span>',
                      '<span class="exlabel" id="exScaleNote">2160 × 8000 像素</span>')
modal = modal.replace('<div class="exhint" id="exHint"></div>',
                      '<div class="exhint" id="exHint">长图约 1.8 MB，导出后可直接发微信。</div>')

TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>Export UI preview</title>
<style id="wbTheme">
__THEME__
</style>
<style id="wbAppCss">
__APPCSS__
</style>
<style>
  /* 预览页（类名用 expv，不能用 preview —— app.css 里 .preview{display:none} 会命中 body）把弹窗当作常态展示，并给它一个"背景"—真实应用里背后是看板。
     注意：不能只靠改 .exmodal 的定位，否则 body 高度可能塌成 0（fixed 元素脱离文档流），
     无头截图会截出一张纯白图。这里显式给 html/body 上高度和底色，并关掉入场动画。 */
  html, body.expv { background:#0a0e17 !important; min-height:100vh; margin:0; }
  body.expv .exmodal { position:static !important; display:block !important; inset:auto; padding:24px 0; }
  body.expv .exmask { display:none !important; }
  body.expv .excard { margin:0 auto !important; animation:none !important; opacity:1 !important; }
  #pv { width:100%; height:auto; display:block; border-radius:8px; }
</style>
</head>
<body class="app-body expv">
__MODAL__
<script id="wbRenderJs">
__RENDER__
</script>
<script>
__EXPORTER__
</script>
<script id="cuSeed" type="application/json">__SEED__</script>
<script>
(function () {
  try {
    var D = JSON.parse(document.getElementById('cuSeed').textContent);
    var cv = CuExport.renderPoster(D, { scale: 0.45 });
    var host = document.getElementById('exPreview');
    var old = document.getElementById('pv');
    cv.id = 'pv';
    old.parentNode.replaceChild(cv, old);
    document.title = 'UI OK ' + cv.width + 'x' + cv.height;
  } catch (e) {
    document.title = 'UI FAIL ' + e;
  }
})();
</script>
</body>
</html>
"""

out = (TPL.replace("__THEME__", theme)
          .replace("__APPCSS__", appcss)
          .replace("__MODAL__", modal)
          .replace("__RENDER__", render)
          .replace("__EXPORTER__", exporter)
          .replace("__SEED__", seed))

dest = os.path.join(BUILD, "export_ui.html")
with io.open(dest, "w", encoding="utf-8") as f:
    f.write(out)
print("saved:", dest, len(out), "chars")

# ---------------------------------------------------------------------------
# 第二个预览页：看板 + 右下角导出按钮（验证 FAB 的定位/层级/配色）
# ---------------------------------------------------------------------------
FAB_TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<title>Export FAB preview</title>
<style id="wbTheme">
__THEME__
</style>
<style id="wbAppCss">
__APPCSS__
</style>
</head>
<body class="app-body">
<section class="panel active" id="panelDash">
  <div id="cuRoot"></div>
  <button class="export-fab" id="btnExport" type="button" title="把当前看板导出为文件">
    <span class="ef-ic">⤓</span><span>导出成果</span>
  </button>
</section>
<script id="wbRenderJs">
__RENDER__
</script>
<script>
__EXPORTER__
</script>
<script id="cuSeed" type="application/json">__SEED__</script>
<script>
(function () {
  try {
    var D = JSON.parse(document.getElementById('cuSeed').textContent);
    CuRender.mount(document.getElementById('cuRoot'), D);
    document.title = 'FAB OK';
  } catch (e) { document.title = 'FAB FAIL ' + e; }
})();
</script>
</body>
</html>
"""

fab = (FAB_TPL.replace("__THEME__", theme)
              .replace("__APPCSS__", appcss)
              .replace("__RENDER__", render)
              .replace("__EXPORTER__", exporter)
              .replace("__SEED__", seed))

dest2 = os.path.join(BUILD, "export_fab.html")
with io.open(dest2, "w", encoding="utf-8") as f:
    f.write(fab)
print("saved:", dest2, len(fab), "chars")
