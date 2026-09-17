# -*- coding: utf-8 -*-
"""导出功能接线自检：DOM 里声明的 id 与 app.js 里 getElementById 的 id 是否对得上。

防的是这类低级事故：HTML 里改了 id、JS 里没跟着改，运行时才报 null。
"""
import io
import os
import re

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)

html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
appjs = io.open(os.path.join(BUILD, "app.js"), encoding="utf-8").read()

html_ids = set(re.findall(r'\bid="([^"]+)"', html))
# app.js 用 $(id) 封装了 getElementById，两种写法都要扫
js_ids = set(re.findall(r"getElementById\(['\"]([^'\"]+)['\"]\)", appjs))
js_ids |= set(re.findall(r"(?<![\w.])\$\(\s*['\"]([^'\"]+)['\"]\s*\)", appjs))

print("HTML 里的 id 共 %d 个；app.js 引用 %d 个 id" % (len(html_ids), len(js_ids)))

missing = sorted(i for i in js_ids if i not in html_ids)
print("\n[1] JS 引用了但 HTML 里不存在的 id（会造成 null 崩溃）：")
print("    ", missing or "无 ✅")

# 导出相关必须成套存在
need_html = ['btnExport', 'exModal', 'exMask', 'exClose', 'exCancel', 'exGo',
             'exOptHtml', 'exOptPng', 'exPanePng', 'exPaneHtml',
             'exScaleSeg', 'exScaleNote', 'exPreview', 'exHtmlNote', 'exHint',
             'exHtmlMeta', 'exPngMeta', 'wbExporterJs']
print("\n[2] 导出功能 DOM 元素齐备性：")
for n in need_html:
    ok = ('id="%s"' % n) in html if n != 'wbExporterJs' else ('id="wbExporterJs"' in html)
    print("    %-14s %s" % (n, "✅" if ok else "❌ 缺失"))

# app.js 里必须真的把这些接上
need_bind = ['btnExport', 'exClose', 'exCancel', 'exMask', 'exOptHtml', 'exOptPng',
             'exGo', 'exScaleSeg', 'exPreview']
print("\n[3] app.js 事件绑定：")
for n in need_bind:
    ok = n in appjs
    print("    %-14s %s" % (n, "✅" if ok else "❌ 未绑定"))

print("\n[4] 关键全局对象：")
for n, where in [('CuExport', html), ('CuRender', html), ('window.CuExport', html)]:
    print("    %-16s index.html 内出现 %d 次" % (n, where.count(n)))

print("\n[5] 导出引擎入口函数是否都在：")
for fn in ['buildHtml', 'renderPoster', 'posterSize', 'downloadBlob', 'downloadText', 'safeName']:
    print("    %-14s %s" % (fn, "✅" if (fn + ':') in html or (fn + ' =') in html else "❌"))

print("\n[6] 规模：")
print("    index.html  %d bytes" % len(html))
