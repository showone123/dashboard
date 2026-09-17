# -*- coding: utf-8 -*-
"""探针：拿真实后端返回，确认 SDK 递给前端的 error 对象长什么样。

为什么必须实测：app.js 的判断函数 isPasswordNotSet(error) 要读 error.code / error.error_code /
error.message，但 SDK 可能会把后端原始 body 重新包一层（丢掉 code 等字段）。
字段读错 → 判断失效 → 用户又回到那句英文报错。所以这里打印真实的键名与取值。

用真实的无密码账号（2778904358@qq.com）触发 PASSWORD_NOT_SET，产出：
build/auth_probe.html → 无头 Chrome --dump-dom → 解析 <pre id="pb">
"""
import io
import os

BUILD = os.path.dirname(os.path.abspath(__file__))

EP = "https://data-dashboard-85191.app.workbuddy.host"
KEY = "wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa"
PROBE_EMAIL = "2778904358@qq.com"   # 实测无密码（PASSWORD_NOT_SET）

TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="utf-8"/><title>Auth probe</title></head>
<body>
<pre id="pb">pending</pre>
<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>
<script>
(function () {
  var out = [];
  var cloud = WorkBuddyCloud.createWorkBuddyCloud({ endpoint: %(ep)s, publishableKey: %(key)s });

  function keys(o) { try { return Object.keys(o || {}).join(','); } catch (e) { return 'ERR'; } }

  function report(tag, err) {
    out.push('=== ' + tag + ' ===');
    if (!err) { out.push('  (无 error)'); return; }
    out.push('  键名: ' + keys(err));
    ['kind', 'code', 'error', 'error_code', 'status', 'message', 'error_description'].forEach(function (k) {
      if (k in (err || {})) out.push('  ' + k + ' = ' + JSON.stringify(err[k]));
    });
    // 复刻 app.js 里的判断逻辑，确认能命中
    var code = String(err.code || err.error || (err.error_code ? String(err.error_code) : '') || '');
    var hitCode = code.toUpperCase() === 'PASSWORD_NOT_SET';
    var hitNum = err.error_code === 4029;
    var hitMsg = /password[ _]?not[ _]?set/i.test(String(err.message || err.error_description || ''));
    out.push('  → errCode() 取到: "' + code + '"');
    out.push('  → 判定 PASSWORD_NOT_SET: code=' + hitCode + ' error_code=' + hitNum + ' message=' + hitMsg +
             '  合计=' + (hitCode || hitNum || hitMsg));
    out.push('  → raw: ' + JSON.stringify(err));
  }

  (async function () {
    try {
      var r1 = await cloud.auth.signInWithPassword({ email: %(email)s, password: 'definitely_wrong_pwd_1' });
      report('密码登录一个无密码账号', r1.error);
      out.push('');

      var r2 = await cloud.auth.signInWithPassword({ email: 'zzz_never_registered_9931@example.com', password: 'definitely_wrong_pwd_1' });
      report('密码登录一个不存在的账号', r2.error);
      out.push('');

      var r3 = await cloud.auth.signInWithPassword({ email: %(email)s, password: '' });
      report('空密码（客户端校验）', r3.error);
    } catch (e) {
      out.push('EXC ' + e);
    }
    out.push('DONE');
    document.getElementById('pb').textContent = out.join('\\n');
  })();
})();
</script>
</body>
</html>
"""

out = TPL % {
    "ep": "'" + EP + "'",
    "key": "'" + KEY + "'",
    "email": "'" + PROBE_EMAIL + "'",
}
dest = os.path.join(BUILD, "auth_probe.html")
io.open(dest, "w", encoding="utf-8").write(out)
print("saved:", dest, len(out), "chars")
