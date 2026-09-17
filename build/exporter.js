/* ==========================================================================
   铜数据看板 · 成果导出（Export）
   ---------------------------------------------------------------------------
   全部在浏览器端完成 —— 渲染逻辑本来就在浏览器里（Canvas/SVG），
   搬到服务端反而要额外塞无头浏览器 + 让客户数据多走一趟服务器。

   对外接口（挂在 window.CuExport）：
     CuExport.buildHtml(DATA)                 → 自包含单文件 HTML 字符串
     CuExport.renderPoster(DATA, {scale})     → 竖版长图 <canvas>
     CuExport.posterSize(DATA)                → {w, h} 逻辑尺寸
     CuExport.downloadBlob(blob, filename)
     CuExport.downloadText(text, filename)
     CuExport.safeName(DATA, ext)             → 合规文件名

   数据契约与 render.js 完全一致：见 build/copper_data.json
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 设计令牌（与 theme.css 对齐） ---------- */
  const C = {
    bg: '#0a0e17', bg2: '#0d1320', panel: '#131a2a', panel2: '#1a2236',
    border: '#27324a', border2: '#33415c', text: '#d7dbe7', dim: '#7c8699', dim2: '#5b6478',
    gold: '#f0b90b', gold2: '#ffd24a',
    up: '#ff1744', up2: '#ff5252', down: '#00c853', down2: '#1fe074',
    gray: '#9e9e9e', blue: '#3d7fff', cyan: '#26c6da', white: '#ffffff'
  };
  const F = {
    sans: '"Microsoft YaHei","PingFang SC","Hiragino Sans GB",-apple-system,"Segoe UI",sans-serif',
    mono: '"SF Mono","JetBrains Mono","Cascadia Code",Consolas,"Courier New",monospace'
  };

  const PW = 1080;   // 长图逻辑宽度（微信/钉钉阅读友好）
  const PAD = 44;    // 左右留白
  const CW = PW - PAD * 2;

  const nf = (n, d) => {
    if (n === null || n === undefined || n === '') return '—';
    const x = Number(n);
    if (!isFinite(x)) return String(n);
    return x.toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
  };
  const sp = (n, d) => (Number(n) > 0 ? '+' : '') + Number(n).toFixed(d === undefined ? 0 : d);
  const spct = (n, d) => (Number(n) > 0 ? '+' : '') + Number(n).toFixed(d === undefined ? 2 : d) + '%';
  const tcol = d => (d === null || d === undefined || !isFinite(Number(d)) ? C.dim : (Number(d) >= 0 ? C.up : C.down));
  const esc = s => String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /* ---------- 画布状态（测量遍历与绘制遍历共用同一套代码） ---------- */
  let ctx = null, y = 0;

  function rr(x, yy, w, h, r) {
    r = Math.min(r === undefined ? 10 : r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + r, yy);
    ctx.lineTo(x + w - r, yy);
    ctx.arcTo(x + w, yy, x + w, yy + r, r);
    ctx.lineTo(x + w, yy + h - r);
    ctx.arcTo(x + w, yy + h, x + w - r, yy + h, r);
    ctx.lineTo(x + r, yy + h);
    ctx.arcTo(x, yy + h, x, yy + h - r, r);
    ctx.lineTo(x, yy + r);
    ctx.arcTo(x, yy, x + r, yy, r);
    ctx.closePath();
  }

  function box(x, yy, w, h, opt) {
    opt = opt || {};
    rr(x, yy, w, h, opt.r === undefined ? 12 : opt.r);
    if (opt.fill !== false) { ctx.fillStyle = opt.fill || C.panel; ctx.fill(); }
    if (opt.stroke !== false) {
      ctx.strokeStyle = opt.stroke || C.border;
      ctx.lineWidth = opt.lw || 1;
      ctx.stroke();
    }
  }

  function txt(s, x, yy, opt) {
    opt = opt || {};
    ctx.font = opt.font || ('400 18px ' + F.sans);
    ctx.fillStyle = opt.color || C.text;
    ctx.textAlign = opt.align || 'left';
    ctx.textBaseline = opt.baseline || 'alphabetic';
    const str = (s === null || s === undefined) ? '' : String(s);
    if (opt.maxWidth) ctx.fillText(str, x, yy, opt.maxWidth);
    else ctx.fillText(str, x, yy);
  }

  function tw(s, font) {
    ctx.font = font || ('400 18px ' + F.sans);
    return ctx.measureText(String(s === null || s === undefined ? '' : s)).width;
  }

  function seg(x1, y1, x2, y2, col, lw) {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2);
    ctx.strokeStyle = col; ctx.lineWidth = lw || 1; ctx.stroke();
  }

  function poly(pts, col, lw) {
    if (!pts || pts.length < 2) return;
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
    ctx.strokeStyle = col; ctx.lineWidth = lw || 1.5;
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    ctx.stroke();
  }

  /* 区块标题：金色竖条 + 主标题 + 副标题 + 右侧备注 */
  function sec(label, sub, right) {
    const x = PAD;
    box(x, y + 5, 4, 21, { r: 2, fill: C.gold, stroke: false });
    txt(label, x + 16, y + 23, { font: '700 24px ' + F.sans, color: C.white });
    if (sub) txt(sub, x + 16 + tw(label, '700 24px ' + F.sans) + 12, y + 23, { font: '400 15px ' + F.sans, color: C.dim2 });
    if (right) txt(right, x + CW, y + 23, { font: '400 15px ' + F.mono, color: C.dim, align: 'right' });
    y += 42;
  }

  /* 指标卡 */
  function card(x, yy, w, h, label, value, sub, tone, note) {
    box(x, yy, w, h, { fill: C.panel, stroke: C.border });
    box(x, yy, 3, h, { r: 1.5, fill: tone || C.gold, stroke: false });
    txt(label, x + 18, yy + 27, { font: '400 16px ' + F.sans, color: C.dim });
    /* 数值自适应缩字号：像"112,330 / 100,500"这种长值在窄卡里会被截断 */
    const avail = w - 36;
    let vFont = '700 30px ' + F.mono;
    const vw = tw(value, vFont);
    if (vw > avail) {
      let size = Math.floor(30 * avail / vw);
      if (size < 16) size = 16;
      vFont = '700 ' + size + 'px ' + F.mono;
    }
    txt(value, x + 18, yy + 62, { font: vFont, color: tone || C.text });
    const extra = sub || note;
    if (extra) txt(extra, x + 18, yy + 86, { font: '400 15px ' + F.sans, color: C.dim2, maxWidth: w - 30 });
  }

  /* 表格行 */
  function row(x, yy, w, cells, opt) {
    opt = opt || {};
    const h = opt.h || 34;
    if (opt.alt) { box(x, yy, w, h, { r: 6, fill: 'rgba(255,255,255,0.02)', stroke: false }); }
    let cx = x + 10;
    cells.forEach((c, i) => {
      if (!c) return;
      txt(c.v, i === cells.length - 1 && opt.lastRight !== false ? x + w - 10 : cx, yy + h - 11, {
        font: c.font || ('400 17px ' + F.mono),
        color: c.color || C.text,
        align: (i === cells.length - 1 && opt.lastRight !== false) ? 'right' : 'left',
        maxWidth: c.w
      });
      cx += c.w || 0;
    });
    return h;
  }

  /* ======================================================================
     ① 封面头
     ====================================================================== */
  function drawHeader(D) {
    const m = D.meta || {}, s = D.summary || {};
    const H = 214;
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#121d33'); g.addColorStop(1, C.bg);
    ctx.fillStyle = g; ctx.fillRect(0, 0, PW, H);
    ctx.fillStyle = C.gold; ctx.fillRect(0, 0, PW, 5);

    const x = PAD;
    txt('铜期货数据看板', x, 76, { font: '800 44px ' + F.sans, color: C.white });
    txt('CU FUTURES DATA DASHBOARD', x, 106, { font: '400 15px ' + F.mono, color: C.gold });

    txt((m.exchange || 'SHFE') + ' · ' + (m.contract || '—'), PW - x, 60, { font: '600 20px ' + F.mono, color: C.text, align: 'right' });
    txt('数据日期 ' + (m.date || '—'), PW - x, 88, { font: '400 16px ' + F.mono, color: C.dim, align: 'right' });
    txt('生成时间 ' + (m.generatedAt || '—'), PW - x, 113, { font: '400 15px ' + F.mono, color: C.dim2, align: 'right' });

    // 收盘价带
    const chg = Number(s.chg), col = tcol(isFinite(chg) ? chg : 0);
    txt(nf(s.close), x, 176, { font: '800 56px ' + F.mono, color: col });
    const wClose = tw(nf(s.close), '800 56px ' + F.mono);
    txt(sp(chg) + '  ' + spct(s.chgPct), x + wClose + 18, 176, { font: '700 26px ' + F.mono, color: col });
    txt('元/吨', x + wClose + 18 + tw(sp(chg) + '  ' + spct(s.chgPct), '700 26px ' + F.mono) + 14, 176,
      { font: '400 17px ' + F.sans, color: C.dim });

    // 右上小标签
    const tags = [
      (D.term && D.term.structure) ? D.term.structure : null,
      (s.fromHigh !== undefined && s.fromHigh !== null) ? '距周期高 ' + spct(s.fromHigh) : null
    ].filter(Boolean);
    let tx = PW - x;
    tags.slice().reverse().forEach(t => {
      const w = tw(t, '400 16px ' + F.sans) + 26;
      box(tx - w, 136, w, 32, { r: 16, fill: 'rgba(240,185,11,0.10)', stroke: 'rgba(240,185,11,0.35)' });
      txt(t, tx - w / 2, 158, { font: '400 16px ' + F.sans, color: C.gold2, align: 'center' });
      tx -= w + 10;
    });

    y = H + 34;
  }

  /* ======================================================================
     ② 核心指标
     ====================================================================== */
  function drawMetrics(D) {
    const s = D.summary || {}, r = D.rank || {}, wh = D.warehouse || {};
    sec('核心指标', 'CORE METRICS', '数据日期 ' + ((D.meta && D.meta.date) || '—'));

    const items = [
      ['最新收盘', nf(s.close), sp(s.chg) + ' / ' + spct(s.chgPct), tcol(s.chg)],
      ['MA5', nf(s.ma5), '偏离 ' + spct(s.ma5DiffPct), tcol(s.ma5Diff)],
      ['MA20', nf(s.ma20), '均线参照', C.gold],
      ['ATR', nf(s.atr, 1), '波动幅度', C.cyan],
      ['周期高 / 低', nf(s.high60) + ' / ' + nf(s.low60), '60 根 K 线区间', C.text],
      ['成交量', nf(s.volume), '持仓 ' + nf(s.openInterest), C.blue],
      ['净多空（前20）', nf(r.netLongShort), r.signal || '—', tcol(r.netLongShort)],
      ['交易所仓单', nf(wh.stocks), (wh.change ? sp(wh.change) : '持平'), tcol(wh.change)]
    ];
    const cols = 4, gap = 14;
    const w = (CW - gap * (cols - 1)) / cols, h = 108;

    items.forEach((it, i) => {
      const cx = PAD + (i % cols) * (w + gap);
      const cy = y + Math.floor(i / cols) * (h + gap);
      card(cx, cy, w, h, it[0], it[1], it[2], it[3]);
    });
    y += Math.ceil(items.length / cols) * (h + gap) + 12;
  }

  /* ======================================================================
     ③ 价格走势（蜡烛 + 均线）
     ====================================================================== */
  function drawCandles(D) {
    const kl = (D.kline || []).filter(k => k && isFinite(Number(k.c)));
    if (kl.length < 2) return;

    const H = 372;
    sec('价格走势', 'PRICE ACTION', kl.length + ' 根日K · MA5 / MA20');

    box(PAD, y, CW, H, { fill: C.panel, stroke: C.border });
    const padL = 74, padR = 16, padT = 20, padB = 30;
    const iw = CW - padL - padR, ih = H - padT - padB;

    const ma = n => kl.map((_, i) => {
      let s = 0, c = 0;
      for (let j = Math.max(0, i - n + 1); j <= i; j++) { s += Number(kl[j].c); c++; }
      return s / c;
    });
    const m5 = ma(5), m20 = ma(20);

    let hi = -Infinity, lo = Infinity;
    kl.forEach((k, i) => {
      hi = Math.max(hi, Number(k.h), m5[i], m20[i]);
      lo = Math.min(lo, Number(k.l), m5[i], m20[i]);
    });
    let span = (hi - lo) || 1;
    hi += span * 0.05; lo -= span * 0.05; span = hi - lo;

    const X = i => PAD + padL + iw * (i + 0.5) / kl.length;
    const Y = v => y + padT + ih * (1 - (v - lo) / span);

    // 网格 + 右侧价格刻度
    for (let g = 0; g <= 4; g++) {
      const gy = y + padT + ih * g / 4;
      seg(PAD + padL, gy, PAD + CW - padR, gy, 'rgba(255,255,255,0.05)', 1);
      txt(nf(hi - span * g / 4), PAD + CW - padR - 6, gy - 6,
        { font: '400 14px ' + F.mono, color: C.dim2, align: 'right' });
    }

    // 蜡烛
    const bw = Math.max(3, Math.min(11, iw / kl.length * 0.6));
    kl.forEach((k, i) => {
      const o = Number(k.o), c = Number(k.c), h = Number(k.h), l = Number(k.l);
      const up = c >= o, col = up ? C.up : C.down;
      seg(X(i), Y(h), X(i), Y(l), col, 1);
      const top = Y(Math.max(o, c)), bot = Y(Math.min(o, c));
      ctx.fillStyle = col;
      ctx.fillRect(X(i) - bw / 2, top, bw, Math.max(1.5, bot - top));
    });

    poly(m5.map((v, i) => [X(i), Y(v)]), C.gold, 1.8);
    poly(m20.map((v, i) => [X(i), Y(v)]), C.cyan, 1.8);

    // 图例
    let lx = PAD + padL + 4, ly = y + H - 12;
    [[C.gold, 'MA5 ' + nf(m5[m5.length - 1])], [C.cyan, 'MA20 ' + nf(m20[m20.length - 1])]].forEach(([c, t]) => {
      seg(lx, ly - 5, lx + 18, ly - 5, c, 2);
      txt(t, lx + 24, ly, { font: '400 15px ' + F.mono, color: C.dim });
      lx += 24 + tw(t, '400 15px ' + F.mono) + 26;
    });
    txt('涨 = 红    跌 = 绿', PAD + CW - padR - 6, ly, { font: '400 14px ' + F.sans, color: C.dim2, align: 'right' });

    y += H + 30;
  }

  /* ======================================================================
     ④ 期限结构
     ====================================================================== */
  function drawTerm(D) {
    const t = D.term || {}, cs = (D.contracts || []).filter(c => c && isFinite(Number(c.p)));
    if (!cs.length && !t.structure) return;

    const rows = cs.length || 1;
    const H = 96 + rows * 30 + 90;
    sec('期限结构', 'TERM STRUCTURE', t.structure || '—');
    box(PAD, y, CW, H, { fill: C.panel, stroke: C.border });

    // 结构摘要
    let sy = y + 34;
    txt('近月', PAD + 22, sy, { font: '400 16px ' + F.sans, color: C.dim });
    txt(nf(t.near), PAD + 22, sy + 30, { font: '700 26px ' + F.mono, color: C.text });
    txt('主力', PAD + 172, sy, { font: '400 16px ' + F.sans, color: C.dim });
    txt(nf(t.main), PAD + 172, sy + 30, { font: '700 26px ' + F.mono, color: C.gold2 });
    txt('远月', PAD + 322, sy, { font: '400 16px ' + F.sans, color: C.dim });
    txt(nf(t.far), PAD + 322, sy + 30, { font: '700 26px ' + F.mono, color: C.text });

    txt('近远月价差', PAD + CW - 300, sy, { font: '400 16px ' + F.sans, color: C.dim, align: 'right' });
    txt(nf(t.nearFarSpread), PAD + CW - 200, sy + 30, { font: '700 26px ' + F.mono, color: tcol(t.nearFarSpread), align: 'right' });
    txt('主力-次主力', PAD + CW - 22, sy, { font: '400 16px ' + F.sans, color: C.dim, align: 'right' });
    txt(nf(t.mainSubSpread), PAD + CW - 22, sy + 30, { font: '700 26px ' + F.mono, color: tcol(t.mainSubSpread), align: 'right' });

    // 各合约价格条
    let by = y + 118;
    const maxP = Math.max.apply(null, cs.map(c => Number(c.p)));
    const minP = Math.min.apply(null, cs.map(c => Number(c.p)));
    const barX = PAD + 132, barW = CW - 132 - 96;
    cs.forEach((c, i) => {
      const ry = by + i * 30;
      const isMain = c.set === 1 || i === 0;
      txt(c.c || ('合约' + (i + 1)), PAD + 22, ry + 18,
        { font: (isMain ? '700 ' : '400 ') + '16px ' + F.mono, color: isMain ? C.gold2 : C.text });
      const rw = Math.max(4, barW * (Number(c.p) - minP + 1) / (maxP - minP + 1));
      box(barX, ry + 6, rw, 15, { r: 4, fill: isMain ? 'rgba(240,185,11,0.55)' : 'rgba(61,127,255,0.40)', stroke: false });
      txt(nf(c.p), PAD + CW - 22, ry + 19, { font: '600 16px ' + F.mono, color: C.text, align: 'right' });
    });
    if (t.note) {
      txt(t.note, PAD + 22, y + H - 24, { font: '400 15px ' + F.sans, color: C.dim, maxWidth: CW - 44 });
    }
    y += H + 30;
  }

  /* ======================================================================
     ⑤ 持仓与库存
     ====================================================================== */
  function drawPosition(D) {
    const r = D.rank || {}, wh = D.warehouse || {}, inv = D.inventory || [];
    if (!r.top20 && !wh.stocks && !inv.length) return;
    const has = (r.long && r.long.length) || (r.short && r.short.length);
    const H = has ? 388 : 168;
    sec('持仓与库存', 'POSITION & INVENTORY', r.signal || '');

    const half = (CW - 16) / 2;
    const top20 = r.top20 || {};

    // 左：前20多空
    box(PAD, y, half, 118, { fill: C.panel, stroke: C.border });
    txt('前20 席位多空', PAD + 18, y + 28, { font: '400 16px ' + F.sans, color: C.dim });
    txt('多 ' + nf(top20.long), PAD + 18, y + 66, { font: '700 24px ' + F.mono, color: C.up });
    txt('空 ' + nf(top20.short), PAD + half - 18, y + 66, { font: '700 24px ' + F.mono, color: C.down, align: 'right' });
    txt('净多空 ' + nf(r.netLongShort) + '（' + (r.signal || '—') + '）', PAD + 18, y + 98, { font: '400 16px ' + F.sans, color: tcol(r.netLongShort) });

    // 右：仓单
    box(PAD + half + 16, y, half, 118, { fill: C.panel, stroke: C.border });
    txt((wh.exchange || '交易所') + ' 仓单', PAD + half + 34, y + 28, { font: '400 16px ' + F.sans, color: C.dim });
    txt(nf(wh.stocks), PAD + half + 34, y + 66, { font: '700 24px ' + F.mono, color: C.text });
    txt('较上期 ' + (wh.change !== undefined && wh.change !== null ? sp(wh.change) : '—'), PAD + 2 * half + 16 - 18, y + 66,
      { font: '600 20px ' + F.mono, color: tcol(wh.change), align: 'right' });
    txt(wh.date ? ('截至 ' + wh.date) : (wh.note || ''), PAD + half + 34, y + 98, { font: '400 16px ' + F.sans, color: C.dim2 });

    let cy = y + 134;
    // 多空排行（左右各前5）
    if (has) {
      const ph = 2 * 5 * 28 + 40;
      box(PAD, cy, half, ph, { fill: C.panel, stroke: C.border });
      box(PAD + half + 16, cy, half, ph, { fill: C.panel, stroke: C.border });
      txt('多头持仓前5', PAD + 18, cy + 28, { font: '400 16px ' + F.sans, color: C.dim });
      txt('空头持仓前5', PAD + half + 34, cy + 28, { font: '400 16px ' + F.sans, color: C.dim });
      (r.long || []).slice(0, 5).forEach((it, i) => {
        const ry = cy + 56 + i * 28;
        txt((i + 1) + '. ' + (it.name || '—'), PAD + 18, ry, { font: '400 15px ' + F.sans, color: C.text, maxWidth: half - 150 });
        txt(nf(it.value) + '  ' + sp(it.change), PAD + half - 18, ry, { font: '400 15px ' + F.mono, color: tcol(it.change), align: 'right' });
      });
      (r.short || []).slice(0, 5).forEach((it, i) => {
        const ry = cy + 56 + i * 28;
        txt((i + 1) + '. ' + (it.name || '—'), PAD + half + 34, ry, { font: '400 15px ' + F.sans, color: C.text, maxWidth: half - 150 });
        txt(nf(it.value) + '  ' + sp(it.change), PAD + 2 * half + 16 - 18, ry, { font: '400 15px ' + F.mono, color: tcol(it.change), align: 'right' });
      });
      cy += ph + 16;
    }

    // 库存明细
    if (inv.length) {
      const ih = 34 + inv.length * 30;
      box(PAD, cy, CW, ih, { fill: C.panel, stroke: C.border });
      txt('库存明细', PAD + 18, cy + 26, { font: '400 16px ' + F.sans, color: C.dim });
      inv.slice(0, 6).forEach((it, i) => {
        const ry = cy + 50 + i * 30;
        txt(it.name || '—', PAD + 18, ry + 14, { font: '400 16px ' + F.sans, color: C.text });
        const v = (it.value === null || it.value === undefined ? '—' : nf(it.value)) + (it.unit ? ' ' + it.unit : '');
        txt(v, PAD + CW - 18, ry + 14, { font: '400 16px ' + F.mono, color: C.text, align: 'right' });
      });
      cy += ih;
    }
    y = cy + 30;
  }

  /* ======================================================================
     ⑥ 期权关键位
     ====================================================================== */
  function drawOptions(D) {
    const o = D.options || {};
    if (!o.contract && !o.atmStrike) return;
    sec('期权关键位', 'OPTIONS', o.contract || '');
    const items = [
      ['ATM 行权价', nf(o.atmStrike), '标的价格 ' + nf(o.futuresPrice), C.gold2],
      ['最大痛点', nf(o.maxPain), 'Max Pain', C.cyan],
      ['HV20 / HV60', Number(o.hv20 || 0).toFixed(2) + '% / ' + Number(o.hv60 || 0).toFixed(2) + '%', '历史波动率', C.blue],
      ['PCR（持仓）', Number(o.pcrOi || 0).toFixed(2), '成交量比 ' + Number(o.pcrVolume || 0).toFixed(2), C.text],
      ['看涨 / 看跌 OI', nf(o.totalCallOi) + ' / ' + nf(o.totalPutOi), '合计 ' + nf((Number(o.totalCallOi) || 0) + (Number(o.totalPutOi) || 0)), C.dim],
      ['平值 C / P 权利金', nf(o.callPrice) + ' / ' + nf(o.putPrice), 'Delta ' + (o.callDelta !== undefined ? Number(o.callDelta).toFixed(2) : '—'), C.text]
    ];
    const cols = 3, gap = 14, w = (CW - gap * (cols - 1)) / cols, h = 108;
    items.forEach((it, i) => {
      card(PAD + (i % cols) * (w + gap), y + Math.floor(i / cols) * (h + gap), w, h, it[0], it[1], it[2], it[3]);
    });
    y += Math.ceil(items.length / cols) * (h + gap) + 12;
  }

  /* ======================================================================
     ⑦ 外盘与宏观比价
     ====================================================================== */
  function drawMacro(D) {
    const e = D.external || {}, rs = D.ratios || [];
    if (!e.name && !rs.length) return;
    const H = 118 + rs.length * 42;
    sec('外盘与宏观比价', 'EXTERNAL & RATIOS', e.symbol || '');
    box(PAD, y, CW, H, { fill: C.panel, stroke: C.border });

    if (e.name) {
      txt(e.name, PAD + 22, y + 40, { font: '700 22px ' + F.sans, color: C.white });
      txt(e.symbol || '', PAD + 22 + tw(e.name, '700 22px ' + F.sans) + 14, y + 40, { font: '400 16px ' + F.mono, color: C.dim2 });
      txt(nf(e.close, 4), PAD + CW - 22, y + 42, { font: '700 28px ' + F.mono, color: C.text, align: 'right' });
      txt('日变动 ' + sp(e.chg1d, 4) + '     5日 ' + sp(e.chg5d, 4), PAD + CW - 22, y + 72,
        { font: '400 16px ' + F.mono, color: tcol(e.chg1d), align: 'right' });
      txt('MA5 ' + nf(e.ma5, 4) + '    MA20 ' + nf(e.ma20, 4), PAD + 22, y + 76, { font: '400 16px ' + F.mono, color: C.dim });
    }
    rs.forEach((r, i) => {
      const ry = y + 106 + i * 42;
      seg(PAD + 14, ry, PAD + CW - 14, ry, 'rgba(255,255,255,0.05)', 1);
      txt(r.n || '—', PAD + 22, ry + 28, { font: '400 17px ' + F.sans, color: C.text });
      txt(r.v || '—', PAD + 480, ry + 28, { font: '600 17px ' + F.mono, color: C.text });
      const sig = r.pct || '';
      txt(sig, PAD + 690, ry + 28, { font: '400 16px ' + F.mono, color: C.dim });
      if (r.sig) txt(r.sig, PAD + CW - 22, ry + 28, { font: '600 16px ' + F.sans, color: C.gold2, align: 'right' });
    });
    y += H + 30;
  }

  /* ======================================================================
     ⑧ 舆情与季节性
     ====================================================================== */
  function drawSentiment(D) {
    const s = D.sentiment || {}, sea = D.season || [];
    if (!s.snapshot && !sea.length) return;
    sec('舆情与季节性', 'SENTIMENT & SEASONALITY', s.signal || '');

    // 舆情窗口
    const wins = (s.windows || []).filter(Boolean);
    const tH = wins.length ? 96 + wins.length * 40 : 96;
    box(PAD, y, CW, tH, { fill: C.panel, stroke: C.border });
    txt('舆情快照', PAD + 22, y + 30, { font: '400 16px ' + F.sans, color: C.dim });
    txt(s.snapshot || '—', PAD + 22, y + 62, { font: '400 17px ' + F.sans, color: C.text, maxWidth: CW - 44 });
    const kv = [];
    if (s.total48h !== undefined) kv.push('48h 消息 ' + nf(s.total48h));
    if (s.total24h !== undefined) kv.push('24h ' + nf(s.total24h));
    if (s.alertCount !== undefined) kv.push('预警 ' + nf(s.alertCount));
    if (s.momentum) kv.push('动能 ' + s.momentum);
    txt(kv.join('    '), PAD + 22, y + 84, { font: '400 15px ' + F.mono, color: C.gold2, maxWidth: CW - 44 });

    wins.forEach((win, i) => {
      const ry = y + 108 + i * 40;
      txt(win.label || '—', PAD + 22, ry + 22, { font: '400 16px ' + F.sans, color: C.text, maxWidth: 150 });
      const sc = Number(win.score) || 0;
      const norm = Math.max(-1, Math.min(1, sc));
      const barX = PAD + 190, barW = CW - 190 - 190, midX = barX + barW / 2;
      box(barX, ry + 8, barW, 14, { r: 7, fill: 'rgba(255,255,255,0.05)', stroke: false });
      const half = barW / 2;
      const bw2 = Math.abs(norm) * half;
      if (norm >= 0) box(midX, ry + 8, Math.max(2, bw2), 14, { r: 7, fill: 'rgba(255,23,68,0.72)', stroke: false });
      else box(midX - Math.max(2, bw2), ry + 8, Math.max(2, bw2), 14, { r: 7, fill: 'rgba(0,200,83,0.72)', stroke: false });
      txt(win.verdict || '', PAD + CW - 22, ry + 22, { font: '600 16px ' + F.sans, color: tcol(sc), align: 'right' });
    });
    y += tH + 16;

    // 季节性
    if (sea.length) {
      const H = 220;
      box(PAD, y, CW, H, { fill: C.panel, stroke: C.border });
      txt('月度季节性（历史平均收益 / 上涨概率）', PAD + 22, y + 30, { font: '400 16px ' + F.sans, color: C.dim });
      const maxAbs = Math.max.apply(null, sea.map(x => Math.abs(Number(x.r) || 0))) || 1;
      const gw = (CW - 44) / sea.length;
      /* 基准线抬高 + 卡片加高：让最长的负值柱（52px）也够不到月份标签 */
      const baseY = y + 104;
      sea.forEach((m, i) => {
        const cx = PAD + 22 + i * gw + gw / 2;
        const r = Number(m.r) || 0;
        const h = Math.abs(r) / maxAbs * 52;
        const col = r >= 0 ? 'rgba(255,23,68,0.80)' : 'rgba(0,200,83,0.80)';
        box(cx - gw * 0.30, r >= 0 ? baseY - h : baseY, gw * 0.60, Math.max(2, h), { r: 3, fill: col, stroke: false });
        txt((m.m || '').replace('月', ''), cx, y + H - 38, { font: '400 15px ' + F.sans, color: C.dim, align: 'center' });
        txt(Number(r).toFixed(1), cx, y + H - 16, { font: '400 14px ' + F.mono, color: tcol(r), align: 'center' });
      });
      seg(PAD + 22, baseY, PAD + CW - 22, baseY, 'rgba(255,255,255,0.16)', 1);
      y += H + 30;
    } else y += 14;
  }

  /* ======================================================================
     ⑨ 交易成本
     ====================================================================== */
  function drawCost(D) {
    const c = D.cost || {};
    if (!c.price && !c.marginPerLot) return;
    sec('交易成本估算', 'TRADING COST', '按 1 手 · 非平今');
    const items = [
      ['开仓手续费', nf(c.openFee, 2), '成交额 × ' + (c.commissionRate || 0) + '%', C.text],
      ['平昨手续费', nf(c.closeFee, 2), '非平今仓', C.text],
      ['平今手续费', nf(c.closeTodayFee, 2), '成交额 × ' + (c.closeTodayRate || 0) + '%', C.warn || C.gold2],
      ['往返成本', nf(c.roundTrip, 2), '开 + 平昨', C.gold2],
      ['保证金 / 手', nf(c.marginPerLot, 1), '保证金率 ' + (c.marginRate || 0) + '%', C.blue],
      ['合约乘数 / 最小变动', nf(c.volumeMultiple) + ' 吨 / ' + nf(c.priceTick) + ' 元', c.marginModel || '', C.dim]
    ];
    const cols = 3, gap = 14, w = (CW - gap * (cols - 1)) / cols, h = 108;
    items.forEach((it, i) => {
      card(PAD + (i % cols) * (w + gap), y + Math.floor(i / cols) * (h + gap), w, h, it[0], it[1], it[2], it[3]);
    });
    y += Math.ceil(items.length / cols) * (h + gap) + 12;
  }

  /* ======================================================================
     ⑩ 页脚
     ====================================================================== */
  function drawFooter(D) {
    const m = D.meta || {};
    y += 4;
    seg(PAD, y, PAD + CW, y, C.border, 1);
    y += 26;
    txt('数据来源：' + (m.source || '—') + '　·　项目：' + (m.project || '—') + '　·　生成时间：' + (m.generatedAt || '—'),
      PAD, y, { font: '400 15px ' + F.sans, color: C.dim2, maxWidth: CW });
    y += 26;
    txt(m.disclaimer || '仅供研究参考，不构成投资建议', PAD, y, { font: '600 15px ' + F.sans, color: C.dim });
    y += 30;
  }

  /* ---------- 版面装配 ---------- */
  function layout(D) {
    drawHeader(D);
    drawMetrics(D);
    drawCandles(D);
    drawTerm(D);
    drawPosition(D);
    drawOptions(D);
    drawMacro(D);
    drawSentiment(D);
    drawCost(D);
    drawFooter(D);
  }

  /* ======================================================================
     对外接口
     ====================================================================== */
  function renderPoster(D, opt) {
    opt = opt || {};
    const scale = Math.max(0.3, Math.min(3, Number(opt.scale) || 2));

    // 第一遍：测量（在 1×1 画布上跑同一套 layout，只取最终 y）
    const probe = document.createElement('canvas');
    probe.width = 1; probe.height = 1;
    ctx = probe.getContext('2d');
    y = 0;
    layout(D);
    const H = Math.ceil(y);

    // 第二遍：真正绘制
    const cv = document.createElement('canvas');
    cv.width = Math.round(PW * scale);
    cv.height = Math.round(H * scale);
    ctx = cv.getContext('2d');
    ctx.scale(scale, scale);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, PW, H);
    y = 0;
    layout(D);

    cv.__logical = { w: PW, h: H };
    return cv;
  }

  function posterSize(D) {
    const probe = document.createElement('canvas');
    probe.width = 1; probe.height = 1;
    ctx = probe.getContext('2d');
    y = 0;
    layout(D);
    return { w: PW, h: Math.ceil(y) };
  }

  /* ---------- 单文件 HTML ---------- */
  function collectTheme() {
    const el = document.getElementById('wbTheme');
    return el ? el.textContent : '';
  }
  function collectRenderJs() {
    const el = document.getElementById('wbRenderJs');
    return el ? el.textContent : '';
  }

  function buildHtml(D, title) {
    const css = collectTheme();
    const js = collectRenderJs().replace(/<\/script>/gi, '<\\/script>');
    const m = D.meta || {};
    const t = title || (m.productName ? (m.productName + '期货数据看板') : '数据看板');
    const json = JSON.stringify(D).replace(/</g, '\\u003c');
    const stamp = m.generatedAt || m.date || '';
    return '<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n'
      + '<meta charset="utf-8"/>\n'
      + '<meta name="viewport" content="width=device-width, initial-scale=1"/>\n'
      + '<title>' + esc(t) + ' · ' + esc(m.date || '') + '</title>\n'
      + '<meta name="generator" content="Cu Dashboard Export"/>\n'
      + '<meta name="data-date" content="' + esc(m.date || '') + '"/>\n'
      + '<meta name="generated-at" content="' + esc(stamp) + '"/>\n'
      + '<style>\n' + css + '\n<\/style>\n'
      + '</head>\n<body>\n<div id="cuRoot"></div>\n'
      + '<script>' + js + '<\/script>\n'
      + '<script>\n(function(){\n'
      + '  var DATA = ' + json + ';\n'
      + '  function boot(){\n'
      + '    var root = document.getElementById("cuRoot");\n'
      + '    if (window.CuRender && CuRender.mount) CuRender.mount(root, DATA);\n'
      + '    else root.innerHTML = "<p style=\\"padding:40px;color:#7c8699\\">渲染脚本缺失，请重新导出。</p>";\n'
      + '  }\n'
      + '  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);\n'
      + '  else boot();\n'
      + '})();\n<\/script>\n'
      + '</body>\n</html>\n';
  }

  /* ---------- 下载 ---------- */
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename || 'download';
    document.body.appendChild(a); a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }
  function downloadText(text, filename) {
    downloadBlob(new Blob(['\ufeff', text], { type: 'text/html;charset=utf-8' }), filename);
  }

  function safeName(D, ext) {
    const m = D.meta || {};
    const base = (m.productName || '数据') + '期货数据看板';
    const d = (m.date || '').replace(/[^\d-]/g, '') || 'export';
    return base + '_' + d + (ext || '');
  }

  global.CuExport = {
    buildHtml: buildHtml,
    renderPoster: renderPoster,
    posterSize: posterSize,
    downloadBlob: downloadBlob,
    downloadText: downloadText,
    safeName: safeName,
    WIDTH: PW
  };
})(window);
