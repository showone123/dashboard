# -*- coding: utf-8 -*-
"""端到端回归：把真实抓到的后端错误响应喂给应用，走一遍「填邮箱密码 → 点登录」，
看应用是否真的把用户送到"设置密码"界面（而不是丢一句英文报错）。

做法：
  1. 在 CDN 脚本**之前**注入 fetch 拦截器 —— 必须在 SDK 初始化前装好，
     否则 SDK 可能已经把 fetch 存成引用，后面再改 window.fetch 就不生效了。
  2. 在文件末尾追加驱动脚本（不能用 replace('</body>')，exporter 模板里有字面量 </body>）。
  3. 无头 Chrome 跑，读 <pre id="tb">。

断言（LIVE 实测过的真实响应体）：
  PASSWORD_NOT_SET → 应跳到 forgot 面板、中文提示、邮箱预填、有"发送重置码"按钮。
"""
import io
import os
import sys

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)

src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "index.html")
CASE = sys.argv[2] if len(sys.argv) > 2 else "password_not_set"
CDN = '<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>'
assert CDN in io.open(src, encoding="utf-8").read(), "未找到云 SDK 的 CDN script 标签"

# 响应体都是从线上后端真实抓到的
CASES = {
    "password_not_set": {
        "body": {"code": "PASSWORD_NOT_SET", "error": "password_not_set", "error_code": 4029,
                 "error_description": "user password not set"},
        "status": 400,
        "expect_mode": "forgot",
        "expect_text": "还没有设置密码",
    },
    "invalid_credentials": {
        "body": {"code": "INVALID_USERNAME_OR_PASSWORD", "error": "invalid_username_or_password",
                 "error_code": 4043, "error_description": "Username or password incorrect."},
        "status": 400,
        "expect_mode": "login-password",
        "expect_text": "邮箱或密码不正确",
    },
}
case = CASES[CASE]

STUB = """<script>
/* 只拦认证相关的接口，其余放行走真实网络。
   响应体是从线上后端真实抓到的。 */
(function () {
  var REAL = window.fetch.bind(window);
  window.__stubHits = [];
  var BODY = __BODY__;
  window.fetch = function (input, init) {
    var url = (typeof input === 'string') ? input : ((input && input.url) || '');
    if (url.indexOf('/auth/v1/signin') >= 0) {
      window.__stubHits.push('/auth/v1/signin');
      return Promise.resolve(new Response(JSON.stringify(BODY), {
        status: __STATUS__, headers: { 'Content-Type': 'application/json' }
      }));
    }
    return REAL(input, init);
  };
})();
</script>
""".replace("__BODY__", __import__("json").dumps(case["body"])).replace("__STATUS__", str(case["status"]))

DRIVER = """
<pre id="tb">pending</pre>
<script>
(function () {
  var CASE = '__CASE__';
  var EXPECT_MODE = '__EXPECT_MODE__';
  var EXPECT_TEXT = '__EXPECT_TEXT__';
  var log = [];
  function fields() {
    var f = document.getElementById('authForm');
    return [].map.call(f.querySelectorAll('label'), function (e) { return e.textContent.trim(); }).join(',');
  }
  function wait(cond, cb, n) {
    n = n || 0;
    if (cond()) return cb();
    if (n > 60) return cb('TIMEOUT');
    setTimeout(function () { wait(cond, cb, n + 1); }, 150);
  }
  function finish(verdict) {
    log.push('判定=' + verdict);
    log.push('DONE');
    document.getElementById('tb').textContent = log.join('\\n');
  }
  wait(function () { var f = document.getElementById('authForm'); return f && f.innerHTML.length > 40; }, function () {
    try {
      log.push('用例=' + CASE);
      log.push('初始 mode=' + (window.CuAuth ? CuAuth.getMode() : '?') + ' 字段=' + fields());

      /* 模拟用户：在登录表单填邮箱+密码，点登录 */
      document.getElementById('f_email').value = '2778904358@qq.com';
      document.getElementById('f_pwd').value = 'whatever123456';
      document.getElementById('act_login').click();

      wait(function () {
        var m = document.getElementById('authMsg');
        return m && m.textContent.trim().length > 0;
      }, function () {
        var msg = document.getElementById('authMsg');
        var mode = (window.CuAuth ? CuAuth.getMode() : '?');
        var text = msg ? msg.textContent.trim() : '';
        log.push('点登录后 mode=' + mode);
        log.push('表单字段=' + fields());
        log.push('邮箱是否预填=' + (document.getElementById('f_email') || {}).value);
        log.push('提示样式类=' + (msg ? msg.className : '?'));
        log.push('提示文案=' + text);
        log.push('有「发送重置码」按钮=' + !!document.getElementById('act_send'));
        log.push('拦截器命中=' + JSON.stringify(window.__stubHits));
        var okMode = (mode === EXPECT_MODE);
        var okText = text.indexOf(EXPECT_TEXT) >= 0;
        var okNoEnglish = text.indexOf('user password not set') < 0 && text.indexOf('incorrect') < 0;
        log.push('断言 mode==' + EXPECT_MODE + ' → ' + okMode);
        log.push('断言 文案含「' + EXPECT_TEXT + '」→ ' + okText);
        log.push('断言 未漏出英文原文 → ' + okNoEnglish);
        finish((okMode && okText && okNoEnglish) ? 'PASS' : 'FAIL');
      });
    } catch (e) {
      log.push('EXC ' + e);
      finish('FAIL');
    }
  });
})();
</script>
""".replace("__CASE__", CASE).replace("__EXPECT_MODE__", case["expect_mode"]).replace("__EXPECT_TEXT__", case["expect_text"])

html = io.open(src, encoding="utf-8").read()
html = html.replace(CDN, STUB + CDN, 1)
html = html + DRIVER
dest = os.path.join(BUILD, "auth_flow_%s.html" % CASE)
io.open(dest, "w", encoding="utf-8").write(html)
print("saved:", dest, len(html), "chars  (源:", os.path.basename(src), "用例:", CASE, ")")
