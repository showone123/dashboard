# -*- coding: utf-8 -*-
"""检查一个内联了脚本的 HTML 里，每个 <script> 块是否完整（没被提前闭合截断）。

用法：python probe_scripts.py [文件路径]
默认查 export_test.html。构建产物 index.html 也必须过这一关——
只要内联的 JS 里出现字面量 </script>，脚本就会被 HTML 解析器当场截断。
非 JS 的 <script type="application/json"> 会被标记为 SKIP（不是错误）。
"""
import io
import os
import re
import shutil
import subprocess
import sys

BUILD = os.path.dirname(os.path.abspath(__file__))


def find_node():
    """按 环境变量 → 本机托管版 → PATH 的顺序找 node，便于换机器/换环境。"""
    cand = [os.environ.get("NODE_BIN"),
            r"C:\Users\27789\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"]
    for c in cand:
        if c and os.path.isfile(c):
            return c
    return shutil.which("node") or "node"


NODE = find_node()

target = sys.argv[1] if len(sys.argv) > 1 else "export_test.html"
if not os.path.isabs(target):
    target = os.path.join(BUILD, target)

s = io.open(target, encoding="utf-8", errors="replace").read()
print("file:", target, "(%d chars)\n" % len(s))

# 粗略按 <script ...> ... </script> 切；被正文截断的块也会被切出来，正好能看出来
blocks = re.findall(r'<script([^>]*)>(.*?)</script>', s, re.S)
print("found %d script blocks\n" % len(blocks))

bad = 0
for i, (attrs, body) in enumerate(blocks):
    line = s[:s.find(body)].count("\n") + 1 if body else 0
    if 'type="application/json"' in attrs or 'text/plain' in attrs:
        print("SKIP block#%d  attrs=%-34s (非 JS)" % (i, attrs.strip()[:34]))
        continue
    tmp = os.path.join(BUILD, "_chk_%d.js" % i)
    io.open(tmp, "w", encoding="utf-8").write(body)
    r = subprocess.run([NODE, "--check", tmp], capture_output=True, text=True)
    tag = "OK  " if r.returncode == 0 else "FAIL"
    print("%s block#%d  attrs=%-34s startline=%-6d chars=%d" % (tag, i, attrs.strip()[:34], line, len(body)))
    if r.returncode != 0:
        bad += 1
        for l in (r.stderr or "").strip().splitlines()[:6]:
            print("        ", l)
        m = re.search(r'_chk_%d\.js:(\d+)' % i, r.stderr or "")
        if m:
            n = int(m.group(1))
            lines = body.split("\n")
            for k in range(max(0, n - 3), min(len(lines), n + 2)):
                print("        %5d| %s" % (k + 1, lines[k][:150]))
    os.remove(tmp)

print("\nraw '</script>' in file:", len(re.findall(r'</script>', s)))
print("BROKEN BLOCKS =", bad)
