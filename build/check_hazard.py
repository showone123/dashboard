# -*- coding: utf-8 -*-
"""扫描会被内联进 <script>/<style> 的源文件，找出未转义的提前闭合标签。

HTML 解析器遇到字面量 </script 就会结束脚本块，哪怕它出现在 JS 字符串里。
所以凡是内联的 JS 里出现 </script> 必须写成 <\\/script>。
"""
import io
import os
import re

BUILD = os.path.dirname(os.path.abspath(__file__))
FILES = ['theme.css', 'app.css', 'render.js', 'parser.js', 'risk_parser.js', 'exporter.js', 'app.js']

BS = chr(92)  # 反斜杠

total = 0
for f in FILES:
    p = os.path.join(BUILD, f)
    if not os.path.exists(p):
        continue
    s = io.open(p, encoding='utf-8', errors='replace').read()
    bad = []
    for m in re.finditer(r'</\s*(script|style)', s, re.I):
        if m.start() > 0 and s[m.start() - 1] == BS:
            continue  # 已转义
        ln = s[:m.start()].count('\n') + 1
        ctx = s[max(0, m.start() - 45):m.start() + 18].replace('\n', ' ')
        bad.append((ln, ctx))
    total += len(bad)
    print('%-14s hazard=%d' % (f, len(bad)))
    for ln, ctx in bad:
        print('      line %-5d | %s' % (ln, ctx))

print()
print('TOTAL HAZARDS =', total)
