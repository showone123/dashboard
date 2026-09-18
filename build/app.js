/* ==========================================================================
   订阅版数据看板 · 应用逻辑
   模块：Auth 登录注册 / 权限门禁 / 文件上传 / 看板渲染 / 历史数据 / 运营台
   ========================================================================== */
(function () {
  'use strict';

  /* ---------- 由云服务开通结果返回的 publicConfig（可安全下发到前端） ---------- */
  var PUBLIC_CONFIG = {
    endpoint: 'https://data-dashboard-85191.app.workbuddy.host',
    publishableKey: 'wbpk_SzEJc2waV6zqr78qhIU3M1_EsOOC55rzH5Grlz0kErY9VMacOE30GRa'
  };

  var MAX_UPLOAD = 8 * 1024 * 1024; // 铜看板数据 8MB
  var RISK_MAX_UPLOAD = 20 * 1024 * 1024; // 风险日志行数较多，独立上限 20MB

  var cloud = WorkBuddyCloud.createWorkBuddyCloud({
    endpoint: PUBLIC_CONFIG.endpoint,
    publishableKey: PUBLIC_CONFIG.publishableKey
  });

  /* ---------- 状态 ---------- */
  var S = {
    userId: null, userEmail: '', grant: null, isOperator: false,
    data: null, dataSource: '示例数据（铜）', datasets: [], pending: null, mounted: false,
    riskData: null, riskSource: '', riskFiltered: []
  };

  /* ---------- 工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function maskEmail(e) {
    if (!e) return '—';
    var at = e.indexOf('@');
    if (at < 1) return e;
    var n = e.slice(0, at), d = e.slice(at);
    return (n.length <= 2 ? n[0] + '*' : n.slice(0, 2) + '***') + d;
  }
  function fmtSize(b) {
    if (b === null || b === undefined) return '—';
    b = Number(b);
    if (b < 1024) return b + ' B';
    if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
    return (b / 1024 / 1024).toFixed(2) + ' MB';
  }
  function fmtTime(t) {
    if (!t) return '—';
    var d = new Date(t);
    if (isNaN(d.getTime())) return String(t);
    var z = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }
  function daysLeft(iso) {
    if (!iso) return null;
    var ms = new Date(iso).getTime() - Date.now();
    if (isNaN(ms)) return null;
    return Math.ceil(ms / 86400000);
  }
  function toast(kind, text, ms) {
    var wrap = $('toast');
    var el = document.createElement('div');
    el.className = 'item ' + kind;
    el.textContent = text;
    wrap.appendChild(el);
    setTimeout(function () { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; }, (ms || 4200) - 300);
    setTimeout(function () { el.remove(); }, ms || 4200);
  }
  function busy(on, txt) {
    $('busyTxt').textContent = txt || '处理中…';
    $('busy').classList.toggle('show', !!on);
  }
  function show(id) { $(id).classList.remove('hidden'); }
  function hide(id) { $(id).classList.add('hidden'); }
  function copyText(t) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () { return fallbackCopy(t); });
    }
    return Promise.resolve(fallbackCopy(t));
  }
  function fallbackCopy(t) {
    try {
      var ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove(); return true;
    } catch (e) { return false; }
  }
  function saveBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ---------- 明暗主题与环境粒子 ---------- */
  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  }
  function syncThemeControls() {
    var dark = currentTheme() === 'dark';
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.setAttribute('aria-pressed', dark ? 'true' : 'false');
      b.setAttribute('title', dark ? '切换到浅色主题' : '切换到深色主题');
      var label = b.querySelector('[data-theme-label]');
      if (label) label.textContent = dark ? '深色' : '浅色';
    });
  }
  function applyTheme(theme, refreshDashboard) {
    var next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    syncThemeControls();
    if (refreshDashboard && S.data && S.mounted && $('cuRoot')) {
      var active = $('cuRoot').querySelector('.nav-item.active');
      var page = active ? active.getAttribute('data-page') : 'p1';
      CuRender.mount($('cuRoot'), S.data);
      var target = $('cuRoot').querySelector('.nav-item[data-page="' + page + '"]');
      if (target && page !== 'p1') target.click();
    }
  }
  function toggleTheme() {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark', true);
  }
  function createLoginParticles() {
    var canvas = $('authParticles');
    if (!canvas || !canvas.getContext || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d'), particles = [], w = 0, h = 0, dpr = 1;
    var mouse = { x: -9999, y: -9999 };
    function seed() {
      var count = Math.max(72, Math.min(150, Math.floor(w * h / 10500)));
      particles = [];
      for (var i = 0; i < count; i++) particles.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: .16 + Math.random() * .34, vy: 0,
        phase: Math.random() * Math.PI * 2, size: .65 + Math.random() * 1.35
      });
    }
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2); w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); seed();
    }
    function draw() {
      ctx.clearRect(0, 0, w, h);
      var light = currentTheme() === 'light';
      for (var i = 0; i < particles.length; i++) {
        var p = particles[i];
        var field = Math.sin(p.x * .004 + p.phase) + Math.cos(p.y * .006 - p.phase * .7);
        p.vy += field * .006; p.vy *= .975; p.x += p.vx; p.y += p.vy;
        var dx = p.x - mouse.x, dy = p.y - mouse.y, dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 110) { p.x += dx / (dist || 1) * .32; p.y += dy / (dist || 1) * .32; }
        if (p.x > w + 12) { p.x = -12; p.y = Math.random() * h; }
        if (p.y > h + 12) p.y = -12; if (p.y < -12) p.y = h + 12;
      }
      for (var a = 0; a < particles.length; a++) for (var b = a + 1; b < particles.length; b++) {
        var pa = particles[a], pb = particles[b], lx = pa.x - pb.x, ly = pa.y - pb.y, ld = lx * lx + ly * ly;
        if (ld < 6200) {
          var alpha = (1 - ld / 6200) * (light ? .13 : .2);
          ctx.strokeStyle = light ? 'rgba(76,104,205,' + alpha + ')' : 'rgba(112,145,255,' + alpha + ')';
          ctx.lineWidth = .7; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke();
        }
      }
      for (var j = 0; j < particles.length; j++) {
        var q = particles[j], grad = ctx.createRadialGradient(q.x, q.y, 0, q.x, q.y, q.size * 4);
        grad.addColorStop(0, light ? 'rgba(65,100,220,.72)' : 'rgba(129,156,255,.88)');
        grad.addColorStop(.35, light ? 'rgba(32,173,190,.28)' : 'rgba(62,210,221,.38)');
        grad.addColorStop(1, 'rgba(70,120,255,0)');
        ctx.fillStyle = grad; ctx.beginPath(); ctx.arc(q.x, q.y, q.size * 4, 0, Math.PI * 2); ctx.fill();
      }
      window.requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize);
    window.addEventListener('pointermove', function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
    window.addEventListener('pointerleave', function () { mouse.x = -9999; mouse.y = -9999; });
    resize(); window.requestAnimationFrame(draw);
  }
  function createAmbientParticles() {
    var canvas = $('appParticles');
    if (!canvas || !canvas.getContext || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var ctx = canvas.getContext('2d'), particles = [], w = 0, h = 0, dpr = 1;
    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2); w = window.innerWidth; h = window.innerHeight;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + 'px'; canvas.style.height = h + 'px';
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0); particles = [];
      var count = Math.max(34, Math.min(68, Math.floor(w * h / 22000)));
      for (var i = 0; i < count; i++) particles.push({ x: Math.random() * w, y: Math.random() * h, speed: .07 + Math.random() * .15, phase: Math.random() * 6.28, size: .45 + Math.random() * .7 });
    }
    function draw() {
      ctx.clearRect(0, 0, w, h); var light = currentTheme() === 'light';
      for (var i = 0; i < particles.length; i++) { var p = particles[i]; p.x += p.speed; p.y += Math.sin(p.x * .003 + p.phase) * .035; if (p.x > w + 8) { p.x = -8; p.y = Math.random() * h; } }
      for (var a = 0; a < particles.length; a++) for (var b = a + 1; b < particles.length; b++) {
        var pa = particles[a], pb = particles[b], dx = pa.x - pb.x, dy = pa.y - pb.y, dist = dx * dx + dy * dy;
        if (dist < 8400) { var alpha = (1 - dist / 8400) * (light ? .045 : .075); ctx.strokeStyle = light ? 'rgba(79,107,208,' + alpha + ')' : 'rgba(103,135,240,' + alpha + ')'; ctx.lineWidth = .55; ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(pb.x, pb.y); ctx.stroke(); }
      }
      for (var j = 0; j < particles.length; j++) { var q = particles[j]; ctx.fillStyle = light ? 'rgba(74,105,213,.14)' : 'rgba(111,145,255,.2)'; ctx.beginPath(); ctx.arc(q.x, q.y, q.size, 0, Math.PI * 2); ctx.fill(); }
      window.requestAnimationFrame(draw);
    }
    window.addEventListener('resize', resize); resize(); window.requestAnimationFrame(draw);
  }

  /* ==================== 认证界面 ==================== */
  var authMode = 'login-password';
  var otpCtx = {};
  var pendingEmail = '';

  /* ---------- 验证码发送冷却 ----------
     平台自己有频控，但连点只会换来一句"操作过于频繁"，用户不知道要等多久。
     这里在按钮上直接倒计时：点不动就是点不动，而且能看见还剩几秒。
     冷却状态放在模块级（不随 renderAuth 重建表单而丢失）—— 表单是整块重绘的，
     若挂在 DOM 上，切一次"注册/忘记密码"倒计时就没了，等于形同虚设。 */
  var SEND_COOLDOWN_MS = 60000;
  var sendCool = { until: 0, timer: null };

  function sendLeft() { return Math.max(0, Math.ceil((sendCool.until - Date.now()) / 1000)); }

  function syncSendBtn() {
    var b = $('act_send');
    if (!b) return;
    var left = sendLeft();
    if (left > 0) {
      b.disabled = true;
      b.textContent = '重新发送 ' + left + 's';
      b.classList.add('cool');
    } else {
      b.disabled = false;
      b.classList.remove('cool');
      b.textContent = (authMode === 'forgot') ? '发送重置码' : '发送验证码';
      if (sendCool.timer) { clearInterval(sendCool.timer); sendCool.timer = null; }
    }
  }

  function startCooldown() {
    sendCool.until = Date.now() + SEND_COOLDOWN_MS;
    if (sendCool.timer) clearInterval(sendCool.timer);
    syncSendBtn();
    // 250ms 一跳：秒数变化跟得上，又不会白烧 CPU
    sendCool.timer = setInterval(syncSendBtn, 250);
  }

  function isRateLimited(error) {
    if (!error) return false;
    var k = error.kind || '', c = errCode(error).toUpperCase();
    if (c === 'RATE_LIMITED' || k === 'rate_limited') return true;
    return /rate|frequen|too many|try again later/i.test(String(error.message || ''));
  }

  /* 顶部「登录/注册」分段控件与表单共用同一个状态。
     以前它是靠 querySelector('[data-go="signup"]') 去"点"表单里的链接，
     而登录面板里并没有这个链接 → 点顶部「注册」只是高亮了按钮、表单没换，
     用户于是在"登录表单"上填邮箱+密码想注册，拿到一句英文报错。
     现在统一走这里，分段高亮由 syncAuthSeg() 依据真实状态回写。 */
  function setAuthMode(m) { authMode = m; renderAuth(); }
  window.CuAuth = { setMode: setAuthMode, getMode: function () { return authMode; } };

  function syncAuthSeg() {
    var isSignup = (authMode === 'signup');
    var L = $('segLogin'), G = $('segSignup');
    if (L && G) { L.classList.toggle('on', !isSignup); G.classList.toggle('on', isSignup); }
  }

  function renderAuth() {
    var html = '';
    if (authMode === 'login-password') {
      html = '' +
        '<div class="field"><label>邮箱</label><input id="f_email" type="email" autocomplete="username" placeholder="you@example.com"/></div>' +
        '<div class="field"><label>密码</label><input id="f_pwd" type="password" autocomplete="current-password" placeholder="请输入密码"/></div>' +
        '<div class="actions"><button class="btn primary" id="act_login">登录</button></div>' +
        '<div class="linkline"><button data-go="login-otp">用邮箱验证码登录</button><button data-go="signup">注册新账号</button><button data-go="forgot">忘记密码？</button></div>';
    } else if (authMode === 'login-otp') {
      html = '' +
        '<div class="field"><label>邮箱</label><input id="f_email" type="email" autocomplete="username" placeholder="you@example.com"/></div>' +
        '<div class="field"><label>验证码</label><div class="code-row"><input id="f_code" inputmode="numeric" placeholder="6 位验证码"/><button class="btn sm" id="act_send">发送验证码</button></div></div>' +
        '<div class="actions"><button class="btn primary" id="act_otp_login">验证并登录</button></div>' +
        '<div class="linkline"><button data-go="login-password">用密码登录</button><button data-go="signup">还没有账号？注册</button></div>';
    } else if (authMode === 'signup') {
      html = '' +
        '<div class="field"><label>邮箱</label><input id="f_email" type="email" autocomplete="username" placeholder="you@example.com"/></div>' +
        '<div class="field"><label>验证码</label><div class="code-row"><input id="f_code" inputmode="numeric" placeholder="6 位验证码"/><button class="btn sm" id="act_send">发送验证码</button></div></div>' +
        '<div class="field"><label>设置密码</label><input id="f_pwd" type="password" autocomplete="new-password" placeholder="至少 6 位"/></div>' +
        '<div class="actions"><button class="btn primary" id="act_signup">注册并登录</button></div>' +
        '<div class="linkline"><button data-go="login-password">已有账号？去登录</button></div>';
    } else {
      html = '' +
        '<div class="field"><label>注册邮箱</label><input id="f_email" type="email" autocomplete="username" placeholder="you@example.com"/></div>' +
        '<div class="field"><label>重置码</label><div class="code-row"><input id="f_code" inputmode="numeric" placeholder="邮件中的重置码"/><button class="btn sm" id="act_send">发送重置码</button></div></div>' +
        '<div class="field"><label>新密码</label><input id="f_pwd" type="password" autocomplete="new-password" placeholder="至少 6 位"/></div>' +
        '<div class="actions"><button class="btn primary" id="act_reset">设置并登录</button></div>' +
        '<div class="linkline"><button data-go="login-password">返回登录</button>' +
        (S.userId ? '<button id="act_backapp">返回看板</button>' : '') +
        '</div>';
    }
    $('authForm').innerHTML = html;
    $('authMsg').className = 'msg';
    $('authMsg').textContent = '';

    // 从"密码登录失败/登录后主动设置"跳过来时，把邮箱预填好，省得用户再输一遍
    if (authMode === 'forgot' && pendingEmail) {
      var pe = $('f_email');
      if (pe) pe.value = pendingEmail;
    }

    $('authForm').querySelectorAll('[data-go]').forEach(function (b) {
      b.addEventListener('click', function () { authMode = b.getAttribute('data-go'); renderAuth(); });
    });
    var send = $('act_send'); if (send) send.addEventListener('click', onSendCode);
    var L = $('act_login'); if (L) L.addEventListener('click', onPasswordLogin);
    var O = $('act_otp_login'); if (O) O.addEventListener('click', onOtpLogin);
    var G = $('act_signup'); if (G) G.addEventListener('click', onSignup);
    var R = $('act_reset'); if (R) R.addEventListener('click', onReset);
    var B = $('act_backapp'); if (B) B.addEventListener('click', function () { pendingEmail = ''; afterSignIn(); });
    syncAuthSeg();
    // 表单是整块重绘的，新按钮默认是可用状态 —— 冷却期内必须当场按回去
    syncSendBtn();
  }

  function authMsg(kind, text) {
    var el = $('authMsg');
    el.className = 'msg show ' + kind;
    el.innerHTML = text;
  }
  function val(id) { var e = $(id); return e ? e.value.trim() : ''; }

  /* 后端的错误码比 message 可靠：message 有时是英文原文（如 user password not set）。
     实测 SDK 会把后端 body 重新包一层，形如：
       {kind:'invalid-request', message:'user password not set', status:400,
        code:'password_not_set',                      ← 小写，可用
        cause:{code:'PASSWORD_NOT_SET', error:'password_not_set', error_code:4029, ...}}
     顶层 code 是主要依据，cause 作为兜底（万一 SDK 后续不再复制 code）。 */
  function errCode(error) {
    if (!error) return '';
    var c = error.cause || {};
    return String(error.code || error.error || c.code || c.error ||
      (error.error_code ? String(error.error_code) : '') ||
      (c.error_code ? String(c.error_code) : '') || '');
  }
  /* 账号存在但没设过密码 —— 后端 code=PASSWORD_NOT_SET / error_code=4029。
     实测：这类账号都是"只用邮箱验证码登录/注册过"，平台不会自动补密码。 */
  function isPasswordNotSet(error) {
    if (!error) return false;
    var c = error.cause || {};
    if (errCode(error).toUpperCase() === 'PASSWORD_NOT_SET') return true;
    if (error.error_code === 4029 || c.error_code === 4029) return true;
    return /password[ _]?not[ _]?set/i.test(String(
      error.message || error.error_description || c.error_description || ''));
  }
  function isUserExists(error) {
    var c = (error && error.cause) || {};
    var s = errCode(error) + ' ' + String((error && (error.message || error.error_description)) || '') +
            ' ' + String(c.error_description || '');
    return /already|exist|registered|duplicate|taken/i.test(s);
  }

  function errText(error) {
    if (!error) return '操作失败，请稍后重试。';
    var k = error.kind || '', c = errCode(error).toUpperCase();
    if (k === 'network' || k === 'backend-unavailable') return '网络或服务暂时不可用，请稍后重试。';
    if (c === 'PASSWORD_NOT_SET') return '这个邮箱还没有设置密码，不能用密码登录。请点下面的「忘记密码？」重设一个。';
    if (c === 'INVALID_USERNAME_OR_PASSWORD' || k === 'invalid_grant' || k === 'unauthenticated') return '邮箱或密码不正确。';
    if (c === 'RATE_LIMITED' || k === 'rate_limited') return '操作过于频繁，请稍后再试。';
    var m = error.message || String(error);
    if (/rate|frequen|too many/i.test(m)) return '操作过于频繁，请稍后再试。';
    if (/invalid|not found|credential/i.test(m)) return '邮箱或密码不正确。';
    if (/expire/i.test(m)) return '验证码已过期，请重新获取。';
    if (/valid/i.test(m)) return '验证码不正确或已失效。';
    return m;
  }

  /* 给"没有密码"的账号一条能真正走通的路：
     实测平台给无密码账号设密码只有一条合法路径 —— 邮件重置码
     （resetPasswordForEmail → updateUser({nonce,password}) → POST /v1/reset）。
     resetPasswordForOld 需要旧密码，对无密码账号无效。 */
  function offerSetPassword(email, why) {
    pendingEmail = email || '';
    authMode = 'forgot';
    hide('viewApp'); hide('viewGate');
    show('viewAuth');
    renderAuth();
    var head;
    if (why === 'manual') head = '在这里给当前账号设置（或重设）一个登录密码。';
    else if (why === 'signup') head = '账号已经建好了，但平台没有保存这次设置的密码，所以现在还不能用密码登录。';
    else head = '这个邮箱还没有设置密码 —— 你之前应该只用邮箱验证码登录/注册过，平台不会自动补密码，所以现在不能用密码登录。';
    authMsg('warn', head +
      '<br/>点下面的「<b>发送重置码</b>」，去邮箱把重置码填回来并设一个新密码，之后就能用邮箱+密码登录了。');
  }

  async function onSendCode() {
    var left = sendLeft();
    if (left > 0) return authMsg('warn', '请等待 <b>' + left + '</b> 秒后再重新发送。');

    var email = val('f_email');
    if (!email) return authMsg('err', '请先填写邮箱。');
    if (authMode === 'signup') {
      busy(true, '正在发送验证码…');
      var r = await cloud.auth.sendOtp({ email: email });
      busy(false);
      if (r.error) {
        if (isRateLimited(r.error)) { startCooldown(); return authMsg('err', '发送过于频繁，已进入 60 秒冷却，请稍后再试。'); }
        return authMsg('err', errText(r.error));
      }
      startCooldown();
      otpCtx = { email: email, verificationId: r.data.verificationId, isExistingUser: r.data.isExistingUser };
      // 平台在"该邮箱已注册"时会走登录路径，verifyOtp 内部不会调用 signUp，
      // 也就是**不会设置密码**。这里如实说清，别让用户以为设了密码。
      if (r.data.isExistingUser) {
        authMsg('warn', '这个邮箱<b>已经注册过了</b>。继续填验证码会直接登录，<b>不会设置也不会改动密码</b>。' +
          '如果你想用密码登录，请先点下面的「<b>忘记密码？</b>」重设一次密码；或直接填验证码登录。');
      } else {
        authMsg('info', '验证码已发送到 <b>' + esc(maskEmail(email)) + '</b>，请查收邮件（含垃圾箱）。' +
          '<br/>60 秒内不能重复发送，按钮上会显示剩余秒数。');
      }
    } else if (authMode === 'login-otp') {
      busy(true, '正在发送验证码…');
      var r2 = await cloud.auth.signInWithOtp({ email: email });
      busy(false);
      if (r2.error) {
        if (isRateLimited(r2.error)) { startCooldown(); return authMsg('err', '发送过于频繁，已进入 60 秒冷却，请稍后再试。'); }
        return authMsg('err', errText(r2.error));
      }
      startCooldown();
      otpCtx = { email: email, verify: r2.data.verify };
      authMsg('info', '验证码已发送到 <b>' + esc(maskEmail(email)) + '</b>，请查收邮件。' +
        '<br/>60 秒内不能重复发送，按钮上会显示剩余秒数。');
    } else {
      busy(true, '正在发送重置码…');
      var r3 = await cloud.auth.resetPasswordForEmail(email);
      busy(false);
      if (r3.error) {
        if (isRateLimited(r3.error)) { startCooldown(); return authMsg('err', '发送过于频繁，已进入 60 秒冷却，请稍后再试。'); }
        return authMsg('err', errText(r3.error));
      }
      startCooldown();
      otpCtx = { email: email, updateUser: r3.data.updateUser };
      authMsg('info', '重置码已发送到 <b>' + esc(maskEmail(email)) + '</b>。<br/>60 秒内不能重复发送，按钮上会显示剩余秒数。');
    }
  }

  async function onPasswordLogin() {
    var email = val('f_email'), pwd = val('f_pwd');
    if (!email || !pwd) return authMsg('err', '请填写邮箱和密码。');
    busy(true, '正在登录…');
    var r = await cloud.auth.signInWithPassword({ email: email, password: pwd });
    busy(false);
    if (r.error) {
      // 账号存在但没设过密码：只丢一句英文报错就是死胡同，直接给出路
      if (isPasswordNotSet(r.error)) return offerSetPassword(email, 'login');
      return authMsg('err', errText(r.error));
    }
    pendingEmail = '';
    await afterSignIn();
  }

  async function onOtpLogin() {
    var code = val('f_code');
    if (!otpCtx.verify) return authMsg('err', '请先点击「发送验证码」。');
    if (!code) return authMsg('err', '请输入验证码。');
    busy(true, '正在验证…');
    var r = await otpCtx.verify({ token: code });
    busy(false);
    if (r.error) return authMsg('err', errText(r.error));
    await afterSignIn();
  }

  async function onSignup() {
    var email = val('f_email'), code = val('f_code'), pwd = val('f_pwd');
    if (!email || !code || !pwd) return authMsg('err', '请填写邮箱、验证码和新密码。');
    if (pwd.length < 6) return authMsg('err', '密码至少 6 位。');
    if (!otpCtx.verificationId) return authMsg('err', '请先点击「发送验证码」。');
    if (otpCtx.email && otpCtx.email !== email) {
      return authMsg('err', '邮箱改过了，请重新点「发送验证码」再验证。');
    }
    var wasExisting = !!otpCtx.isExistingUser;
    busy(true, '正在创建账号…');
    var r = await cloud.auth.verifyOtp({
      verificationId: otpCtx.verificationId, token: code, email: email,
      isExistingUser: wasExisting,
      password: wasExisting ? undefined : pwd
    });
    busy(false);
    if (r.error) {
      if (isUserExists(r.error)) return offerSetPassword(email, 'signup');
      return authMsg('err', errText(r.error));
    }

    // 不靠猜"密码到底存没存进去"—— 直接用刚设的密码试登一次。
    // 平台在"邮箱已存在"时会改走登录路径且不动密码，用户以为设了其实没设；
    // 这一探就能确认，确认不了就当场把人送到"设密码"的界面，不留死胡同。
    busy(true, '正在确认密码…');
    var probe = await cloud.auth.signInWithPassword({ email: email, password: pwd });
    busy(false);
    if (probe.error && isPasswordNotSet(probe.error)) {
      return offerSetPassword(email, 'signup');
    }
    await afterSignIn();
    if (wasExisting) {
      toast('warn', '这个邮箱此前已注册，本次按登录处理，没有改动原密码。如需用密码登录，请点右上角「设置密码」。', 9000);
    }
  }

  async function onReset() {
    var code = val('f_code'), pwd = val('f_pwd');
    if (!otpCtx.updateUser) return authMsg('err', '请先点击「发送重置码」。');
    if (!code || !pwd) return authMsg('err', '请填写重置码和新密码。');
    if (pwd.length < 6) return authMsg('err', '密码至少 6 位。');
    busy(true, '正在设置密码…');
    var r = await otpCtx.updateUser({ nonce: code, password: pwd });
    busy(false);
    if (r.error) return authMsg('err', errText(r.error));
    pendingEmail = '';
    toast('ok', '密码已设置，之后可以用「邮箱 + 密码」登录了');
    await afterSignIn();
  }

  /* ==================== 权限校验 ==================== */
  async function refreshIdentity() {
    var s = { id: null, email: '' };
    var g = await cloud.auth.getUser().catch(function () { return {}; });
    var u = g && g.data ? (g.data.user || g.data) : null;
    if (u && u.id) { s.id = u.id; s.email = u.email || ''; }
    if (!s.id) {
      var gs = await cloud.auth.getSession().catch(function () { return {}; });
      var sess = gs && gs.data ? gs.data : null;
      var su = sess && sess.user ? sess.user : sess;
      if (su && su.id) { s.id = su.id; s.email = su.email || s.email; }
    }
    S.userId = s.id; S.userEmail = s.email;
    return s;
  }

  async function loadGrant() {
    if (!S.userId) return null;
    var r = await cloud.database.from('access_grants').select('*').eq('owner_id', S.userId).limit(1);
    if (r.error) throw r.error;
    if (r.data && r.data.length) return r.data[0];

    // 首次登录：自助提交一条「待开通」申请，运营方在运营台里开通
    var ins = await cloud.database.from('access_grants')
      .insert({ status: 'pending', plan: 'trial', email: S.userEmail, note: '客户自助注册，自动提交申请' })
      .select();
    if (ins.error && ins.error.code !== '23505') throw ins.error;

    var r2 = await cloud.database.from('access_grants').select('*').eq('owner_id', S.userId).limit(1);
    if (r2.error) throw r2.error;
    return (r2.data && r2.data[0]) || null;
  }

  function evalGrant(g) {
    if (!g) return { ok: false, code: 'none', tone: 'red', title: '您暂时没有访问权限', sub: '系统未找到您的开通记录，请联系管理员处理。' };
    var st = g.status;
    var exp = g.expires_at ? new Date(g.expires_at).getTime() : null;
    if (st === 'active') {
      if (exp !== null && exp < Date.now()) {
        return { ok: false, code: 'expired', tone: 'red', title: '您的访问权限已到期', sub: '到期时间 <span class="hl">' + esc(fmtTime(g.expires_at)) + '</span>。续费后即可继续使用。' };
      }
      return { ok: true, code: 'active' };
    }
    if (st === 'pending') {
      return {
        ok: false, code: 'pending', tone: 'red', title: '您暂时没有访问权限',
        sub: '您的开通申请已提交，正在等待管理员审核。<br/>审核通过后重新登录（或点下方按钮）即可使用。'
      };
    }
    if (st === 'suspended') {
      return { ok: false, code: 'suspended', tone: 'red', title: '您的访问权限已被暂停', sub: '请联系管理员了解详情并恢复订阅。' };
    }
    if (st === 'expired') {
      return { ok: false, code: 'expired', tone: 'red', title: '您的访问权限已到期', sub: '续费后即可继续使用。' };
    }
    return { ok: false, code: 'unknown', tone: 'red', title: '您暂时没有访问权限', sub: '当前订阅状态：<span class="hl">' + esc(st || '未知') + '</span>。' };
  }

  function renderGate(g, ev) {
    var card = $('gateCard');
    card.className = 'gate-card' + (ev.tone === 'gold' ? ' pending' : '');
    $('gateTitle').className = 'gate-title ' + (ev.tone === 'gold' ? 'gold' : 'red');
    $('gateTitle').textContent = ev.title;
    $('gateSub').innerHTML = ev.sub;
    $('gateKv').innerHTML =
      '<div class="stat-row"><span class="k">申请邮箱</span><span class="v">' + esc(maskEmail(S.userEmail)) + '</span></div>' +
      '<div class="stat-row"><span class="k">订阅状态</span><span class="v ' + (ev.ok ? 'down' : 'up') + '">' + esc(g ? g.status : '无记录') + '</span></div>' +
      '<div class="stat-row"><span class="k">套餐</span><span class="v">' + esc(g && g.plan ? g.plan : '—') + '</span></div>' +
      '<div class="stat-row"><span class="k">到期时间</span><span class="v">' + esc(g && g.expires_at ? fmtTime(g.expires_at) : '—') + '</span></div>' +
      '<div class="stat-row"><span class="k">提交时间</span><span class="v">' + esc(g ? fmtTime(g.created_at) : '—') + '</span></div>' +
      '<div style="margin-top:12px;font-size:11px;color:var(--dim)">我的用户 ID（如需人工开通，请把这一串发给管理员）</div>' +
      '<div class="uid-box"><code id="uidText">' + esc(S.userId || '') + '</code><button class="btn sm" id="act_copyUid">复制</button></div>';
    $('act_copyUid').addEventListener('click', function () {
      copyText(S.userId || '').then(function (ok) { toast(ok ? 'ok' : 'err', ok ? '用户 ID 已复制' : '复制失败，请手动选择复制'); });
    });
    hide('viewAuth'); show('viewGate');
  }

  async function refreshOperator() {
    if (!S.userId) { S.isOperator = false; return; }
    try {
      var op = await cloud.database.from('operators').select('owner_id').eq('owner_id', S.userId).limit(1);
      S.isOperator = !!(op.data && op.data.length);
    } catch (e) { S.isOperator = false; }
    $('tabAdmin').classList.toggle('hidden', !S.isOperator);
    return S.isOperator;
  }

  async function checkAccess() {
    // 运营方身份必须在门禁判定之前拿到：运营台位于 viewApp 内，
    // 若放在 enterApp() 里判断，首个运营方（自己还没被开通）会被红字页永久挡住，
    // 导致进不去运营台 → 无法给任何人（含自己）开通 → 引导死锁。
    await refreshOperator();

    var g;
    try { g = await loadGrant(); }
    catch (e) {
      renderGate(null, { ok: false, tone: 'red', title: '权限校验失败', sub: '读取订阅信息时出错，请稍后重试。<br/><span class="mono-small">' + esc(e && e.message ? e.message : String(e)) + '</span>' });
      return;
    }
    S.grant = g;
    var ev = evalGrant(g);
    // 运营方即使自己未订阅也放行，否则无法进入运营台开展审批
    if (!ev.ok && !S.isOperator) { renderGate(g, ev); return; }
    await enterApp(ev);
  }

  /* ==================== 会话 ==================== */
  async function afterSignIn() {
    hide('viewAuth');
    busy(true, '正在校验访问权限…');
    await refreshIdentity();
    busy(false);
    await checkAccess();
  }

  async function boot() {
    hide('viewAuth'); hide('viewGate'); hide('viewApp');
    busy(true, '正在加载…');
    var gs = await cloud.auth.getSession().catch(function () { return {}; });
    var sess = gs && gs.data ? gs.data : null;
    busy(false);
    if (!sess) { show('viewAuth'); renderAuth(); return; }
    await refreshIdentity();
    await checkAccess();
  }

  function doSignOut() {
    cloud.auth.signOut().then(function () {
      S.userId = null; S.userEmail = ''; S.grant = null; S.isOperator = false;
      S.data = null; S.dataSource = '示例数据（铜）'; S.datasets = []; S.pending = null; S.mounted = false;
      clearNotifState();
      hide('viewApp'); hide('viewGate');
      show('viewAuth'); authMode = 'login-password'; renderAuth();
      toast('ok', '已退出登录');
    });
  }

  /* ==================== 进入应用 ==================== */
  async function enterApp(ev) {
    hide('viewAuth'); hide('viewGate'); show('viewApp');
    $('meWho').textContent = maskEmail(S.userEmail);
    var dl = daysLeft(S.grant && S.grant.expires_at);
    var chip = $('mePlan');
    if (ev && !ev.ok && S.isOperator) {
      // 运营方未订阅时的放行态，别伪装成"已开通"
      chip.className = 'chip warn'; chip.textContent = '运营方 · 未订阅';
    } else if (S.grant && S.grant.expires_at) {
      chip.className = 'chip ' + (dl !== null && dl <= 7 ? 'warn' : 'good');
      chip.textContent = '剩余 ' + dl + ' 天';
    } else {
      chip.className = 'chip good'; chip.textContent = '已开通 · 不限时';
    }
    if ($('sideUser')) $('sideUser').textContent = maskEmail(S.userEmail);
    if ($('sidePlan')) $('sidePlan').textContent = chip.textContent;

    // 运营方标签可见性（身份已在 checkAccess 里判定）
    $('tabAdmin').classList.toggle('hidden', !S.isOperator);

    await loadDatasets();
    if (!S.data) setData(SEED, '示例数据（铜 · 2026-09-15）');
    // switchTab('dash') 内部会拉通知列表并安排"新通知弹窗"，这里不再重复拉一次
    switchTab('dash');
    if (S.isOperator) loadOperator();
  }

  function setData(d, label) {
    S.data = d; S.dataSource = label || '自定义数据';
    $('dataSource').textContent = S.dataSource;
    CuRender.mount($('cuRoot'), d);
    S.mounted = true;
    renderOverview();
  }

  function ovNum(n) {
    return (n === null || n === undefined || n === '' || !isFinite(Number(n))) ? '—' : Number(n).toLocaleString('zh-CN');
  }
  function ovLine(values, width, height, pad) {
    var clean = (values || []).map(Number).filter(function (n) { return isFinite(n); });
    if (clean.length < 2) return '';
    var lo = Math.min.apply(Math, clean), hi = Math.max.apply(Math, clean), span = hi - lo || 1;
    return clean.map(function (v, i) {
      var x = pad + i / (clean.length - 1) * (width - pad * 2);
      var y = pad + (hi - v) / span * (height - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
  }
  function setSpark(id, values, color) {
    var el = $(id); if (!el) return;
    var pts = ovLine((values || []).slice(-24), 180, 30, 2);
    el.innerHTML = pts ? '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.8"/>' : '';
  }
  function maskAccount(s) {
    s = String(s || '');
    return s.length > 6 ? s.slice(0, 4) + '••••' + s.slice(-2) : s;
  }
  function renderOverview() {
    if (!$('ovClose')) return;
    var D = S.data || {}, sum = D.summary || {}, meta = D.meta || {}, bars = D.kline || [];
    $('ovContract').textContent = meta.contract || '—';
    $('ovClose').textContent = ovNum(sum.close);
    var chg = Number(sum.chgPct || 0), chgEl = $('ovChange');
    chgEl.textContent = (chg > 0 ? '+' : '') + chg.toFixed(2) + '%'; chgEl.className = chg >= 0 ? 'up' : 'down';
    $('ovOpenInterest').textContent = ovNum(sum.openInterest);
    var oi = Number(sum.oiChange || 0), oiEl = $('ovOiChange');
    oiEl.textContent = (oi > 0 ? '+' : '') + ovNum(oi); oiEl.className = oi >= 0 ? 'up' : 'down';
    $('overviewUpdated').textContent = meta.generatedAt ? '更新于 ' + meta.generatedAt : '数据已载入';
    $('ovMarketNote').textContent = (meta.exchange || '行情') + ' · ' + (meta.contract || '主力合约') + ' · 日线';
    setSpark('ovSparkPrice', bars.map(function (b) { return b.c; }), chg >= 0 ? '#54d69c' : '#ff6d7a');
    setSpark('ovSparkOi', bars.map(function (b) { return b.oi; }), '#7c9cff');

    var chart = $('ovPriceChart');
    if (chart && bars.length > 1) {
      var recent = bars.slice(-45), pts = ovLine(recent.map(function (b) { return b.c; }), 760, 210, 18);
      var area = pts ? pts + ' 742,228 18,228' : '';
      var grid = [35,85,135,185].map(function (y) { return '<line x1="18" y1="' + y + '" x2="742" y2="' + y + '"/>'; }).join('');
      chart.innerHTML = '<defs><linearGradient id="ovFill" x1="0" y1="0" x2="0" y2="1"><stop stop-color="var(--gold)" stop-opacity=".26"/><stop offset="1" stop-color="var(--gold)" stop-opacity="0"/></linearGradient></defs><g class="ov-grid">' + grid + '</g><polygon class="ov-area" points="' + area + '"/><polyline class="ov-line" points="' + pts + '"/><text class="ov-axis" x="18" y="244">' + esc(recent[0].d || '') + '</text><text class="ov-axis" x="690" y="244">' + esc(recent[recent.length - 1].d || '') + '</text>';
    }

    var R = S.riskData, groups = R && R.groups ? R.groups : [], abnormal = groups.filter(function (g) { return g.accountCount >= 2; });
    var high = abnormal.filter(function (g) { return g.accountCount >= 4; }), accountMap = {}, prefixes = {}, devicesByAccount = {};
    abnormal.forEach(function (g) { g.accounts.forEach(function (a) { accountMap[a.account] = a; prefixes[String(a.account).slice(0, 4)] = true; devicesByAccount[a.account] = (devicesByAccount[a.account] || 0) + 1; }); });
    $('ovRiskMac').textContent = R ? ovNum(abnormal.length) : '—'; $('ovRiskHigh').textContent = R ? high.length + ' 个高风险组' : '未载入';
    $('ovRiskAccounts').textContent = R ? ovNum(Object.keys(accountMap).length) : '—'; $('ovRiskSegments').textContent = R ? Object.keys(prefixes).length + ' 个号段' : '—';
    $('ovRiskDevices').textContent = R ? ovNum(abnormal.length) : '—'; $('ovRiskGroups').textContent = R ? ovNum(high.length) : '—';
    $('ovRiskSource').textContent = S.riskSource || '风险日志'; if ($('sideRiskBadge')) $('sideRiskBadge').textContent = R ? abnormal.length : '—';
    $('ovRiskList').innerHTML = abnormal.length ? abnormal.slice(0, 4).map(function (g, i) { return '<div class="overview-risk-row"><span>' + String(i + 1).padStart(2, '0') + '</span><div><b>' + esc(g.mac) + '</b><small>' + ovNum(g.totalEvents) + ' 条登录记录</small></div><em>' + g.accountCount + ' 个账户</em></div>'; }).join('') : '<div class="overview-empty">载入风险日志后显示聚合结果</div>';
    var accounts = Object.keys(accountMap).sort(function (a, b) { return (devicesByAccount[b] || 0) - (devicesByAccount[a] || 0); }).slice(0, 4);
    $('ovAccountBody').innerHTML = accounts.length ? accounts.map(function (key) { var a = accountMap[key], names = a.customers && a.customers.length ? a.customers.join(' / ') : '姓名缺失'; return '<tr><td class="mono">' + esc(maskAccount(key)) + '</td><td>' + esc(names) + '</td><td class="mono">' + esc(key.slice(0, 4)) + '</td><td class="mono">' + (devicesByAccount[key] || 1) + ' MAC</td><td><span class="ov-tag"><i></i>需复核</span></td></tr>'; }).join('') : '<tr><td colspan="5">载入风险日志后显示账户关系</td></tr>';
    var feed = [];
    if (R) feed.push(['风险日志已载入', ovNum(R.validRows) + ' 条有效记录，' + ovNum(abnormal.length) + ' 个异常 MAC。', R.lastEvent || '当前']);
    if (D.kline && D.kline.length) feed.push(['行情数据已同步', ovNum(D.kline.length) + ' 个交易日通过结构检查。', meta.date || '当前']);
    if (S.datasets && S.datasets.length) feed.push(['历史版本可用', ovNum(S.datasets.length) + ' 份文件保存在个人云端目录。', '云端']);
    $('ovFeed').innerHTML = feed.length ? feed.map(function (x) { return '<div><time>' + esc(x[2]) + '</time><b>' + esc(x[0]) + '</b><p>' + esc(x[1]) + '</p></div>'; }).join('') : '<div class="overview-empty">暂无工作区动态</div>';
  }

  var curTab = '';

  function switchTab(name) {
    closeNotifs();
    var was = curTab;
    curTab = name;
    ['dash', 'market', 'upload', 'history', 'risk', 'admin'].forEach(function (t) {
      var p = $('panel' + t.charAt(0).toUpperCase() + t.slice(1));
      if (p) p.classList.toggle('active', t === name);
    });
    document.querySelectorAll('.app-tab').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === name);
    });
    var titles = { dash: '总览', market: '市场看板', upload: '数据中心', history: '历史记录', risk: '实控人风险日志', admin: '运营台' };
    if ($('workspaceCrumb')) $('workspaceCrumb').textContent = titles[name] || '工作台';
    if (was && was !== name) window.scrollTo(0, 0);
    if (name === 'dash') {
      renderOverview();
      if (S.mounted) setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 40);
      // 三条入口（刚登录 / 切回首页 / 刷新后回到主页）最终都走到这里。
      // 先拉最新列表再安排弹出 —— 否则可能拿着上一轮的旧数据判断有没有"新通知"。
      if (was !== 'dash') {
        autoPop.armed = true;
        loadNotifs().then(scheduleAutoPopup);
      }
    } else {
      // 离开首页 → 下次回来重新允许弹一次；顺手撤掉还没触发的定时器
      autoPop.armed = true;
      if (autoPop.timer) { clearTimeout(autoPop.timer); autoPop.timer = null; }
    }
    if (name === 'market' && S.mounted) setTimeout(function () { window.dispatchEvent(new Event('resize')); }, 40);
    if (name === 'history') loadDatasets();
    if (name === 'risk') loadDatasets().then(function () {
      if (S.riskData) return;
      var latest = (S.datasets || []).filter(isRiskDataset)[0];
      if (latest) loadRiskDataset(latest.id, true);
    });
    if (name === 'admin') loadOperator();
  }

  /* ==================== Excel 解析 → 渲染数据（见 parser.js / CuParser） ==================== */
  function buildDataFromWorkbook(wb, fileName) { return CuParser.build(wb, fileName); }
/* ==================== 上传 ==================== */
  var pending = null;

  function pickFile() { $('fileInput').click(); }

  async function onFile(file) {
    if (!file) return;
    var nm = file.name.toLowerCase();
    if (!/\.(xlsx|xls|csv)$/.test(nm)) { toast('err', '只支持 .xlsx / .xls / .csv 文件'); return; }
    if (file.size > MAX_UPLOAD) { toast('err', '文件超过 ' + fmtSize(MAX_UPLOAD) + ' 限制，请精简后重试'); return; }
    busy(true, '正在解析数据…');
    try {
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array', cellDates: false });
      var built = buildDataFromWorkbook(wb, file.name);
      pending = { file: file, built: built };
      renderPreview(file, built);
    } catch (e) {
      pending = null;
      $('preview').classList.remove('show');
      toast('err', '解析失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  function renderPreview(file, d) {
    var rows = [];
    function cell(k, v, cls) { rows.push('<div class="kv-cell"><div class="k">' + esc(k) + '</div><div class="v ' + (cls || '') + '">' + esc(v) + '</div></div>'); }
    cell('文件名', file.name);
    cell('文件大小', fmtSize(file.size));
    cell('识别到数据表', d.__sheetCount + ' / ' + d.__sheets.length + ' 张');
    cell('K线根数', d.kline.length + ' 根');
    cell('数据日期', d.meta.date || '—');
    cell('主力合约', d.meta.contract || '—');
    cell('合约数', (d.contracts || []).length + ' 个');
    cell('最新收盘', d.summary.close !== null ? Number(d.summary.close).toLocaleString() : '—', d.summary.chg >= 0 ? 'up' : 'down');
    $('previewGrid').innerHTML = rows.join('');
    var missing = ['TECH', 'CONTRACTS', 'RANK', 'OPTIONS_META', 'SENTIMENT', 'SEASON', 'COST'].filter(function (n) {
      return d.__sheets.indexOf(n) < 0;
    });
    $('previewWarn').innerHTML = missing.length
      ? '提示：本次文件缺少 ' + missing.join('、') + ' 表，对应页面会显示为空。'
      : '全部 21 张数据表齐备，所有页面都会完整渲染。';
    $('preview').classList.add('show');
    $('preview').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function doUpload() {
    if (!pending) return;
    var file = pending.file, built = pending.built;
    busy(true, '正在上传到云端…');
    try {
      var safe = file.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      var path = cloud.storage.userPath(S.userId, 'datasets/' + Date.now() + '_' + safe);
      var up = await cloud.storage.upload(path, file, {
        contentType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      });
      if (up.error) throw up.error;

      var ins = await cloud.database.from('datasets').insert({
        name: file.name, storage_path: path, size_bytes: file.size,
        mime_type: file.type || '', data_date: built.meta.date, sheet_count: built.__sheetCount
      }).select();
      if (ins.error) throw ins.error;

      setData(built, file.name + ' · ' + built.meta.date);
      pending = null;
      $('preview').classList.remove('show');
      $('fileInput').value = '';
      toast('ok', '上传成功，看板已按你的数据重新渲染', 5200);
      await loadDatasets();
      switchTab('dash');
    } catch (e) {
      toast('err', '上传失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  function useSample() {
    setData(SEED, '示例数据（铜 · 2026-09-15）');
    toast('ok', '已切回示例数据');
    switchTab('dash');
  }

  /* ==================== 历史数据 ==================== */
  async function loadDatasets() {
    try {
      var r = await cloud.database.from('datasets').select('*').order('created_at', { ascending: false }).limit(200);
      if (r.error) throw r.error;
      S.datasets = r.data || [];
      renderHistory();
      renderRiskHistory();
      renderOverview();
    } catch (e) {
      $('histBody').innerHTML = '<tr><td colspan="6"><div class="empty-state">读取失败：' + esc(e && e.message ? e.message : String(e)) + '</div></td></tr>';
    }
  }

  function renderHistory() {
    var list = (S.datasets || []).filter(function (d) { return !isRiskDataset(d); });
    $('histCount').textContent = list.length ? '共 ' + list.length + ' 份' : '';
    $('btnDownAll').disabled = !list.length;
    if (!list.length) {
      $('histBody').innerHTML = '<tr><td colspan="6"><div class="empty-state"><div class="big">🗂</div>还没有上传过数据。<br/>到「上传数据」页上传第一份 Excel 吧。</div></td></tr>';
      return;
    }
    $('histBody').innerHTML = list.map(function (d) {
      return '<tr>' +
        '<td class="l">' + esc(d.name) + '</td>' +
        '<td class="l gl">' + esc(d.data_date || '—') + '</td>' +
        '<td class="num">' + fmtSize(d.size_bytes) + '</td>' +
        '<td class="num">' + esc(d.sheet_count || '—') + '</td>' +
        '<td class="l mono-small">' + esc(fmtTime(d.created_at)) + '</td>' +
        '<td class="l"><div class="ops">' +
        '<button class="btn sm ok" data-load="' + d.id + '">载入看板</button>' +
        '<button class="btn sm" data-dl="' + d.id + '">下载</button>' +
        '<button class="btn sm danger" data-del="' + d.id + '">删除</button>' +
        '</div></td></tr>';
    }).join('');

    $('histBody').querySelectorAll('[data-load]').forEach(function (b) { b.addEventListener('click', function () { loadDataset(b.getAttribute('data-load')); }); });
    $('histBody').querySelectorAll('[data-dl]').forEach(function (b) { b.addEventListener('click', function () { downloadDataset(b.getAttribute('data-dl')); }); });
    $('histBody').querySelectorAll('[data-del]').forEach(function (b) { b.addEventListener('click', function () { deleteDataset(b.getAttribute('data-del')); }); });
  }

  function findDs(id) { return (S.datasets || []).filter(function (d) { return String(d.id) === String(id); })[0]; }

  function isRiskDataset(d) {
    return !!(d && String(d.storage_path || '').replace(/\\/g, '/').indexOf('risk-logs/') >= 0);
  }

  async function loadDataset(id) {
    var d = findDs(id); if (!d) return;
    busy(true, '正在载入 ' + d.name + ' …');
    try {
      var r = await cloud.storage.download(d.storage_path);
      if (r.error) throw r.error;
      var buf = await r.data.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array', cellDates: false });
      var built = buildDataFromWorkbook(wb, d.name);
      setData(built, d.name + ' · ' + (built.meta.date || ''));
      toast('ok', '已载入「' + d.name + '」');
      switchTab('dash');
    } catch (e) {
      toast('err', '载入失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  async function downloadDataset(id) {
    var d = findDs(id); if (!d) return;
    busy(true, '正在下载…');
    try {
      var r = await cloud.storage.download(d.storage_path);
      if (r.error) throw r.error;
      saveBlob(r.data, d.name);
      toast('ok', '已开始下载 ' + d.name);
    } catch (e) {
      toast('err', '下载失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  async function downloadAll() {
    var list = (S.datasets || []).filter(function (d) { return !isRiskDataset(d); });
    if (!list.length) return;
    busy(true, '正在打包下载 ' + list.length + ' 份历史数据…');
    var blobs = [], names = [], ok = 0, fail = 0;

    for (var i = 0; i < list.length; i++) {
      try {
        var r = await cloud.storage.download(list[i].storage_path);
        if (r.error) throw r.error;
        var nm = list[i].name || ('dataset_' + (i + 1) + '.xlsx');
        // 同名文件加序号，避免 ZIP 内覆盖
        if (names.indexOf(nm) >= 0) nm = nm.replace(/(\.[^.]+)$/, '_' + (i + 1) + '$1');
        names.push(nm);
        blobs.push({ name: nm, blob: r.data });
        ok++;
      } catch (e) { fail++; }
    }

    if (!blobs.length) {
      busy(false);
      return toast('err', '历史数据下载失败，请稍后重试。', 6000);
    }

    var stamp = (function () {
      var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '_' + z(d.getHours()) + z(d.getMinutes());
    })();

    // 优先打包成单个 ZIP，避免浏览器拦截多文件下载
    if (window.JSZip) {
      try {
        var zip = new window.JSZip();
        for (var k = 0; k < blobs.length; k++) zip.file(blobs[k].name, blobs[k].blob);
        var out = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
        saveBlob(out, '历史数据_' + stamp + '.zip');
        busy(false);
        return toast(fail ? 'warn' : 'ok',
          '已打包 ' + blobs.length + ' 份历史数据为 1 个 ZIP 下载' + (fail ? '（' + fail + ' 份读取失败）' : ''), 6000);
      } catch (e) {
        // 打包失败则回退到逐份下载
      }
    }

    for (var j = 0; j < blobs.length; j++) {
      saveBlob(blobs[j].blob, blobs[j].name);
      await new Promise(function (res) { setTimeout(res, 420); });
    }
    busy(false);
    toast(fail ? 'warn' : 'ok', '历史数据下载完成：成功 ' + ok + ' 份' + (fail ? '，失败 ' + fail + ' 份' : ''));
  }

  /* ==================== 期货账户实控人风险日志 ==================== */
  var riskPending = null;

  async function onRiskFile(file) {
    if (!file) return;
    var nm = file.name.toLowerCase();
    if (!/\.(xlsx|xls|csv)$/.test(nm)) return toast('err', '风险日志只支持 .xlsx / .xls / .csv 文件');
    if (file.size > RISK_MAX_UPLOAD) return toast('err', '文件超过 ' + fmtSize(RISK_MAX_UPLOAD) + ' 限制');
    busy(true, '正在解析风险日志，数据量较大时请稍候…');
    try {
      var buf = await file.arrayBuffer();
      var wb = XLSX.read(buf, { type: 'array', cellDates: false });
      var built = RiskLogParser.build(wb, file.name);
      riskPending = { file: file, built: built };
      S.riskData = built; S.riskSource = file.name;
      renderRiskPreview(file, built);
      applyRiskFilter();
    } catch (e) {
      riskPending = null;
      $('riskPreview').classList.remove('show');
      toast('err', '风险日志解析失败：' + (e && e.message ? e.message : String(e)), 8000);
    } finally { busy(false); }
  }

  function renderRiskPreview(file, d) {
    var cells = [
      ['文件名', file.name], ['文件大小', fmtSize(file.size)], ['数据表', d.sheetName],
      ['有效记录', Number(d.validRows).toLocaleString()], ['MAC 数', Number(d.uniqueMacs).toLocaleString()],
      ['资金账号', Number(d.uniqueAccounts).toLocaleString()]
    ];
    $('riskPreviewGrid').innerHTML = cells.map(function (x) {
      return '<div class="kv-cell"><div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + '</div></div>';
    }).join('');
    $('riskPreviewMsg').textContent = '已识别第 ' + d.headerRow + ' 行表头：资金账号、客户姓名、登录 MAC 地址。' +
      (d.skippedRows ? ' 跳过 ' + d.skippedRows + ' 行缺少账号或 MAC 的记录。' : ' 所有数据行均可用于筛选。');
    $('riskPreview').classList.add('show');
  }

  async function uploadRiskLog() {
    if (!riskPending) return;
    var file = riskPending.file, built = riskPending.built;
    busy(true, '正在保存风险日志版本…');
    try {
      var safe = file.name.replace(/[^\w.\-\u4e00-\u9fa5]/g, '_');
      var path = cloud.storage.userPath(S.userId, 'risk-logs/' + Date.now() + '_' + safe);
      var up = await cloud.storage.upload(path, file, {
        contentType: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', upsert: false
      });
      if (up.error) throw up.error;
      var ins = await cloud.database.from('datasets').insert({
        name: file.name, storage_path: path, size_bytes: file.size, mime_type: file.type || '',
        data_date: (built.lastEvent || built.firstEvent || '').slice(0, 20), sheet_count: built.sheets.length
      }).select();
      if (ins.error) throw ins.error;
      S.riskData = built; S.riskSource = file.name;
      riskPending = null; $('riskPreview').classList.remove('show'); $('riskFileInput').value = '';
      renderRiskCurrentMeta(); applyRiskFilter(); await loadDatasets();
      toast('ok', '风险日志已保存为当前版本，旧版本仍保留在历史记录中', 5500);
    } catch (e) {
      toast('err', '风险日志保存失败：' + (e && e.message ? e.message : String(e)), 8000);
    } finally { busy(false); }
  }

  function renderRiskCurrentMeta() {
    var d = S.riskData;
    if (!d) {
      $('riskCurrentTitle').textContent = '筛选结果';
      $('riskCurrentMeta').textContent = '请先上传或载入一份风险日志。';
      return;
    }
    $('riskCurrentTitle').textContent = '筛选结果 · ' + (S.riskSource || d.fileName || '风险日志');
    $('riskCurrentMeta').textContent = '数据表：' + d.sheetName + ' · 有效记录 ' + Number(d.validRows).toLocaleString() +
      ' 条 · 时间范围 ' + (d.firstEvent || '—') + ' 至 ' + (d.lastEvent || '—');
  }

  function riskOptions() {
    return { prefixes: $('riskPrefixes').value, query: $('riskQuery').value, minAccounts: $('riskMinAccounts').value };
  }

  function applyRiskFilter() {
    renderRiskCurrentMeta();
    if (!S.riskData) {
      S.riskFiltered = []; $('btnRiskExport').disabled = true;
      $('riskSummary').innerHTML = '';
      $('riskBody').innerHTML = '<tr><td colspan="5"><div class="empty-state">请先上传或从历史版本载入风险日志。</div></td></tr>';
      renderOverview();
      return;
    }
    var opts = riskOptions();
    var prefixes = RiskLogParser.parsePrefixes(opts.prefixes);
    var bad = prefixes.filter(function (p) { return !/^\d{4}$/.test(p); });
    if (bad.length) return toast('err', '号段必须是资金账号前四位，例如 3501。请检查：' + bad.join('、'));
    var rows = RiskLogParser.filter(S.riskData, opts);
    S.riskFiltered = rows;
    $('btnRiskExport').disabled = !rows.length;
    var matchedAccounts = {}, events = 0;
    rows.forEach(function (g) { events += g.totalEvents; g.accounts.forEach(function (a) { matchedAccounts[a.account] = true; }); });
    var summary = [
      ['异常 MAC', rows.length.toLocaleString()],
      ['关联资金账号', Object.keys(matchedAccounts).length.toLocaleString()],
      ['登录记录', events.toLocaleString()],
      ['筛选号段', prefixes.length ? prefixes.join('、') : '全部']
    ];
    $('riskSummary').innerHTML = summary.map(function (x) {
      return '<div class="kv-cell"><div class="k">' + esc(x[0]) + '</div><div class="v">' + esc(x[1]) + '</div></div>';
    }).join('');
    if (!rows.length) {
      $('riskBody').innerHTML = '<tr><td colspan="5"><div class="empty-state">没有符合当前号段和异常门槛的记录。</div></td></tr>';
      renderOverview();
      return;
    }
    $('riskBody').innerHTML = rows.map(function (g) {
      var accountHtml = g.accounts.map(function (a) {
        var hit = !prefixes.length || prefixes.some(function (p) { return a.account.indexOf(p) === 0; });
        var names = a.customers.length ? a.customers.join(' / ') : '姓名缺失';
        return '<div class="risk-account ' + (hit ? 'match' : '') + '"><b>' + esc(a.account) + '</b><span>' + esc(names) + '</span><em>' + a.count.toLocaleString() + ' 次</em></div>';
      }).join('');
      return '<tr><td class="l nowrap"><b class="risk-mac">' + esc(g.mac) + '</b></td>' +
        '<td class="l"><div class="risk-accounts">' + accountHtml + '</div></td>' +
        '<td class="num"><b>' + g.accountCount + '</b></td><td class="num">' + g.totalEvents.toLocaleString() + '</td>' +
        '<td class="l mono-small nowrap">' + esc(g.lastEvent || '—') + '</td></tr>';
    }).join('');
    renderOverview();
  }

  function renderRiskHistory() {
    var list = (S.datasets || []).filter(isRiskDataset);
    $('riskHistCount').textContent = list.length ? '共 ' + list.length + ' 个版本' : '';
    if (!list.length) {
      $('riskHistBody').innerHTML = '<tr><td colspan="4"><div class="empty-state">还没有保存过风险日志。</div></td></tr>';
      return;
    }
    $('riskHistBody').innerHTML = list.map(function (d, i) {
      return '<tr><td class="l">' + (i === 0 ? '<span class="chip good">当前</span> ' : '') + esc(d.name) + '</td>' +
        '<td class="num">' + fmtSize(d.size_bytes) + '</td><td class="l mono-small">' + esc(fmtTime(d.created_at)) + '</td>' +
        '<td class="l"><div class="ops"><button class="btn sm ok" data-risk-load="' + d.id + '">载入筛选</button>' +
        '<button class="btn sm" data-risk-dl="' + d.id + '">下载原文件</button></div></td></tr>';
    }).join('');
    $('riskHistBody').querySelectorAll('[data-risk-load]').forEach(function (b) {
      b.addEventListener('click', function () { loadRiskDataset(b.getAttribute('data-risk-load')); });
    });
    $('riskHistBody').querySelectorAll('[data-risk-dl]').forEach(function (b) {
      b.addEventListener('click', function () { downloadDataset(b.getAttribute('data-risk-dl')); });
    });
  }

  async function loadRiskDataset(id, quiet) {
    var d = findDs(id); if (!d || !isRiskDataset(d)) return;
    busy(true, '正在载入历史风险日志…');
    try {
      var r = await cloud.storage.download(d.storage_path); if (r.error) throw r.error;
      var wb = XLSX.read(await r.data.arrayBuffer(), { type: 'array', cellDates: false });
      S.riskData = RiskLogParser.build(wb, d.name); S.riskSource = d.name;
      renderRiskCurrentMeta(); applyRiskFilter();
      if (!quiet) {
        $('riskResultsSection').scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast('ok', '已载入历史版本「' + d.name + '」');
      }
    } catch (e) { toast('err', '历史风险日志载入失败：' + (e && e.message ? e.message : String(e)), 8000); }
    finally { busy(false); }
  }

  function exportRiskResults() {
    var rows = S.riskFiltered || [];
    if (!rows.length) return;
    var csv = [['MAC地址', '资金账号', '客户姓名', '该账号登录次数', 'MAC关联账号数', 'MAC登录记录数', '首次事件', '最近事件']];
    rows.forEach(function (g) { g.accounts.forEach(function (a) {
      csv.push([g.mac, a.account, a.customers.join(' / '), a.count, g.accountCount, g.totalEvents, a.firstEvent || g.firstEvent, a.lastEvent || g.lastEvent]);
    }); });
    var quote = function (v) { return '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"'; };
    var body = '\ufeff' + csv.map(function (r) { return r.map(quote).join(','); }).join('\r\n');
    var stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    saveBlob(new Blob([body], { type: 'text/csv;charset=utf-8' }), '实控人风险筛选结果_' + stamp + '.csv');
    toast('ok', '筛选结果已导出，共 ' + rows.length + ' 个 MAC');
  }

  async function deleteDataset(id) {
    var d = findDs(id); if (!d) return;
    if (!confirm('确认删除「' + d.name + '」？\n\n该操作不可恢复：云端文件与登记记录都会被移除。')) return;
    busy(true, '正在删除…');
    try {
      var rm = await cloud.storage.remove([d.storage_path]);
      if (rm.error) throw rm.error;
      var del = await cloud.database.from('datasets').delete().eq('id', d.id).select();
      if (del.error) throw del.error;
      if (!del.data || !del.data.length) throw new Error('数据库未删除任何行（可能无权限）');
      if (S.dataSource.indexOf(d.name) === 0) setData(SEED, '示例数据（铜 · 2026-09-15）');
      toast('ok', '已删除「' + d.name + '」');
      await loadDatasets();
    } catch (e) {
      toast('err', '删除失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  /* ==================== 运营台 ==================== */
  async function loadOperator() {
    if (!S.isOperator) return;
    try {
      var r = await cloud.database.from('access_grants').select('*').order('created_at', { ascending: false }).limit(500);
      if (r.error) throw r.error;
      var rows = r.data || [];
      var pend = rows.filter(function (x) { return x.status === 'pending'; }).length;
      $('adminPending').textContent = pend ? (pend + ' 条待开通') : '暂无待开通申请';
      $('adminPending').className = 'chip ' + (pend ? 'warn' : 'good');
      var badge = $('adminBadge');
      badge.textContent = pend;
      badge.classList.toggle('hidden', !pend);
      renderOperator(rows);
    } catch (e) {
      $('adminBody').innerHTML = '<tr><td colspan="7"><div class="empty-state">读取失败：' + esc(e && e.message ? e.message : String(e)) + '</div></td></tr>';
    }
  }

  function statusBadge(st) {
    var map = { active: ['b-green', '已开通'], pending: ['b-gold', '待开通'], suspended: ['b-red', '已暂停'], expired: ['b-gray', '已到期'] };
    var m = map[st] || ['b-gray', st || '未知'];
    return '<span class="badge ' + m[0] + '">' + esc(m[1]) + '</span>';
  }

  function renderOperator(rows) {
    if (!rows.length) {
      $('adminBody').innerHTML = '<tr><td colspan="7"><div class="empty-state">还没有客户注册。</div></td></tr>';
      return;
    }
    $('adminBody').innerHTML = rows.map(function (g) {
      var dl = daysLeft(g.expires_at);
      return '<tr>' +
        '<td class="l">' + esc(g.email || '（未登记邮箱）') + '</td>' +
        '<td class="l"><code class="mono-small">' + esc(g.owner_id) + '</code></td>' +
        '<td class="l">' + statusBadge(g.status) + '</td>' +
        '<td class="l">' + esc(g.plan || '—') + '</td>' +
        '<td class="l nowrap">' + esc(g.expires_at ? fmtTime(g.expires_at) + (dl !== null ? '（' + dl + '天）' : '') : '—') + '</td>' +
        '<td class="l mono-small">' + esc(fmtTime(g.created_at)) + '</td>' +
        '<td class="l"><div class="ops">' +
        '<button class="btn sm ok" data-approve="' + g.id + '">开通</button>' +
        '<button class="btn sm" data-custom="' + g.id + '">自定义天数</button>' +
        '<button class="btn sm danger" data-susp="' + g.id + '">暂停</button>' +
        '</div></td></tr>';
    }).join('');
    $('adminBody').querySelectorAll('[data-approve]').forEach(function (b) { b.addEventListener('click', function () { approve(b.getAttribute('data-approve'), 365); }); });
    $('adminBody').querySelectorAll('[data-custom]').forEach(function (b) { b.addEventListener('click', function () { approve(b.getAttribute('data-custom'), null); }); });
    $('adminBody').querySelectorAll('[data-susp]').forEach(function (b) { b.addEventListener('click', function () { suspend(b.getAttribute('data-susp')); }); });
  }

  async function updateGrant(id, patch, okMsg) {
    busy(true, '正在更新授权…');
    try {
      var r = await cloud.database.from('access_grants').update(patch).eq('id', id).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error('没有更新到任何行（权限或记录不存在）');
      toast('ok', okMsg || '已更新');
      await loadOperator();
    } catch (e) {
      toast('err', '更新失败：' + (e && e.message ? e.message : String(e)), 7000);
    } finally { busy(false); }
  }

  function approve(id, days) {
    if (days === null) {
      var v = prompt('请输入开通天数（正整数）', '365');
      if (v === null) return;
      days = parseInt(v, 10);
      if (!isFinite(days) || days <= 0) { toast('err', '天数必须是正整数'); return; }
    }
    var exp = new Date(Date.now() + days * 86400000).toISOString();
    updateGrant(id, {
      status: 'active', plan: days >= 300 ? 'standard' : 'trial',
      expires_at: exp, updated_at: new Date().toISOString(),
      note: '运营方于 ' + fmtTime(new Date()) + ' 开通 ' + days + ' 天'
    }, '已开通 ' + days + ' 天');
  }

  function suspend(id) {
    if (!confirm('确认暂停该账号的访问权限？\n暂停后对方立即无法进入看板。')) return;
    updateGrant(id, { status: 'suspended', updated_at: new Date().toISOString(), note: '运营方暂停' }, '已暂停该账号');
  }

  /* ==================== 成果导出 ==================== */
  var exState = { open: false, kind: 'html', scale: 2, previewUrl: null, previewMade: false, busy: false };

  function exData() { return S.data || (typeof SEED !== 'undefined' ? SEED : null); }

  function openExport() {
    if (!window.CuExport) { toast('err', '导出模块未加载，请强制刷新页面（Ctrl+F5）'); return; }
    if (!exData()) { toast('err', '当前没有可导出的数据'); return; }
    exState.open = true;
    $('exModal').classList.remove('hidden');
    pickKind(exState.kind);
  }

  function closeExport() {
    exState.open = false;
    $('exModal').classList.add('hidden');
    if (exState.previewUrl) { try { URL.revokeObjectURL(exState.previewUrl); } catch (e) {} }
    exState.previewUrl = null;
    exState.previewMade = false;
    $('exPreview').innerHTML = '<div class="exph">选择 PNG 长图后，这里会显示预览…</div>';
  }

  function pickKind(kind) {
    exState.kind = kind;
    $('exOptHtml').classList.toggle('on', kind === 'html');
    $('exOptPng').classList.toggle('on', kind === 'png');
    $('exPaneHtml').classList.toggle('hidden', kind !== 'html');
    $('exPanePng').classList.toggle('hidden', kind !== 'png');
    $('exGo').textContent = kind === 'html' ? '导出 HTML' : '生成并下载长图';
    $('exHint').textContent = kind === 'html'
      ? '导出的是一个独立网页文件，对方双击即可打开。'
      : '长图在你本机合成，数据不出浏览器；发原图别压缩。';
    if (kind === 'html') renderHtmlNote();
    else { renderScaleNote(); schedulePreview(); }
  }

  function renderHtmlNote() {
    var D = exData();
    var bytes = 0;
    try { bytes = new Blob([CuExport.buildHtml(D)]).size; } catch (e) {}
    $('exHtmlMeta').textContent = bytes
      ? ('体积约 ' + (bytes / 1024).toFixed(0) + ' KB · 单文件自包含')
      : '单文件自包含';
    var m = D.meta || {};
    $('exHtmlNote').innerHTML = bytes
      ? ('将导出：<b>' + esc(CuExport.safeName(D, '.html')) + '</b><br/>'
        + '体积约 <b>' + (bytes / 1024).toFixed(0) + ' KB</b>，样式表、渲染脚本、数据全部内嵌，<b>打开时不联网也能看</b>。<br/>'
        + '文件内保留完整的 <b>8 个页面</b>（行情总览 / 多周期技术 / 期限结构 / 持仓与库存 / 期权分析 / 外盘与宏观 / 舆情季节性 / 交易成本）与页面切换交互。<br/>'
        + '数据日期 <b>' + esc(m.date || '—') + '</b>　数据来源 ' + esc(m.source || '—'))
      : '构建预览失败，可直接点导出试试；若失败请刷新页面。';
  }

  function renderScaleNote() {
    try {
      var sz = CuExport.posterSize(exData()), s = exState.scale;
      $('exScaleNote').textContent = '输出 ' + Math.round(sz.w * s) + ' × ' + Math.round(sz.h * s) + ' px';
    } catch (e) { $('exScaleNote').textContent = ''; }
  }

  function schedulePreview() {
    if (exState.previewMade) return;
    var box = $('exPreview');
    box.innerHTML = '<div class="exph">正在生成长图预览…</div>';
    setTimeout(function () {
      if (!exState.open || exState.kind !== 'png') return;
      try {
        // 预览固定用低倍率，保证秒出；导出时才按所选清晰度全量渲染
        var cv = CuExport.renderPoster(exData(), { scale: 0.45 });
        cv.toBlob(function (blob) {
          if (!blob) { box.innerHTML = '<div class="exph">预览生成失败，可直接点导出试试。</div>'; return; }
          if (!exState.open || exState.kind !== 'png') return;
          exState.previewUrl = URL.createObjectURL(blob);
          exState.previewMade = true;
          box.innerHTML = '<img alt="长图预览" src="' + exState.previewUrl + '">';
        }, 'image/png');
      } catch (e) {
        box.innerHTML = '<div class="exph">预览生成失败：' + esc(e && e.message ? e.message : String(e)) + '</div>';
      }
    }, 40);
  }

  async function doExport() {
    if (exState.busy) return;
    var D = exData();
    if (!D) return;
    exState.busy = true;
    $('exGo').disabled = true;
    var label = exState.kind === 'html' ? '导出 HTML' : '生成并下载长图';
    busy(true, exState.kind === 'html' ? '正在打包单文件…' : '正在合成高清长图…');
    try {
      if (exState.kind === 'html') {
        var fn = CuExport.safeName(D, '.html');
        CuExport.downloadText(CuExport.buildHtml(D), fn);
        toast('ok', '已导出单文件 HTML：' + fn, 6000);
      } else {
        var cv = CuExport.renderPoster(D, { scale: exState.scale });
        var blob = await new Promise(function (res, rej) {
          try {
            cv.toBlob(function (b) { b ? res(b) : rej(new Error('长图编码失败，可换低一档清晰度再试')); }, 'image/png');
          } catch (e) { rej(e); }
        });
        var pn = CuExport.safeName(D, '_长图.png');
        CuExport.downloadBlob(blob, pn);
        toast('ok', '已生成长图 ' + pn + '（' + (blob.size / 1024 / 1024).toFixed(2) + ' MB）', 7000);
      }
      closeExport();
    } catch (e) {
      toast('err', '导出失败：' + (e && e.message ? e.message : String(e)), 8000);
    } finally {
      exState.busy = false;
      $('exGo').disabled = false;
      $('exGo').textContent = label;
      busy(false);
    }
  }

  /* ==================== 消息通知 ====================
     数据在云端 notifications 表，RLS 两道门：
       · 读：published = true（所有登录用户）或 自己是运营方（草稿也能看）
       · 写：仅运营方名单内账号（INSERT/UPDATE/DELETE 全被策略拦）
     前端只负责展示与隐藏，真正的权限判定在数据库，改前端也提不了权。

     "未读"没有单独建表：把最后一次"打开列表"的时间戳存在本机，
     比这个时间新的就算未读。省一张表、省一条策略，且换设备不串号。 */
  var NOTIF_SEEN_KEY = 'cu_notif_seen_at';
  var NOTIF_POPPED_KEY = 'cu_notif_popped';
  var NLEVEL = {
    info: { label: '通知', cls: 'b-gray' },
    warn: { label: '提醒', cls: 'b-gold' },
    important: { label: '重要', cls: 'b-red' }
  };
  var notifState = { list: [], open: false, editing: null, busy: false, err: '' };

  function nlevel(k) { return NLEVEL[k] || NLEVEL.info; }
  function tsOf(v) { var t = new Date(v).getTime(); return isNaN(t) ? 0 : t; }
  /* 键带用户 ID：同一台浏览器换账号登录时，"读过/弹过"不该串号 */
  function lsKey(base) { return base + '.' + (S.userId || 'anon'); }
  function lsGet(k, dflt) { try { var v = localStorage.getItem(k); return v === null ? dflt : v; } catch (e) { return dflt; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function seenAt() { return lsGet(lsKey(NOTIF_SEEN_KEY), ''); }
  function markSeen() { lsSet(lsKey(NOTIF_SEEN_KEY), new Date().toISOString()); }
  function unreadCount() {
    var s = tsOf(seenAt());
    if (!s) return (notifState.list || []).length;
    return (notifState.list || []).filter(function (n) { return tsOf(n.created_at) > s; }).length;
  }
  /* 列表里只给一行左右的缩略，完整内容点开再看 */
  function preview(s, n) {
    var t = String(s === null || s === undefined ? '' : s).replace(/\s+/g, ' ').trim();
    n = n || 88;
    return t.length > n ? t.slice(0, n) + '…' : t;
  }
  /* 写不通时最常见的其实是权限（RLS 42501）—— 给中文的下一步，别甩英文原文 */
  function notifErr(e) {
    var m = (e && e.message) ? e.message : String(e);
    if (/42501|row-level security|permission denied|violates row level/i.test(m)) {
      return '当前账号没有发布通知的权限（只有运营方名单内的账号可以发布）。';
    }
    return m;
  }

  /* ---------- 自动弹出"新通知" ----------
     运营方新发的通知，用户下一次进首页时自动弹一个浮窗，而不是只靠红点等人来点。
     三条入口最终都收敛到 switchTab('dash')：
       · 刚登录进主页 / 主页刷新 → boot/login → checkAccess → enterApp → switchTab('dash')
       · 从其他页面切回主页     → 用户点标签 → switchTab('dash')
     所以触发器只挂在 switchTab 上，不用在 enterApp 里再挂一遍（否则会重复拉一次列表）。

     "弹过没弹过"单独记一份，跟"已读"不是一回事：
     用户点开铃铛翻过列表（=已读），就不该过一会儿又被同一条通知弹一次。
     因此打开浮窗列表时也把当时列表里的 id 全部记为"弹过"。 */
  var autoPop = { timer: null, armed: true, done: false };

  function poppedIds() {
    var raw = lsGet(lsKey(NOTIF_POPPED_KEY), '[]');
    var a;
    try { a = JSON.parse(raw); } catch (e) { a = []; }
    return (Object.prototype.toString.call(a) === '[object Array]') ? a.map(String) : [];
  }
  function markPopped(ids) {
    if (!ids || !ids.length) return;
    var all = poppedIds();
    ids.forEach(function (id) {
      var s = String(id);
      if (all.indexOf(s) < 0) all.push(s);
    });
    // 只留最近 300 个，别让 localStorage 无限涨
    if (all.length > 300) all = all.slice(all.length - 300);
    lsSet(lsKey(NOTIF_POPPED_KEY), JSON.stringify(all));
  }
  /* 待自动弹出的 = 已发布 且 没记过"弹过"的。
     草稿（published=false）不弹 —— 那是运营方自己还没定稿的东西。 */
  function pendingPopups() {
    var done = poppedIds();
    return (notifState.list || []).filter(function (n) {
      return n && n.published !== false && done.indexOf(String(n.id)) < 0;
    });
  }
  function indexOfNotif(id) {
    var list = notifState.list || [];
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return i;
    }
    return -1;
  }

  /* 多条新的不连弹 N 个窗（那是骚扰）：弹最新的一条，底部告诉用户还剩几条。 */
  function maybeAutoPopup() {
    if (autoPop.done) return;
    autoPop.done = true;
    if (curTab !== 'dash') return;                                  // 已经不在首页了
    if (!S.userId) return;                                          // 还在登录/权限页
    if (!autoPop.armed) return;
    if ($('viewApp').classList.contains('hidden')) return;
    if (!$('nModal').classList.contains('hidden')) return;          // 详情已经开着
    if (notifState.open) return;                                    // 用户正在看列表
    var news = pendingPopups();
    if (!news.length) return;
    autoPop.armed = false;
    // 先记账再弹：万一弹的过程中出错，也不会变成每次进首页都重复弹
    markPopped(news.map(function (n) { return n.id; }));
    renderNotifs();
    openNotifDetail(indexOfNotif(news[0].id), { auto: true, more: news.length - 1 });
  }

  /* 首次进入首页时，通知列表可能还在路上；这里串在 loadNotifs() 后面，
     再让看板先画 450ms（否则弹窗和首屏渲染挤在一起，观感很生硬）。 */
  function scheduleAutoPopup() {
    autoPop.done = false;
    if (autoPop.timer) { clearTimeout(autoPop.timer); autoPop.timer = null; }
    if (!autoPop.armed) return;
    autoPop.timer = setTimeout(function () {
      autoPop.timer = null;
      maybeAutoPopup();
    }, 450);
  }

  async function loadNotifs() {
    try {
      var r = await cloud.database.from('notifications').select('*')
        .order('created_at', { ascending: false }).limit(100);
      if (r.error) throw r.error;
      notifState.list = r.data || [];
      notifState.err = '';
    } catch (e) {
      notifState.err = notifErr(e);
    }
    renderNotifs();
    renderNotifBadge();
    // 列表刚刷新完，而用户此刻正开着浮窗在看 —— 这批也算"看过"，别再自动弹一遍
    if (notifState.open) markPopped((notifState.list || []).map(function (n) { return n.id; }));
    if (S.isOperator) renderNotifAdmin();
  }

  function renderNotifBadge() {
    var dot = $('bellDot');
    if (!dot) return;
    var n = unreadCount();
    dot.classList.toggle('hidden', !n);
    $('btnBell').title = n ? ('通知 · ' + n + ' 条未读') : '通知';
  }

  function renderNotifs() {
    var list = notifState.list || [];
    var box = $('notifList');
    $('notifCnt').textContent = list.length ? (list.length + ' 条') : '';
    if (!list.length) {
      $('notifFoot').textContent = '';
      box.innerHTML = '<div class="empty-state"><div class="big">🔔</div>' +
        (notifState.err ? ('读取失败：' + esc(notifState.err)) : '暂时没有通知。') + '</div>';
      return;
    }
    var s = tsOf(seenAt());
    box.innerHTML = list.map(function (n, i) {
      var lv = nlevel(n.level);
      var unread = !s || tsOf(n.created_at) > s;
      return '<button class="nitem' + (unread ? ' unread' : '') + '" type="button" data-ni="' + i + '">' +
        '<div class="nitop">' +
          (unread ? '<span class="ndot"></span>' : '') +
          '<span class="badge ' + lv.cls + '">' + esc(lv.label) + '</span>' +
          '<span class="nttl2">' + esc(n.title || '（无标题）') + '</span>' +
          (n.published === false ? '<span class="badge b-gray">草稿</span>' : '') +
        '</div>' +
        '<div class="nprev">' + esc(preview(n.body)) + '</div>' +
        '<div class="ntime">' + esc(fmtTime(n.created_at)) + '　点开看全文 ›</div>' +
        '</button>';
    }).join('');
    $('notifFoot').textContent = '共 ' + list.length + ' 条通知';
    box.querySelectorAll('[data-ni]').forEach(function (b) {
      b.addEventListener('click', function () { openNotifDetail(parseInt(b.getAttribute('data-ni'), 10)); });
    });
  }

  function openNotifsPanel() {
    notifState.open = true;
    $('notifPanel').classList.remove('hidden');
    renderNotifs();
    if (!notifState.list.length) loadNotifs();
    // 打开即视为读过：圆点当场消失，但本次列表仍按"打开前"的状态标未读点，
    // 用户一眼能看出哪几条是新的。
    markSeen();
    // 用户已经翻过列表了 —— 这些就别再"进首页自动弹"一次，否则等于催两遍
    markPopped((notifState.list || []).map(function (n) { return n.id; }));
    renderNotifBadge();
  }

  function toggleNotifs() {
    if (notifState.open) { closeNotifs(); return; }
    openNotifsPanel();
  }

  function closeNotifs() {
    if (!notifState.open) return;
    notifState.open = false;
    $('notifPanel').classList.add('hidden');
  }

  /* opt.auto = 这条是"进首页自动弹出"的，加个「新通知」标记与金色描边，
     并把剩余条数写进按钮，用户知道还有没有别的要看。 */
  function openNotifDetail(i, opt) {
    var n = (notifState.list || [])[i];
    if (!n) return;
    opt = opt || {};
    var more = opt.more || 0;
    var lv = nlevel(n.level);
    $('nTitle').textContent = n.title || '（无标题）';
    $('nMeta').innerHTML =
      (opt.auto ? '<span class="badge b-gold">新通知</span>' : '') +
      '<span class="badge ' + lv.cls + '">' + esc(lv.label) + '</span>' +
      '<span class="mono-small">' + esc(fmtTime(n.created_at)) + '</span>' +
      (n.published === false ? '<span class="badge b-gray">草稿（客户不可见）</span>' : '');
    // textContent + CSS white-space:pre-wrap —— 换行照原样保留，同时不可能被注入标签
    $('nBody').textContent = n.body || '';
    $('nOk').textContent = more > 0 ? ('知道了（还有 ' + more + ' 条新通知）') : '知道了';
    $('nMore').classList.toggle('hidden', more <= 0);
    $('nModal').querySelector('.ncard').classList.toggle('auto', !!opt.auto);
    closeNotifs();
    $('nModal').classList.remove('hidden');
  }

  function closeNotifDetail() {
    $('nModal').classList.add('hidden');
    $('nModal').querySelector('.ncard').classList.remove('auto');
    $('nOk').textContent = '知道了';
    $('nMore').classList.add('hidden');
  }

  /* ---------- 运营台：通知发布 ---------- */
  function renderNotifAdmin() {
    if (!$('notifAdminBody')) return;
    var list = notifState.list || [];
    var pub = list.filter(function (n) { return n.published !== false; }).length;
    var chip = $('notifAdminCnt');
    chip.textContent = list.length ? (list.length + ' 条 · 已发布 ' + pub) : '还没有通知';
    chip.className = 'chip ' + (list.length ? 'good' : 'warn');

    if (!list.length) {
      $('notifAdminBody').innerHTML = '<tr><td colspan="5"><div class="empty-state">' +
        (notifState.err ? ('读取失败：' + esc(notifState.err)) : '还没有发过通知。在上面的表单里写一条即可。') +
        '</div></td></tr>';
      return;
    }
    $('notifAdminBody').innerHTML = list.map(function (n) {
      var lv = nlevel(n.level);
      var draft = (n.published === false);
      return '<tr>' +
        '<td class="l">' + esc(n.title || '（无标题）') + '</td>' +
        '<td class="l"><span class="badge ' + lv.cls + '">' + esc(lv.label) + '</span></td>' +
        '<td class="l">' + (draft ? '<span class="badge b-gray">草稿</span>' : '<span class="badge b-green">已发布</span>') + '</td>' +
        '<td class="l mono-small">' + esc(fmtTime(n.updated_at || n.created_at)) + '</td>' +
        '<td class="l"><div class="ops">' +
          '<button class="btn sm" data-nedit="' + esc(n.id) + '">编辑</button>' +
          '<button class="btn sm" data-ntog="' + esc(n.id) + '">' + (draft ? '发布' : '撤回') + '</button>' +
          '<button class="btn sm danger" data-ndel="' + esc(n.id) + '">删除</button>' +
        '</div></td></tr>';
    }).join('');
    $('notifAdminBody').querySelectorAll('[data-nedit]').forEach(function (b) {
      b.addEventListener('click', function () { startEditNotif(b.getAttribute('data-nedit')); });
    });
    $('notifAdminBody').querySelectorAll('[data-ntog]').forEach(function (b) {
      b.addEventListener('click', function () { togglePublish(b.getAttribute('data-ntog')); });
    });
    $('notifAdminBody').querySelectorAll('[data-ndel]').forEach(function (b) {
      b.addEventListener('click', function () { delNotif(b.getAttribute('data-ndel')); });
    });
  }

  function findNotif(id) {
    return (notifState.list || []).filter(function (x) { return String(x.id) === String(id); })[0];
  }

  function resetNotifForm() {
    notifState.editing = null;
    if ($('nTitleIn')) $('nTitleIn').value = '';
    if ($('nBodyIn')) $('nBodyIn').value = '';
    if ($('nLevelIn')) $('nLevelIn').value = 'info';
    if ($('nPubIn')) $('nPubIn').checked = true;
    if ($('btnNotifSave')) $('btnNotifSave').textContent = '发布通知';
    if ($('notifFormTip')) $('notifFormTip').textContent = '';
  }

  function startEditNotif(id) {
    var n = findNotif(id);
    if (!n) return;
    notifState.editing = id;
    $('nTitleIn').value = n.title || '';
    $('nBodyIn').value = n.body || '';
    $('nLevelIn').value = NLEVEL[n.level] ? n.level : 'info';
    $('nPubIn').checked = (n.published !== false);
    $('btnNotifSave').textContent = '保存修改';
    $('notifFormTip').textContent = '正在修改：《' + (n.title || '（无标题）') + '》，改完点「保存修改」。';
    $('notifForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  async function saveNotif() {
    if (notifState.busy) return;
    var title = val('nTitleIn'), body = val('nBodyIn');
    var lvEl = $('nLevelIn'), pbEl = $('nPubIn');
    var level = lvEl ? lvEl.value : 'info';
    var published = pbEl ? !!pbEl.checked : true;
    if (!title) { toast('err', '请填写通知标题'); return; }
    if (!body) { toast('err', '请填写通知内容'); return; }
    if (title.length > 80) { toast('err', '标题不能超过 80 字'); return; }
    if (body.length > 4000) { toast('err', '内容不能超过 4000 字'); return; }

    notifState.busy = true;
    var btn = $('btnNotifSave');
    btn.disabled = true;
    var editing = notifState.editing;
    busy(true, editing ? '正在保存…' : '正在发布…');
    try {
      var now = new Date().toISOString();
      var r;
      if (editing) {
        r = await cloud.database.from('notifications')
          .update({ title: title, body: body, level: level, published: published, updated_at: now })
          .eq('id', editing).select();
        if (!r.error && (!r.data || !r.data.length)) r.error = new Error('没有更新到任何行（权限或记录不存在）');
      } else {
        // 不要自己传 created_by —— 它是 text 且 DEFAULT auth.uid()。
        // 曾经写成 created_by: S.userId 而列是 uuid，于是运营方一发通知就报
        // invalid input syntax for type uuid: "2099891421614968832"。
        // 平台的 user.id 是 19 位数字字符串（不是 uuid），作者身份交给服务端更可靠、也防伪造。
        r = await cloud.database.from('notifications')
          .insert({ title: title, body: body, level: level, published: published, updated_at: now })
          .select();
      }
      if (r.error) throw r.error;
      toast('ok', editing ? '通知已更新' : (published ? '通知已发布，客户刷新页面即可看到' : '已存为草稿（客户看不到）'), 5600);
      resetNotifForm();
      await loadNotifs();
    } catch (e) {
      toast('err', '保存失败：' + notifErr(e), 8000);
    } finally {
      notifState.busy = false;
      btn.disabled = false;
      busy(false);
    }
  }

  async function togglePublish(id) {
    var n = findNotif(id);
    if (!n) return;
    var next = (n.published === false);
    busy(true, next ? '正在发布…' : '正在撤回…');
    try {
      var r = await cloud.database.from('notifications')
        .update({ published: next, updated_at: new Date().toISOString() }).eq('id', id).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error('没有更新到任何行（权限或记录不存在）');
      toast('ok', next ? '已发布，客户可见' : '已撤回，客户不可见');
      if (notifState.editing && String(notifState.editing) === String(id)) resetNotifForm();
      await loadNotifs();
    } catch (e) {
      toast('err', '操作失败：' + notifErr(e), 8000);
    } finally { busy(false); }
  }

  async function delNotif(id) {
    var n = findNotif(id);
    if (!n) return;
    if (!confirm('确认删除这条通知？\n《' + (n.title || '（无标题）') + '》\n删除后客户侧立即消失，无法恢复。')) return;
    busy(true, '正在删除…');
    try {
      var r = await cloud.database.from('notifications').delete().eq('id', id).select();
      if (r.error) throw r.error;
      if (!r.data || !r.data.length) throw new Error('没有删除到任何行（权限或记录不存在）');
      toast('ok', '已删除');
      if (notifState.editing && String(notifState.editing) === String(id)) resetNotifForm();
      await loadNotifs();
    } catch (e) {
      toast('err', '删除失败：' + notifErr(e), 8000);
    } finally { busy(false); }
  }

  function clearNotifState() {
    notifState.list = [];
    notifState.editing = null;
    notifState.err = '';
    closeNotifs();
    closeNotifDetail();
    resetNotifForm();
  }

  /* ==================== 绑定事件 ==================== */
  function bind() {
    document.querySelectorAll('[data-theme-toggle]').forEach(function (b) {
      b.addEventListener('click', toggleTheme);
    });
    syncThemeControls();
    createLoginParticles();
    createAmbientParticles();
    document.querySelectorAll('.app-tab').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });
    // 顶部「登录/注册」分段控件：直接切状态并重绘表单。
    // 以前是去"点"表单内的 [data-go="signup"] 链接，而登录面板里没有这个链接，
    // 结果只高亮按钮、表单不动 —— 用户就在登录表单上填邮箱密码想注册。
    var segL = $('segLogin'), segG = $('segSignup');
    if (segL) segL.addEventListener('click', function () { setAuthMode('login-password'); });
    if (segG) segG.addEventListener('click', function () { setAuthMode('signup'); });

    // 登录后可随时给当前账号设置/重设登录密码
    // （用验证码注册或登录过的账号没有密码，这是唯一能补上的入口）
    var sp = $('btnSetPwd');
    if (sp) sp.addEventListener('click', function () { offerSetPassword(S.userEmail || '', 'manual'); });

    $('btnSignOut').addEventListener('click', doSignOut);
    $('btnGateRetry').addEventListener('click', function () { busy(true, '正在重新校验…'); checkAccess().then(function () { busy(false); }); });
    $('btnGateSignOut').addEventListener('click', doSignOut);
    $('btnCopyUidGate').addEventListener('click', function () {
      copyText(S.userId || '').then(function (ok) { toast(ok ? 'ok' : 'err', ok ? '用户 ID 已复制' : '复制失败'); });
    });

    var drop = $('drop');
    drop.addEventListener('click', pickFile);
    $('fileInput').addEventListener('change', function (e) { onFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      drop.addEventListener(ev, function (e) { e.preventDefault(); drop.classList.remove('over'); });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) onFile(e.dataTransfer.files[0]);
    });
    $('btnUpload').addEventListener('click', doUpload);
    $('btnCancelUpload').addEventListener('click', function () {
      pending = null; $('preview').classList.remove('show'); $('fileInput').value = '';
      toast('ok', '已取消本次上传');
    });
    $('btnSample').addEventListener('click', useSample);
    $('btnDownAll').addEventListener('click', downloadAll);

    /* ---------- 实控人风险日志 ---------- */
    var riskDrop = $('riskDrop');
    function pickRiskFile() { $('riskFileInput').click(); }
    $('btnRiskPick').addEventListener('click', pickRiskFile);
    riskDrop.addEventListener('click', pickRiskFile);
    $('riskFileInput').addEventListener('change', function (e) { onRiskFile(e.target.files[0]); });
    ['dragenter', 'dragover'].forEach(function (ev) {
      riskDrop.addEventListener(ev, function (e) { e.preventDefault(); riskDrop.classList.add('over'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      riskDrop.addEventListener(ev, function (e) { e.preventDefault(); riskDrop.classList.remove('over'); });
    });
    riskDrop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) onRiskFile(e.dataTransfer.files[0]);
    });
    $('btnRiskUpload').addEventListener('click', uploadRiskLog);
    $('btnRiskCancel').addEventListener('click', function () {
      riskPending = null; $('riskPreview').classList.remove('show'); $('riskFileInput').value = '';
      toast('ok', '已取消本次风险日志上传');
    });
    $('btnRiskFilter').addEventListener('click', applyRiskFilter);
    $('btnRiskClear').addEventListener('click', function () {
      $('riskPrefixes').value = ''; $('riskQuery').value = ''; $('riskMinAccounts').value = '2'; applyRiskFilter();
    });
    $('riskPrefixes').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyRiskFilter(); });
    $('riskQuery').addEventListener('keydown', function (e) { if (e.key === 'Enter') applyRiskFilter(); });
    $('riskMinAccounts').addEventListener('change', applyRiskFilter);
    $('btnRiskExport').addEventListener('click', exportRiskResults);
    $('btnRiskRefresh').addEventListener('click', function () { loadDatasets().then(function () { toast('ok', '风险日志历史已刷新'); }); });

    /* ---------- 工作站总览快捷入口 ---------- */
    ['btnOverviewMarket', 'btnOverviewMarket2'].forEach(function (id) {
      $(id).addEventListener('click', function () { switchTab('market'); });
    });
    ['btnOverviewRisk', 'btnOverviewFilter', 'btnQuickSearch'].forEach(function (id) {
      $(id).addEventListener('click', function () {
        switchTab('risk');
        setTimeout(function () { if ($('riskQuery')) $('riskQuery').focus(); }, 30);
      });
    });
    $('btnOverviewExport').addEventListener('click', openExport);

    /* ---------- 成果导出 ---------- */
    $('btnExport').addEventListener('click', openExport);
    $('exClose').addEventListener('click', closeExport);
    $('exCancel').addEventListener('click', closeExport);
    $('exMask').addEventListener('click', closeExport);
    $('exOptHtml').addEventListener('click', function () { pickKind('html'); });
    $('exOptPng').addEventListener('click', function () { pickKind('png'); });
    $('exGo').addEventListener('click', doExport);
    $('exScaleSeg').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('click', function () {
        $('exScaleSeg').querySelectorAll('button').forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
        exState.scale = Number(b.getAttribute('data-scale')) || 2;
        renderScaleNote();
      });
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && exState.open) closeExport();
    });

    /* ---------- 消息通知 ---------- */
    $('btnBell').addEventListener('click', function (e) { e.stopPropagation(); toggleNotifs(); });
    $('notifRefresh').addEventListener('click', function () { loadNotifs().then(function () { toast('ok', '通知已刷新'); }); });
    $('nClose').addEventListener('click', closeNotifDetail);
    $('nOk').addEventListener('click', closeNotifDetail);
    $('nMask').addEventListener('click', closeNotifDetail);
    // 自动弹窗底部「查看全部」：关掉详情，直接把铃铛浮窗摊开。
    // 必须 stopPropagation —— 否则这次点击继续冒泡到 document 上那个
    // "点外面就收起浮窗"的处理函数，刚摊开的浮窗会被当场关掉。
    $('nMore').addEventListener('click', function (e) {
      if (e && e.stopPropagation) e.stopPropagation();
      closeNotifDetail();
      openNotifsPanel();
    });
    $('btnNotifSave').addEventListener('click', saveNotif);
    $('btnNotifReset').addEventListener('click', function () { resetNotifForm(); toast('ok', '表单已清空'); });
    $('btnNewNotif').addEventListener('click', function () {
      resetNotifForm();
      $('notifForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      $('nTitleIn').focus();
    });
    $('btnRefreshNotif').addEventListener('click', function () { loadNotifs().then(function () { toast('ok', '通知列表已刷新'); }); });
    document.addEventListener('click', function (e) {
      if (!notifState.open) return;
      var p = $('notifPanel'), b = $('btnBell'), m = $('nModal');
      // 详情弹窗里的按钮（如「查看全部」）会主动摊开/收起浮窗，不算"点了外面"
      if (p.contains(e.target) || b.contains(e.target) || m.contains(e.target)) return;
      closeNotifs();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!$('nModal').classList.contains('hidden')) { closeNotifDetail(); return; }
      closeNotifs();
    });

    $('btnRefreshHist').addEventListener('click', function () { loadDatasets().then(function () { toast('ok', '历史列表已刷新'); }); });
    $('btnRefreshAdmin').addEventListener('click', function () { loadOperator().then(function () { toast('ok', '授权列表已刷新'); }); });
    $('btnTemplate').addEventListener('click', function () {
      try {
        var wb = XLSX.utils.book_new();
        var guide = [
          ['铜期货数据看板 · 源数据模板（精简版）'],
          ['说明', '把本文件另存为 .xlsx 后填写，上传到看板即可渲染。'],
          ['必填', 'KLINE 表：日期 / 开盘 / 最高 / 最低 / 收盘 / 成交量 / 持仓量（按日期从旧到新）'],
          ['可选', 'META / SUMMARY / CONTRACTS / RANK / OPTIONS_META / COST 等，缺省时看板会自动留空或按 KLINE 推导。']
        ];
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(guide), '说明');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['字段', '值'], ['product', 'cu'], ['产品名称', '铜'], ['交易所', 'SHFE'], ['价格单位', '元/吨'],
          ['主力合约', 'cu2610'], ['连续合约', 'cu888'], ['数据日期', new Date().toISOString().slice(0, 10)],
          ['生成时间', fmtTime(new Date())], ['数据来源', '客户自有数据'], ['免责声明', '仅供研究参考，不构成投资建议']
        ]), 'META');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['日期', '开盘', '最高', '最低', '收盘', '成交量', '持仓量'],
          ['09-01', 100000, 101000, 99500, 100500, 10000, 200000],
          ['09-02', 100500, 101200, 100100, 100900, 12000, 201000]
        ]), 'KLINE');
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
          ['合约', '收盘价', '结算价', '成交量', '持仓量', '是否主力'],
          ['cu2610', 100900, 100800, 12000, 201000, '是'],
          ['cu2611', 100600, 100500, 8000, 150000, '']
        ]), 'CONTRACTS');
        XLSX.writeFile(wb, '看板数据模板_精简版.xlsx');
        toast('ok', '模板已下载');
      } catch (e) { toast('err', '模板生成失败：' + (e && e.message ? e.message : String(e))); }
    });

    cloud.auth.onAuthStateChange(function (event) {
      if (event === 'SIGNED_OUT') {
        if (!$('viewApp').classList.contains('hidden') || !$('viewGate').classList.contains('hidden')) {
          hide('viewApp'); hide('viewGate'); show('viewAuth'); renderAuth();
        }
      }
    });
  }

  /* ==================== 启动 ==================== */
  function start() {
    if (!window.WorkBuddyCloud || !window.WorkBuddyCloud.createWorkBuddyCloud) {
      document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#ff5252">SDK 加载失败：无法访问 CDN。请检查网络后刷新页面。</div>';
      return;
    }
    if (!window.XLSX) {
      document.body.innerHTML = '<div style="padding:40px;font-family:monospace;color:#ff5252">Excel 解析库加载失败：无法访问 CDN。请检查网络后刷新页面。</div>';
      return;
    }
    bind();
    boot().catch(function (e) {
      hide('viewAuth'); hide('viewGate'); hide('viewApp');
      document.body.insertAdjacentHTML('beforeend',
        '<div class="auth-wrap"><div class="auth-card"><div class="gate-title red">启动失败</div><div class="gate-sub">' + esc(e && e.message ? e.message : String(e)) + '</div></div></div>');
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
