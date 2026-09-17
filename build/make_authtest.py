# -*- coding: utf-8 -*-
"""认证界面自检：把测试脚本追加到已构建的 index.html 末尾，用无头 Chrome 跑，
读出「顶部 登录/注册 切换」到底有没有真的切换表单。

为什么用"追加到文件末尾"而不是 replace('</body>')：
index.html 内联的 exporter.js 模板字符串里就有字面量 </body>，
replace 会插进 JS 源码里，把脚本搞坏。

产物：build/auth_test.html → 无头 Chrome --dump-dom → 解析 <pre id="tb">
"""
import io
import os
import sys

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "index.html")

PROBE = """
<pre id="tb">pending</pre>
<script>
(function () {
  var log = [];
  function labels() {
    var f = document.getElementById('authForm');
    if (!f) return 'NO_FORM';
    var ls = [].map.call(f.querySelectorAll('label'), function (e) { return e.textContent.trim(); });
    var btns = [].filter.call(f.querySelectorAll('button'), function (b) { return !b.className.match(/btn\\s+sm/); })
                 .map(function (b) { return b.textContent.trim(); });
    var segs = [].map.call(document.querySelectorAll('.seg button'), function (b) {
      return b.textContent.trim() + (b.classList.contains('on') ? '(高亮)' : '');
    });
    var mode = (window.CuAuth && window.CuAuth.getMode) ? window.CuAuth.getMode() : 'no-CuAuth';
    return 'mode=' + mode + ' labels=[' + ls.join(',') + '] 主按钮=[' + btns.join(',') + '] 分段=' + segs.join('|');
  }
  function view() {
    function vis(id) { var e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); }
    return 'auth=' + vis('viewAuth') + ' gate=' + vis('viewGate') + ' app=' + vis('viewApp');
  }
  function step(name, fn) {
    log.push('[' + name + '] ' + fn());
  }
  var tries = 0;
  var timer = setInterval(function () {
    tries++;
    var f = document.getElementById('authForm');
    if ((f && f.innerHTML.length > 40) || tries > 50) {
      clearInterval(timer);
      try {
        log.push('[视图] ' + view());
        step('初始', labels);

        /* 1) 点顶部「注册」分段按钮 */
        var segSignup = document.getElementById('segSignup');
        if (segSignup) segSignup.click();
        step('点顶部注册后', labels);

        /* 2) 再点顶部「登录」分段按钮 */
        var segLogin = document.getElementById('segLogin');
        if (segLogin) segLogin.click();
        step('点顶部登录后', labels);

        /* 3) 直接走表单内的 data-go 链接（这条是设计上的正路） */
        var f2 = document.getElementById('authForm');
        var goOtp = f2 && f2.querySelector('[data-go="login-otp"]');
        if (goOtp) goOtp.click();
        step('点表单内「用邮箱验证码登录」', labels);
        var f3 = document.getElementById('authForm');
        var goSignup = f3 && f3.querySelector('[data-go="signup"]');
        if (goSignup) goSignup.click();
        step('点表单内「还没有账号？注册」', labels);

        /* 4) 从注册面板能否回到登录 */
        var f4 = document.getElementById('authForm');
        var back = f4 && f4.querySelector('[data-go="login-password"]');
        if (back) back.click();
        step('从注册点「已有账号？去登录」', labels);

        /* 5) 登录面板是否有「忘记密码」（无密码账号的唯一出路） */
        var f5 = document.getElementById('authForm');
        log.push('[忘记密码可达] ' + !!(f5 && f5.querySelector('[data-go="forgot"]')));
        /* 6) 登录面板本身有没有直达注册的链接 */
        log.push('[登录面板内含注册链接] ' + !!(f5 && f5.querySelector('[data-go="signup"]')));
      } catch (e) {
        log.push('EXC ' + e);
      }
      log.push('DONE');
      document.getElementById('tb').textContent = log.join('\\n');
    }
  }, 150);
})();
</script>
"""

html = io.open(src, encoding="utf-8").read()
dest = os.path.join(BUILD, "auth_test.html")
io.open(dest, "w", encoding="utf-8").write(html + PROBE)
print("saved:", dest, len(html) + len(PROBE), "chars  (源:", os.path.basename(src), ")")
