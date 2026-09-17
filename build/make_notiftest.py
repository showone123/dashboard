# -*- coding: utf-8 -*-
"""通知功能 + 验证码冷却的端到端自测。

做法：拿真实的 index.html，把两个 CDN 脚本换成**同形状的假 SDK**（在 app.js 之前注入，
所以 app.js 拿到的是假 cloud），末尾追加驱动脚本。app.js 一行不改 —— 这样测的是真实代码路径，
不是"我另写一份逻辑自己证明自己"。

假 SDK 里的 database.from() 是一个 thenable 查询构造器，并且**照抄线上 RLS 的语义**：
  · notifications 读：非运营方只能看到 published=true（草稿不可见）
  · notifications 写：非运营方返回 42501（row-level security）—— 前端改不动的那道门
如果前端悄悄做了什么越权的事，这个假后端会像真后端一样拒绝它。

跑两遍：运营方视角 / 普通客户视角。用法：
  python make_notiftest.py
    → build/notif_flow_op.html   （运营方）
    → build/notif_flow_user.html （普通客户）
"""
import io
import os

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)

SDK_CDN = '<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@dev/lib/index.global.js"></script>'
XLSX_CDN = '<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>'

FAKE = """<script>
/* ===== 假云服务：形状照抄 @tencent-ai/workbuddy-cloud-sdk，语义照抄线上 RLS ===== */
(function () {
  var IS_OP = __IS_OP__;
  var UID = 'u-0001-0001';
  var EMAIL = '2778904358@qq.com';
  var SEQ = 100;
  var LOG = [];
  window.__LOG = LOG;
  function hoursAgo(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

  var DB = {
    notifications: [
      { id: 3, title: '9 月 20 日 17:00-19:00 系统维护通知',
        body: '本次维护期间，看板渲染、文件上传、历史数据下载与成果导出会短暂不可用。\\n维护窗口为 17:00-19:00，维护完成后刷新页面即可恢复，已上传的数据不会丢失。\\n若维护结束后仍无法访问，请把页面上的用户 ID 发给管理员排查。',
        level: 'warn', published: true, created_by: UID, created_at: hoursAgo(2), updated_at: hoursAgo(2) },
      { id: 2, title: '数据模板更新：新增季节性表',
        body: '精简模板已更新，重新下载后填写 SEASON 表，看板第 7 页会完整渲染。',
        level: 'info', published: true, created_by: UID, created_at: hoursAgo(30), updated_at: hoursAgo(30) },
      { id: 1, title: '内部草稿：国庆期间值班安排',
        body: '草稿内容，仅运营方可见，客户不应看到这一段。',
        level: 'important', published: false, created_by: UID, created_at: hoursAgo(50), updated_at: hoursAgo(50) }
    ],
    access_grants: [
      { id: 1, owner_id: UID, email: EMAIL, status: 'active', plan: 'standard',
        expires_at: hoursAgo(-24 * 300), created_at: hoursAgo(240), updated_at: hoursAgo(240) }
    ],
    operators: IS_OP ? [{ id: 1, owner_id: UID }] : [],
    datasets: []
  };

  function rlsDeny(table) {
    return { data: null, error: { message: 'new row violates row-level security policy for table "' + table + '"', code: '42501' } };
  }
  // 非运营方看不到草稿 —— 这一层在真库里由策略完成，这里等语义复刻
  function visible(table, rows) {
    if (table === 'notifications' && !IS_OP) {
      rows = rows.filter(function (r) { return r.published !== false; });
    }
    return rows;
  }

  function table(name) {
    var st = { op: null, payload: null, filters: [], order: null, limit: null };
    function hit() {
      var rows = visible(name, (DB[name] || []).slice());
      return rows.filter(function (r) {
        return st.filters.every(function (f) { return String(r[f.col]) === String(f.val); });
      });
    }
    function done(rows, logline) {
      if (st.order) {
        rows.sort(function (a, b) {
          var av = String(a[st.order.col] || ''), bv = String(b[st.order.col] || '');
          if (av === bv) return 0;
          return (av < bv ? -1 : 1) * (st.order.asc ? 1 : -1);
        });
      }
      if (st.limit) rows = rows.slice(0, st.limit);
      LOG.push(logline);
      return Promise.resolve({ data: rows, error: null });
    }
    var api = {
      select: function () { if (!st.op) st.op = 'select'; return api; },
      insert: function (o) { st.op = 'insert'; st.payload = o; return api; },
      update: function (o) { st.op = 'update'; st.payload = o; return api; },
      'delete': function () { st.op = 'delete'; return api; },
      eq: function (c, v) { st.filters.push({ col: c, val: v }); return api; },
      order: function (c, o) { st.order = { col: c, asc: !(o && o.ascending === false) }; return api; },
      limit: function (n) { st.limit = n; return api; },
      then: function (res, rej) { return run().then(res, rej); }
    };
    function run() {
      if (st.op === 'select') {
        var rows = hit();
        return done(rows, name + '.select(' + st.filters.length + ') → ' + rows.length + ' 行');
      }
      if (st.op === 'insert') {
        if (name === 'notifications' && !IS_OP) { LOG.push(name + '.insert → 被 RLS 拒绝 42501'); return Promise.resolve(rlsDeny(name)); }
        // 记下字段名：身份列（created_by / owner_id）应当由服务端 auth.uid() 默认值填，
        // 客户端一旦自己传，线上就出过 "invalid input syntax for type uuid" —— 这里留个哨兵。
        LOG.push(name + '.insert keys=' + Object.keys(st.payload).join(','));
        var row = Object.assign({ id: ++SEQ, created_at: new Date().toISOString() }, st.payload);
        (DB[name] = DB[name] || []).unshift(row);
        LOG.push(name + '.insert → ok id=' + row.id + ' «' + row.title + '»');
        return Promise.resolve({ data: [row], error: null });
      }
      if (st.op === 'update') {
        if (name === 'notifications' && !IS_OP) { LOG.push(name + '.update → 被 RLS 拒绝 42501'); return Promise.resolve(rlsDeny(name)); }
        var hitRows = hit();
        hitRows.forEach(function (r) { Object.assign(r, st.payload); });
        LOG.push(name + '.update → ' + hitRows.length + ' 行');
        return done(hitRows, name + '.update done');
      }
      if (st.op === 'delete') {
        if (name === 'notifications' && !IS_OP) { LOG.push(name + '.delete → 被 RLS 拒绝 42501'); return Promise.resolve(rlsDeny(name)); }
        var del = hit();
        DB[name] = (DB[name] || []).filter(function (r) { return del.indexOf(r) < 0; });
        LOG.push(name + '.delete → ' + del.length + ' 行');
        return done(del, name + '.delete done');
      }
      return Promise.resolve({ data: null, error: { message: 'unsupported op' } });
    }
    return api;
  }

  var SENT = [];
  window.__SENT = SENT;
  window.__DB = DB;
  /* 驱动脚本用它模拟"运营方刚发了一条新通知"（绕过 RLS，等价于运营方在运营台提交） */
  window.__pushNotif = function (title, level, published) {
    var row = { id: ++SEQ, title: title, body: title + ' —— 正文第一行。\\n正文第二行，用来验证换行保留。',
      level: level || 'info', published: published !== false, created_by: UID,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    DB.notifications.unshift(row);
    LOG.push('__pushNotif «' + title + '» id=' + row.id);
    return row.id;
  };
  window.WorkBuddyCloud = {
    createWorkBuddyCloud: function () {
      return {
        auth: {
          getUser: function () { return Promise.resolve({ data: { user: { id: UID, email: EMAIL } } }); },
          getSession: function () { return Promise.resolve({ data: { user: { id: UID, email: EMAIL } } }); },
          signOut: function () { return Promise.resolve({ data: {} }); },
          onAuthStateChange: function () {},
          sendOtp: function () { SENT.push('sendOtp'); return Promise.resolve({ data: { verificationId: 'v-1', isExistingUser: false } }); },
          signInWithOtp: function () { SENT.push('signInWithOtp'); return Promise.resolve({ data: { verify: function () { return Promise.resolve({ data: {} }); } } }); },
          resetPasswordForEmail: function () { SENT.push('resetPasswordForEmail'); return Promise.resolve({ data: { updateUser: function () { return Promise.resolve({ data: {} }); } } }); },
          verifyOtp: function () { return Promise.resolve({ data: {} }); },
          signInWithPassword: function () { return Promise.resolve({ data: {} }); }
        },
        database: { from: table },
        storage: {
          userPath: function (u, p) { return u + '/' + p; },
          upload: function () { return Promise.resolve({ data: {}, error: null }); }
        }
      };
    }
  };
  /* 是否预先把现有通知全部记为"已弹过"。
     给「通知功能/冷却」那两个用例用 true —— 它们要的是铃铛浮窗与详情弹窗的原始状态，
     不应该被"进首页自动弹窗"插一脚；自动弹窗另有专门的用例覆盖。 */
  if (__MARK_POPPED__) {
    try {
      localStorage.setItem('cu_notif_popped.' + UID,
        JSON.stringify(DB.notifications.map(function (n) { return String(n.id); })));
    } catch (e) {}
  }
  /* app.js 的启动自检要求 XLSX 存在；这里只用到"存在"，不点模板按钮 */
  window.XLSX = {
    read: function () { return {}; },
    utils: { book_new: function () { return {}; }, aoa_to_sheet: function () { return {}; }, book_append_sheet: function () {} },
    writeFile: function () {}
  };
})();
</script>
"""

DRIVER = """
<pre id="tb" style="position:fixed;left:0;bottom:0;z-index:9999;background:#000;color:#0f0;font:11px/1.5 monospace;max-height:60vh;overflow:auto;white-space:pre-wrap">pending</pre>
<script>
(function () {
  var IS_OP = __IS_OP__;
  var LOG = [], FAILS = 0;
  function W(id) { return document.getElementById(id); }
  function say(s) { LOG.push(s); }
  function chk(name, cond, extra) {
    if (!cond) FAILS++;
    say((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  }
  function wait(cond, cb, n) {
    n = n || 0;
    if (cond()) return cb();
    if (n > 100) return cb('TIMEOUT');
    setTimeout(function () { wait(cond, cb, n + 1); }, 100);
  }
  function items() { return [].slice.call(document.querySelectorAll('#notifList .nitem')); }
  function rows() { return [].slice.call(document.querySelectorAll('#notifAdminBody tr')); }
  function finish() {
    say('');
    say('FAILS=' + FAILS);
    say('判定=' + (FAILS ? 'FAIL' : 'PASS'));
    say('DONE');
    W('tb').textContent = LOG.join('\\n');
    document.title = (FAILS ? 'FAIL' : 'PASS') + ' fails=' + FAILS;
  }

  say('视角=' + (IS_OP ? '运营方' : '普通客户'));
  wait(function () { return W('viewApp') && !W('viewApp').classList.contains('hidden'); }, function (t) {
    if (t === 'TIMEOUT') { say('FAIL 应用没进到看板界面'); finish(); return; }
    try { step1(); } catch (e) { say('EXC ' + e); finish(); }
  });

  function step1() {
    say('--- 1. 进入应用 / 运营台可见性 ---');
    chk('已登录账号显示', W('meWho').textContent.trim().length > 0, W('meWho').textContent.trim());
    chk('订阅状态', W('mePlan').textContent.indexOf('剩余') >= 0 || W('mePlan').textContent.indexOf('开通') >= 0, W('mePlan').textContent);
    var tabHidden = W('tabAdmin').classList.contains('hidden');
    chk('运营台标签可见性 = ' + IS_OP, tabHidden === !IS_OP, 'hidden=' + tabHidden);
    chk('通知列表已拉到数据', (window.__LOG || []).some(function (l) { return l.indexOf('notifications.select') >= 0; }),
      (window.__LOG || []).filter(function (l) { return l.indexOf('notifications') >= 0; }).join(' | '));
    step2();
  }

  function step2() {
    say('--- 2. 未读红点 ---');
    chk('铃铛存在', !!W('btnBell'));
    chk('未读红点显示', !W('bellDot').classList.contains('hidden'));
    say('    铃铛 title=' + W('btnBell').title);
    step3();
  }

  function step3() {
    say('--- 3. 点开浮窗列表 ---');
    W('btnBell').click();
    var it = items();
    chk('浮窗已展开', !W('notifPanel').classList.contains('hidden'));
    var want = IS_OP ? 3 : 2;
    chk('列表条数=' + want + '（草稿对非运营方不可见）', it.length === want, '实际 ' + it.length);
    if (it.length) {
      var prev = it[0].querySelector('.nprev').textContent;
      chk('首条缩略以省略号截断', prev.slice(-1) === '…', JSON.stringify(prev));
      chk('缩略长度受控 (<100)', prev.length < 100, prev.length);
      var full = '本次维护期间，看板渲染、文件上传、历史数据下载与成果导出会短暂不可用。\\n维护窗口为 17:00-19:00，维护完成后刷新页面即可恢复，已上传的数据不会丢失。\\n若维护结束后仍无法访问，请把页面上的用户 ID 发给管理员排查。';
      chk('缩略不等于全文（确实被截过）', prev.indexOf('用户 ID 发给管理员') < 0, prev);
      chk('未读标记数量>0', document.querySelectorAll('#notifList .nitem.unread').length > 0,
        document.querySelectorAll('#notifList .nitem.unread').length);
      if (!IS_OP) {
        var txt = W('notifList').textContent;
        chk('非运营方看不到草稿标题', txt.indexOf('内部草稿') < 0);
      }
    }
    chk('打开后红点消失', W('bellDot').classList.contains('hidden'));
    step4();
  }

  function step4() {
    say('--- 4. 点开详情 ---');
    var it = items();
    if (!it.length) { say('  (无条目，跳过)'); step5(); return; }
    it[0].click();
    var body = W('nBody').textContent;
    chk('详情弹窗已打开', !W('nModal').classList.contains('hidden'));
    chk('浮窗已收起', W('notifPanel').classList.contains('hidden'));
    chk('详情有标题', W('nTitle').textContent.length > 0, W('nTitle').textContent);
    chk('详情有级别徽章', W('nMeta').textContent.indexOf('提醒') >= 0 || W('nMeta').textContent.indexOf('通知') >= 0, W('nMeta').textContent);
    chk('详情正文为全文（含换行）', body.indexOf('\\n') >= 0 && body.indexOf('用户 ID 发给管理员') >= 0, JSON.stringify(body).slice(0, 90));
    W('nOk').click();
    chk('点「知道了」关闭详情', W('nModal').classList.contains('hidden'));
    step5();
  }

  function step5() {
    say('--- 5. 运营台：发布通知 ---');
    var nb = document.getElementById('notifAdminBody');
    if (IS_OP) {
      chk('运营台通知表已渲染', rows().length === 3, '行数 ' + rows().length);
      chk('含草稿行', nb.textContent.indexOf('草稿') >= 0);
      // 表单仍可操作（即使面板未激活，DOM 也在）
      W('nTitleIn').value = '自测：新增一条通知';
      W('nBodyIn').value = '第一行\\n第二行\\n第三行';
      W('nLevelIn').value = 'important';
      W('nPubIn').checked = true;
      W('btnNotifSave').click();
      wait(function () { return W('notifAdminBody') && rows().length === 4; }, function (t2) {
        if (t2 === 'TIMEOUT') { chk('发布后列表变成 4 行', false, '行数 ' + rows().length); }
        else { chk('发布后列表变成 4 行', true); }
        chk('新条目落在列表里', W('notifAdminBody').textContent.indexOf('自测：新增一条通知') >= 0);
        chk('客户侧列表也同步到 4 条', items().length === 4, '实际 ' + items().length);
        chk('最新一条排在最前', items().length > 0 && items()[0].textContent.indexOf('自测：新增一条通知') >= 0,
          items().length ? items()[0].textContent.slice(0, 30) : '');
        var log = (window.__LOG || []).join(' | ');
        chk('确实调用了 insert', log.indexOf('notifications.insert → ok') >= 0, log.slice(-160));
        // 线上真实故障的哨兵：created_by 曾按 uuid 建列，而平台 user.id 是 19 位数字字符串
        // → 运营方一发通知就报 invalid input syntax for type uuid。
        // 身份列一律交给服务端 auth.uid() 默认值，客户端不许自己传。
        var keys = ((log.match(/notifications\\.insert keys=([^|]*)/) || [])[1] || '').trim();
        chk('insert 字段集正确', keys === 'title,body,level,published,updated_at', keys);
        chk('insert 不携带身份列 created_by', keys.indexOf('created_by') < 0, keys);
        chk('insert 不携带身份列 owner_id', keys.indexOf('owner_id') < 0, keys);
        step6();
      });
    } else {
      chk('普通客户界面不渲染通知管理表', rows().length === 0, '行数 ' + rows().length);
      // 就算硬点按钮，也必须被后端拦下
      W('nTitleIn').value = '越权尝试';
      W('nBodyIn').value = '一个普通客户试图发通知';
      W('btnNotifSave').click();
      wait(function () { return W('toast').textContent.length > 0; }, function (t2) {
        var tt = W('toast').textContent;
        chk('越权发布被拒绝（有提示）', t2 !== 'TIMEOUT' && tt.length > 0, tt.slice(0, 90));
        chk('提示是中文权限说明', tt.indexOf('没有发布通知的权限') >= 0, tt.slice(0, 90));
        chk('没有漏出英文 42501 原文', tt.indexOf('row-level security') < 0);
        step6();
      });
    }
  }

  function step6() {
    say('--- 6. 验证码 60 秒冷却 ---');
    if (window.CuAuth) CuAuth.setMode('signup');
    wait(function () { return !!W('act_send'); }, function (t) {
      if (t === 'TIMEOUT') { chk('注册表单出现', false); finish(); return; }
      chk('冷却前按钮可点', !W('act_send').disabled, W('act_send').textContent);
      W('f_email').value = '2778904358@qq.com';
      W('act_send').click();
      wait(function () { return W('act_send').disabled; }, function (t2) {
        chk('发送成功后按钮被禁用', t2 !== 'TIMEOUT', W('act_send').textContent);
        chk('按钮显示倒计时文案', /重新发送\\s*\\d+s/.test(W('act_send').textContent), W('act_send').textContent);
        var t1 = W('act_send').textContent;
        chk('确实发了一次验证码', (window.__SENT || []).indexOf('sendOtp') >= 0, JSON.stringify(window.__SENT));

        // 关键点：表单是整块重绘的，冷却必须活过重绘
        var before = W('act_send');
        CuAuth.setMode('forgot');
        wait(function () { return W('act_send') && W('act_send') !== before; }, function (t3) {
          chk('切换表单后按钮已换成新的', t3 !== 'TIMEOUT');
          chk('换表单后冷却仍然生效', W('act_send').disabled, W('act_send').textContent);
          chk('换表单后倒计时继续走', /重新发送\\s*\\d+s/.test(W('act_send').textContent), W('act_send').textContent);
          var n1 = parseInt(W('act_send').textContent.replace(/\\D/g, ''), 10);
          chk('倒计时从 60 起算（<=60）', n1 <= 60 && n1 >= 55, n1);
          // 冷却期内硬点。分两步：先证明 disabled 挡住了；
          // 再把 disabled 摘掉点，证明函数里那道闸也在拦（不只是个 HTML 属性）。
          var sent0 = (window.__SENT || []).length;
          W('act_send').click();
          setTimeout(function () {
            chk('禁用态点击不发请求', (window.__SENT || []).length === sent0, JSON.stringify(window.__SENT));
            W('act_send').disabled = false;
            W('act_send').click();
            setTimeout(function () {
              chk('绕过 disabled 仍不发请求（函数内有闸）', (window.__SENT || []).length === sent0, JSON.stringify(window.__SENT));
              chk('绕过 disabled 后给中文等待提示', W('authMsg').textContent.indexOf('请等待') >= 0, W('authMsg').textContent.slice(0, 60));
              chk('倒计时较 t1 递减', parseInt(W('act_send').textContent.replace(/\\D/g, ''), 10) <= n1, W('act_send').textContent);
              chk('忘记密码模式也没发出重置码', (window.__SENT || []).indexOf('resetPasswordForEmail') < 0, JSON.stringify(window.__SENT));
              finish();
            }, 500);
          }, 900);
        });
      });
    });
  }
})();
</script>
"""


SHOT = """
<script>
(function () {
  function W(id) { return document.getElementById(id); }
  function wait(cond, cb, n) {
    n = n || 0;
    if (cond()) return cb();
    if (n > 100) { document.title = 'SHOT TIMEOUT'; return; }
    setTimeout(function () { wait(cond, cb, n + 1); }, 100);
  }
  var MODE = '__MODE__';
  wait(function () { return W('viewApp') && !W('viewApp').classList.contains('hidden'); }, function () {
    if (MODE === 'plain') {
      // 什么都不点：等"进首页自动弹出"自己出现
      document.title = 'SHOT autopop ready';
      return;
    }
    if (MODE === 'admin') {
      document.querySelector('.app-tab[data-tab="admin"]').click();
      document.title = 'SHOT admin ready';
      return;
    }
    if (MODE === 'cool') {
      // 认证表单在 #viewAuth 里，看板显示时它是隐藏的 —— 截图前先切过去
      W('viewApp').classList.add('hidden');
      W('viewAuth').classList.remove('hidden');
      if (window.CuAuth) CuAuth.setMode('signup');
      setTimeout(function () {
        W('f_email').value = '2778904358@qq.com';
        W('act_send').click();
        document.title = 'SHOT cool ready';
      }, 300);
      return;
    }
    W('btnBell').click();
    if (MODE === 'detail') {
      setTimeout(function () {
        var it = document.querySelectorAll('#notifList .nitem');
        if (it.length) it[0].click();
        document.title = 'SHOT detail ready';
      }, 500);
    } else {
      document.title = 'SHOT panel ready';
    }
  });
})();
</script>
"""


AUTOPOP_DRIVER = """
<pre id="tb" style="position:fixed;left:0;bottom:0;z-index:9999;background:#000;color:#0f0;font:11px/1.5 monospace;max-height:60vh;overflow:auto;white-space:pre-wrap">pending</pre>
<script>
(function () {
  var LOG = [], FAILS = 0;
  function W(id) { return document.getElementById(id); }
  function say(s) { LOG.push(s); }
  function chk(name, cond, extra) {
    if (!cond) FAILS++;
    say((cond ? 'PASS ' : 'FAIL ') + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  }
  function wait(cond, cb, n) {
    n = n || 0;
    if (cond()) return cb();
    if (n > 100) return cb('TIMEOUT');
    setTimeout(function () { wait(cond, cb, n + 1); }, 100);
  }
  function modalOpen() { return !W('nModal').classList.contains('hidden'); }
  function panelOpen() { return !W('notifPanel').classList.contains('hidden'); }
  function items() { return [].slice.call(document.querySelectorAll('#notifList .nitem')); }
  function tabTo(n) { document.querySelector('.app-tab[data-tab="' + n + '"]').click(); }
  function popped() {
    try { return JSON.parse(localStorage.getItem('cu_notif_popped.u-0001-0001') || '[]'); } catch (e) { return []; }
  }
  function finish() {
    say('');
    say('FAILS=' + FAILS);
    say('判定=' + (FAILS ? 'FAIL' : 'PASS'));
    say('DONE');
    W('tb').textContent = LOG.join('\\n');
    document.title = (FAILS ? 'FAIL' : 'PASS') + ' fails=' + FAILS;
  }

  say('用例=新通知进首页自动弹出（普通客户视角，预置 2 条已发布 + 1 条草稿）');

  /* ---- 1. 刚进入首页（=刚登录 / 刷新回到主页）：应自动弹出 ---- */
  wait(function () { return modalOpen(); }, function (t) {
    if (t === 'TIMEOUT') { chk('进入首页后自动弹出', false); finish(); return; }
    try { step1(); } catch (e) { say('EXC ' + e); finish(); }
  });

  function step1() {
    say('--- 1. 进入首页自动弹出 ---');
    chk('弹窗自动出现', modalOpen());
    chk('带「新通知」标记', W('nMeta').textContent.indexOf('新通知') >= 0, W('nMeta').textContent);
    chk('金色描边样式已挂上', W('nModal').querySelector('.ncard').classList.contains('auto'));
    chk('弹的是最新的那条', W('nTitle').textContent.indexOf('系统维护通知') >= 0, W('nTitle').textContent);
    chk('正文换行保留', W('nBody').textContent.indexOf('\\n') >= 0);
    chk('两条新的 → 底部提示还有 1 条', W('nOk').textContent.indexOf('还有 1 条') >= 0, W('nOk').textContent);
    chk('「查看全部」按钮可见', !W('nMore').classList.contains('hidden'));
    chk('草稿未被计入待弹', popped().length === 2, JSON.stringify(popped()));
    step2();
  }

  function step2() {
    say('--- 2. 点「查看全部新通知」 ---');
    W('nMore').click();
    chk('详情弹窗关闭', !modalOpen());
    chk('铃铛浮窗被摊开', panelOpen());
    chk('浮窗列出 2 条', items().length === 2, items().length);
    W('btnBell').click();
    chk('再点铃铛可收起', !panelOpen());
    step3();
  }

  function step3() {
    say('--- 3. 切走再切回：已弹过的不再弹 ---');
    tabTo('history');
    tabTo('dash');
    setTimeout(function () {
      chk('已弹过的通知不重复弹', !modalOpen());
      step4();
    }, 1100);
  }

  function step4() {
    say('--- 4. 运营方新发一条 → 切回首页弹出这条 ---');
    window.__pushNotif('【重要】夜盘交易时段调整', 'important');
    tabTo('upload');
    tabTo('dash');
    wait(function () { return modalOpen(); }, function (t) {
      chk('新通知在切回首页时自动弹出', t !== 'TIMEOUT');
      if (t !== 'TIMEOUT') {
        chk('弹的是新发的那条', W('nTitle').textContent.indexOf('夜盘交易时段调整') >= 0, W('nTitle').textContent);
        chk('级别=重要', W('nMeta').textContent.indexOf('重要') >= 0, W('nMeta').textContent);
        chk('只 1 条新的 → 无「还有 n 条」', W('nOk').textContent === '知道了', W('nOk').textContent);
        chk('「查看全部」按钮隐藏', W('nMore').classList.contains('hidden'));
      }
      W('nOk').click();
      chk('点「知道了」关闭弹窗', !modalOpen());
      step5();
    });
  }

  function step5() {
    say('--- 5. 先打开过铃铛列表 → 之后不再自动弹 ---');
    window.__pushNotif('数据模板 v2 已更新', 'info');
    tabTo('history');
    tabTo('dash');
    // 抢在 450ms 自动弹之前把浮窗摊开，模拟"用户自己先点了铃铛"
    W('btnBell').click();
    wait(function () { return W('notifList').textContent.indexOf('数据模板 v2 已更新') >= 0; }, function (t) {
      chk('浮窗里已列出刚发的通知', t !== 'TIMEOUT');
      chk('用户正开着列表 → 不叠加自动弹窗', !modalOpen());
      W('btnBell').click();
      tabTo('upload');
      tabTo('dash');
      setTimeout(function () {
        chk('看过列表后不再自动弹', !modalOpen(),
          modalOpen() ? ('弹出的是：' + W('nTitle').textContent) : '');
        say('    popped=' + JSON.stringify(popped()));
        step6();
      }, 1100);
    });
  }

  function step6() {
    say('--- 6. 草稿永远不自动弹 ---');
    window.__pushNotif('草稿：这条不该弹出来', 'warn', false);
    tabTo('history');
    tabTo('dash');
    setTimeout(function () {
      chk('草稿不自动弹出', !modalOpen(),
        modalOpen() ? ('弹出的是：' + W('nTitle').textContent) : '');
      say('    popped=' + JSON.stringify(popped()));
      chk('草稿但仍可被运营台看到（列表总数=4）', items().length === 4, items().length);
      finish();
    }, 1200);
  }
})();
</script>
"""


def fake_src(is_op, mark_popped=True):
    return (FAKE.replace("__IS_OP__", "true" if is_op else "false")
                .replace("__MARK_POPPED__", "true" if mark_popped else "false"))


def build(is_op, dest_name):
    html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    assert SDK_CDN in html, "未找到云 SDK 的 CDN script 标签"
    assert XLSX_CDN in html, "未找到 XLSX 的 CDN script 标签"
    html = html.replace(SDK_CDN, fake_src(is_op, True), 1)
    html = html.replace(XLSX_CDN, "", 1)
    html = html + DRIVER.replace("__IS_OP__", "true" if is_op else "false")
    dest = os.path.join(BUILD, dest_name)
    io.open(dest, "w", encoding="utf-8").write(html)
    print("saved:", dest, len(html), "chars")


def build_autopop():
    html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    html = html.replace(SDK_CDN, fake_src(False, False), 1)
    html = html.replace(XLSX_CDN, "", 1)
    html = html + AUTOPOP_DRIVER
    dest = os.path.join(BUILD, "notif_autopop.html")
    io.open(dest, "w", encoding="utf-8").write(html)
    print("saved:", dest, len(html), "chars")


def build_shot(is_op, mode, dest_name, mark_popped=True):
    html = io.open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()
    html = html.replace(SDK_CDN, fake_src(is_op, mark_popped), 1)
    html = html.replace(XLSX_CDN, "", 1)
    html = html + SHOT.replace("__MODE__", mode)
    dest = os.path.join(BUILD, dest_name)
    io.open(dest, "w", encoding="utf-8").write(html)
    print("saved:", dest, len(html), "chars")


build(True, "notif_flow_op.html")
build(False, "notif_flow_user.html")
build_autopop()
build_shot(True, "panel", "notif_shot_panel.html")
build_shot(True, "detail", "notif_shot_detail.html")
build_shot(True, "admin", "notif_shot_admin.html")
build_shot(True, "cool", "notif_shot_cool.html")
# 自动弹窗那一张：不预置"已弹过"，让它自己弹出来
build_shot(False, "plain", "notif_shot_autopop.html", mark_popped=False)
