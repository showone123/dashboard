# 数据看板模板

“数据看板”顶部可在铜期货看板与豆粕基本面报告之间切换。

- 铜期货看板继续使用现有 Excel 数据契约、云端历史和 HTML/PNG 导出。
- 豆粕基本面保留原单文件 HTML 的 15 屏交互报告，通过沙箱 iframe 运行，与主站登录和数据隔离。
- 用户可以下载豆粕 HTML，也可以上传 5 MB 以内的自有 HTML 在当前浏览器预览。上传预览不会写入云端历史。

豆粕模板源文件为 `assets/soymeal-dashboard.html`，构建时复制到 `dist/assets/`。更新模板只需替换源文件并运行 `python verify.py`。
