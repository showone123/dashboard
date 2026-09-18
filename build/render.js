/* ==========================================================================
   铜期货数据看板 · 渲染脚本 (Render Script)
   单一数据契约：见 build/copper_data.json
   用法：CuRender.mount(容器元素, DATA)
   配色遵循国内习惯：涨=红，跌=绿
   ========================================================================== */
(function (global) {
  'use strict';

  const UP = '#ff1744', UP2 = '#ff5252';     // 涨 → 红
  const DN = '#00c853', DN2 = '#1fe074';     // 跌 → 绿
  const GOLD = '#f0b90b', GOLD2 = '#ffd24a';

  const cssColor = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };
  const chartPalette = () => ({
    grid: cssColor('--chart-grid', 'rgba(255,255,255,.06)'),
    axis: cssColor('--chart-axis', '#7c8699'),
    plot: cssColor('--chart-plot-bg', 'rgba(0,0,0,.15)'),
    label: cssColor('--chart-label', '#d7dbe7'),
    point: cssColor('--chart-point-stroke', '#0a0e17'),
    zero: cssColor('--chart-zero', 'rgba(255,255,255,.20)'),
    accent: cssColor('--gold', GOLD),
    accent2: cssColor('--gold2', GOLD2),
    dim2: cssColor('--dim2', '#5b6478')
  });

  const nf = (n, d) => {
    if (n === null || n === undefined || n === '') return '—';
    const x = Number(n);
    if (!isFinite(x)) return String(n);
    return x.toLocaleString('zh-CN', { minimumFractionDigits: d || 0, maximumFractionDigits: d === undefined ? 0 : d });
  };
  const pct = (n, d) => (n > 0 ? '+' : '') + Number(n).toFixed(d === undefined ? 2 : d) + '%';
  const cls = d => (d === 'up' ? 'up' : d === 'down' ? 'down' : 'neu');

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ==================== 页面骨架 ==================== */
  function shell(D) {
    const m = D.meta, s = D.summary;
    const wd = (k) => 'p' + k;
    const nav = [
      ['p1', '📈', '行情总览'], ['p2', '📊', '多周期技术'], ['p3', '📐', '期限结构'],
      ['p4', '📦', '持仓与库存'], ['p5', '🔮', '期权分析'], ['p6', '🌐', '外盘与宏观'],
      ['p7', '📰', '舆情季节性'], ['p8', '💰', '交易成本'],
    ];
    const chgCls = s.chg >= 0 ? 'up' : 'down';
    return `
<header class="topbar">
  <div class="brand">
    <div class="logo-dot">Cu</div>
    <div>
      <div class="t">有色金属研究院<span class="sep">|</span>铜期货数据看板</div>
      <div class="sub">NONFERROUS METALS RESEARCH · CU FUTURES DASHBOARD</div>
    </div>
  </div>
  <div class="top-status">
    <div class="pill"><span class="dot"></span><span class="lbl">${esc(m.exchange)}</span><span class="ticker">${esc(m.contract)}</span></div>
    <div class="pill"><span class="lbl">收盘</span><span class="ticker ${chgCls}">${nf(s.close)}</span></div>
    <div class="pill"><span class="lbl">盘中</span><span class="ticker">${nf(D.tech && D.tech[0] ? D.tech[0].price : s.close)}</span></div>
    <div class="pill"><span class="lbl">数据日期</span><span class="ticker">${esc(m.date)}</span></div>
    <div class="clock" id="cuClock">--:--:--</div>
  </div>
</header>
<div class="layout">
  <aside class="side">
    <div class="group">研究视图</div>
    ${nav.slice(0, 7).map((n, i) => `<button class="nav-item${i === 0 ? ' active' : ''}" data-page="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}
    <div class="group">交易</div>
    ${nav.slice(7).map(n => `<button class="nav-item" data-page="${n[0]}"><span class="ic">${n[1]}</span>${n[2]}</button>`).join('')}
  </aside>
  <main class="main">
    <section class="page active" id="p1">${pageOverview(D)}</section>
    <section class="page" id="p2">${pageTech(D)}</section>
    <section class="page" id="p3">${pageTerm(D)}</section>
    <section class="page" id="p4">${pagePosition(D)}</section>
    <section class="page" id="p5">${pageOption(D)}</section>
    <section class="page" id="p6">${pageMacro(D)}</section>
    <section class="page" id="p7">${pageSentiment(D)}</section>
    <section class="page" id="p8">${pageCost(D)}</section>
    <footer class="bottom">
      <span>数据更新时间：${esc(m.generatedAt)} · 数据来源：${esc(m.source)} · 项目：${esc(m.project)}</span>
      <span class="foot-note">免责声明：${esc(m.disclaimer)}</span>
    </footer>
  </main>
</div>`;
  }

  /* ==================== P1 行情总览 ==================== */
  function pageOverview(D) {
    const m = D.meta, s = D.summary;
    const cl = s.chg >= 0 ? 'up' : 'down';
    return `
<div class="crumb">DASHBOARD / 行情总览</div>
<div class="page-head">
  <h2>行情总览<span class="tag">OVERVIEW</span></h2>
  <div class="meta">主力合约 ${esc(m.contract)} · ${D.kline.length}日K线 · 前复权连续合约 ${esc(m.continuous)}</div>
</div>
<div class="grid g12" style="margin-bottom:14px">
  <div class="card kpi glow gold col-2"><span class="lab">最新收盘</span><span class="val num">${nf(s.close)}</span><span class="xtra"><span class="${cl}">${s.chg >= 0 ? '+' : ''}${nf(s.chg)} / ${pct(s.chgPct)}</span></span></div>
  <div class="card kpi col-2"><span class="lab">MA5</span><span class="val num">${nf(s.ma5)}</span><span class="xtra">偏离 <span class="${s.ma5Diff >= 0 ? 'up' : 'down'}">${pct(s.ma5DiffPct)}</span></span></div>
  <div class="card kpi col-2"><span class="lab">MA20</span><span class="val num">${nf(s.ma20)}</span><span class="xtra">20日均线</span></div>
  <div class="card kpi col-2"><span class="lab">ATR(14)</span><span class="val num">${nf(s.atr, 1)}</span><span class="xtra">平均真实波幅</span></div>
  <div class="card kpi up col-2"><span class="lab">区间高</span><span class="val num">${nf(s.high60)}</span><span class="xtra">${D.kline.length}日上沿</span></div>
  <div class="card kpi down col-2"><span class="lab">区间低</span><span class="val num">${nf(s.low60)}</span><span class="xtra">${D.kline.length}日下沿</span></div>
</div>
<div class="card" style="padding:12px 14px 16px">
  <div class="ct">
    <div class="ttl">K线图 · 最近 ${D.kline.length} 交易日（蜡烛图 + 成交量 + 持仓量趋势）</div>
    <div class="legend">
      <span><i style="background:${UP2}"></i>收≥开</span>
      <span><i style="background:${DN2}"></i>收&lt;开</span>
      <span><i style="background:${GOLD2}"></i>持仓量</span>
    </div>
  </div>
  <div class="chart-wrap"><canvas class="cu-kline"></canvas></div>
  <div class="info-strip">
    <span>合约代码 <b>${esc(m.contract)}</b></span>
    <span>数据日期 <b>${esc(m.date)}</b></span>
    <span>数据源 <b>前复权连续合约 ${esc(m.continuous)}</b></span>
    <span>交易所 <b>${esc(m.exchange)}</b></span>
    <span>单位 <b>${esc(m.unit)}</b></span>
    <span>成交量 <b>${nf(s.volume)} 手</b></span>
    <span>持仓量 <b>${nf(s.openInterest)} 手（<span class="${s.oiChange >= 0 ? 'up' : 'down'}">${s.oiChange >= 0 ? '+' : ''}${nf(s.oiChange)}</span>）</b></span>
  </div>
  <div class="week-strip">
    <span>距 ${D.kline.length}日高点 <b class="down">${pct(s.fromHigh)}</b></span>
    <span>本周振幅 <b>${nf(s.weekHigh)} – ${nf(s.weekLow)}</b></span>
    <span>区间位置 <b>${nf((s.close - s.low60) / (s.high60 - s.low60) * 100, 1)}%</b></span>
  </div>
</div>`;
  }

  /* ==================== P2 多周期技术 ==================== */
  function pageTech(D) {
    const T = D.tech || [];
    if (!T.length) return empty('多周期技术', 'TECH');
    const reso = T.every(t => t.biasCls === 'up') ? ['up', '偏多']
      : T.every(t => t.biasCls === 'down') ? ['down', '偏空']
        : T.some(t => t.biasCls === 'down') ? ['neu', '中性偏空'] : ['neu', '中性偏多'];
    return `
<div class="crumb">DASHBOARD / 多周期技术分析</div>
<div class="page-head">
  <h2>多周期技术分析<span class="tag">MULTI-TF</span></h2>
  <div class="meta">${T.map(t => t.p).join(' / ')} 快照 · 快照时间 ${esc(D.meta.generatedAt)}</div>
</div>
<div class="summary-card">
  ${T.map(t => `<div class="sc-item"><div class="lab">${esc(t.p)} 偏向</div><div class="vv ${t.biasCls}">${esc(t.bias)}</div></div>`).join('')}
  <div class="sc-item reson"><div class="lab">三周期共振</div><div class="vv ${reso[0]}">${reso[1]}</div></div>
</div>
<div class="cols3">
${T.map(t => `
  <div class="period-col">
    <div class="ph"><span class="pf">${esc(t.p)}</span><span class="pp ${t.cls} num">${nf(t.price)}</span></div>
    <div class="tech-tags">${(t.tags || []).map(x => `<span class="badge ${x === '死叉' || x === '空头排列' ? 'b-red' : (x === '金叉' || x === '多头排列' ? 'b-green' : 'b-gray')}">${esc(x)}</span>`).join(' ')}</div>
    ${t.items.map(it => `<div class="ind"><span class="nm">${esc(it.n)}</span><span class="vl ${cls(it.d)}">${esc(it.v)}</span></div>`).join('')}
    <div class="ind bias-row"><span class="nm">综合偏向</span><span class="vl ${t.biasCls}">${esc(t.bias)}</span></div>
  </div>`).join('')}
</div>`;
  }

  /* ==================== P3 期限结构 ==================== */
  function pageTerm(D) {
    const C = D.contracts || [], tm = D.term || {};
    if (!C.length) return empty('期限结构与展期', 'TERM STRUCTURE');
    const mainCode = D.meta.contract;
    return `
<div class="crumb">DASHBOARD / 期限结构与展期</div>
<div class="page-head">
  <h2>期限结构与展期<span class="tag">TERM STRUCTURE</span></h2>
  <div class="meta">${esc(D.meta.exchange)} 铜期货各月合约 · ${esc(D.meta.date)} 收盘</div>
</div>
<div class="grid g12">
  <div class="card col-8">
    <div class="ct"><div class="ttl">期限结构曲线</div><span class="badge ${tm.structure === 'Backwardation' ? 'b-green' : 'b-gold'}">${esc(tm.structure)} · ${tm.structure === 'Backwardation' ? '近月升水' : '远月升水'}</span></div>
    <div class="cu-term"></div>
  </div>
  <div class="card col-4">
    <div class="ct"><div class="ttl">结构摘要</div></div>
    <div class="stat-row"><span class="k">结构类型</span><span class="v gl">${esc(tm.structure)}</span></div>
    <div class="stat-row"><span class="k">近月 (${esc(C[0].c)})</span><span class="v num">${nf(tm.near)}</span></div>
    <div class="stat-row"><span class="k">主力 (${esc(mainCode)})</span><span class="v num">${nf(tm.main)}</span></div>
    <div class="stat-row"><span class="k">远月 (${esc(C[C.length - 1].c)})</span><span class="v num">${nf(tm.far)}</span></div>
    <div class="stat-row"><span class="k">近远月价差</span><span class="v num ${tm.nearFarSpread >= 0 ? 'up' : 'down'}">${tm.nearFarSpread >= 0 ? '+' : ''}${nf(tm.nearFarSpread)}</span></div>
    <div class="stat-row"><span class="k">主力-次主力</span><span class="v num ${tm.mainSubSpread >= 0 ? 'up' : 'down'}">${tm.mainSubSpread >= 0 ? '+' : ''}${nf(tm.mainSubSpread)}</span></div>
    <div class="stat-row"><span class="k">活跃合约数</span><span class="v num">${C.length}</span></div>
  </div>
  <div class="card col-6">
    <div class="ct"><div class="ttl">展期收益</div></div>
    <table>
      <thead><tr><th class="l">组合</th><th>价差</th><th>年化</th><th>结构</th></tr></thead>
      <tbody>${(tm.roll || []).map(r => `<tr><td class="l">${esc(r.name)}</td><td class="num">${r.spread >= 0 ? '+' : ''}${nf(r.spread)}</td><td class="num ${r.annual >= 0 ? 'up' : 'down'}">${r.annual >= 0 ? '+' : ''}${Number(r.annual).toFixed(2)}%</td><td><span class="badge ${r.spread >= 0 ? 'b-green' : 'b-red'}">${r.spread >= 0 ? 'Backwardation' : 'Contango'}</span></td></tr>`).join('')}</tbody>
    </table>
    <div class="note-line"><span class="neu">信号：</span>${esc(tm.note || '')}</div>
  </div>
  <div class="card col-6">
    <div class="ct"><div class="ttl">各合约明细</div><span class="sub">单位：手</span></div>
    <div class="scroll-y"><table>
      <thead><tr><th class="l">合约</th><th>收盘价</th><th>结算价</th><th>成交量</th><th>持仓量</th></tr></thead>
      <tbody>${C.map(c => `<tr${c.c === mainCode ? ' class="row-hl"' : ''}><td class="l"><b class="${c.c === mainCode ? 'gl' : ''}">${esc(c.c)}</b>${c.c === mainCode ? ' <span class="badge b-gold">主力</span>' : ''}</td><td class="num">${nf(c.p)}</td><td class="num">${nf(c.set)}</td><td class="num">${nf(c.vol)}</td><td class="num">${nf(c.oi)}</td></tr>`).join('')}</tbody>
    </table></div>
  </div>
</div>`;
  }

  /* ==================== P4 持仓与库存 ==================== */
  function pagePosition(D) {
    const r = D.rank || {}, w = D.warehouse || {};
    const t20 = r.top20 || {};
    const netCls = r.netLongShort >= 0 ? 'up' : 'down';
    return `
<div class="crumb">DASHBOARD / 持仓与库存</div>
<div class="page-head">
  <h2>持仓与库存<span class="tag">POSITION</span></h2>
  <div class="meta">前20会员排名 · 仓单 · ${esc(D.meta.date)}</div>
</div>
<div class="grid g12" style="margin-bottom:14px">
  <div class="card kpi glow col-4"><span class="lab">前20 净多-净空差</span><span class="val num ${netCls}">${r.netLongShort >= 0 ? '+' : ''}${nf(r.netLongShort)}</span><span class="xtra">多头 ${nf(t20.long)} / 空头 ${nf(t20.short)} → <span class="${netCls}">${esc(r.signal || '')}</span></span></div>
  <div class="card kpi gold col-4"><span class="lab">最新仓单</span><span class="val num">${nf(w.stocks)} 吨</span><span class="xtra">变化 <span class="${w.change >= 0 ? 'up' : 'down'}">${w.change >= 0 ? '+' : ''}${nf(w.change)} 吨</span></span></div>
  <div class="card kpi col-4"><span class="lab">前20 多空变化</span><span class="val num" style="font-size:17px"><span class="down">多 ${nf(t20.longChange)}</span> / <span class="down">空 ${nf(t20.shortChange)}</span></span><span class="xtra">双边减仓，资金离场</span></div>
</div>
<div class="card signal-card" style="margin-bottom:14px">
  <span class="gl">仓单信号：</span>${esc(w.note || '')}
</div>
<div class="card" style="margin-bottom:14px">
  <div class="ct"><div class="ttl">前20名会员持仓排名 Top10 明细</div><span class="sub">单位：手 · 括号内为较上日变化</span></div>
  <div class="scroll-x"><table class="rank-table">
    <thead><tr><th class="l">#</th><th class="l">成交量排名</th><th>交易量</th><th>变化</th><th class="l">多头Top10</th><th>多持仓</th><th>变化</th><th class="l">空头Top10</th><th>空持仓</th><th>变化</th></tr></thead>
    <tbody>${Array.from({ length: 10 }, (_, i) => {
      const v = (r.volume || [])[i] || {}, l = (r.long || [])[i] || {}, s = (r.short || [])[i] || {};
      const ch = c => c === undefined ? '' : `<span class="${c >= 0 ? 'up' : 'down'}">${c >= 0 ? '+' : ''}${nf(c)}</span>`;
      return `<tr><td class="l">${i + 1}</td><td class="l">${esc(v.name)}</td><td class="num">${nf(v.value)}</td><td class="num">${ch(v.change)}</td><td class="l">${esc(l.name)}</td><td class="num">${nf(l.value)}</td><td class="num">${ch(l.change)}</td><td class="l">${esc(s.name)}</td><td class="num">${nf(s.value)}</td><td class="num">${ch(s.change)}</td></tr>`;
    }).join('')}</tbody>
  </table></div>
</div>
${(D.inventory || []).length ? `<div class="card">
  <div class="ct"><div class="ttl">库存参考（现货 / 内外盘）</div><span class="sub">来源：ETA 基本面指标库</span></div>
  <table><thead><tr><th class="l">指标</th><th>数值</th><th>单位</th><th>截止日期</th><th class="l">备注</th></tr></thead>
  <tbody>${D.inventory.map(i => `<tr><td class="l">${esc(i.name)}</td><td class="num gl">${esc(i.value)}</td><td class="neu">${esc(i.unit)}</td><td class="dim2">${esc(i.asOf)}</td><td class="l dim">${esc(i.note)}</td></tr>`).join('')}</tbody></table>
</div>` : ''}`;
  }

  /* ==================== P5 期权分析 ==================== */
  function pageOption(D) {
    const o = D.options;
    if (!o) return empty('期权分析', 'OPTIONS');
    const pcrPos = Math.max(0, Math.min(100, (o.pcrOi - 0.4) / (1.6 - 0.4) * 100));
    return `
<div class="crumb">DASHBOARD / 期权分析</div>
<div class="page-head">
  <h2>期权分析<span class="tag">OPTIONS</span></h2>
  <div class="meta">${esc(o.contract)} 期权 · ATM ${nf(o.atmStrike)} · 标的期货 ${nf(o.futuresPrice)} · ${esc(o.date)}</div>
</div>
<div class="grid g12" style="margin-bottom:14px">
  <div class="card kpi glow gold col-3"><span class="lab">ATM 行权价</span><span class="val num">${nf(o.atmStrike)}</span></div>
  <div class="card kpi up col-3"><span class="lab">Call 价格</span><span class="val num">${nf(o.callPrice)}</span><span class="xtra">Delta ${o.callDelta}</span></div>
  <div class="card kpi down col-3"><span class="lab">Put 价格</span><span class="val num">${nf(o.putPrice)}</span><span class="xtra">隐含看跌成本</span></div>
  <div class="card kpi col-3"><span class="lab">Max Pain</span><span class="val num gl">${nf(o.maxPain)}</span><span class="xtra">最大痛点行权价</span></div>
</div>
<div class="grid g12">
  <div class="card col-6">
    <div class="ct"><div class="ttl">波动率分析</div></div>
    <div class="stat-row"><span class="k">HV20（20日历史波动率）</span><span class="v num ${o.hv20 > o.hv60 ? 'up' : 'down'}">${o.hv20}%</span></div>
    <div class="stat-row"><span class="k">HV60（60日历史波动率）</span><span class="v num">${o.hv60}%</span></div>
    <div class="stat-row"><span class="k">短期 vs 长期</span><span class="v neu">${o.hv20 > o.hv60 ? 'HV20 &gt; HV60（波动率抬升）' : 'HV20 &lt; HV60（短期收敛）'}</span></div>
    <div class="note-line dim">${esc(o.volNote || '')}</div>
  </div>
  <div class="card col-6">
    <div class="ct"><div class="ttl">PCR 指标</div></div>
    <div class="stat-row"><span class="k">PCR (OI 持仓量)</span><span class="v num">${o.pcrOi}</span></div>
    <div class="stat-row"><span class="k">PCR (Vol 成交量)</span><span class="v num">${o.pcrVolume}</span></div>
    <div class="stat-row"><span class="k">总 Call OI / 总 Put OI</span><span class="v num">${nf(o.totalCallOi)} / ${nf(o.totalPutOi)}</span></div>
    <div class="stat-row"><span class="k">信号</span><span class="v neu">${esc(o.pcrSignal)}</span></div>
    <div class="sig-bar"><i style="width:${pcrPos}%"></i></div>
    <div class="legend"><span>偏空 0.4 ─ 0.7</span><span>中性 0.7–1.3</span><span>偏多 1.3+</span></div>
  </div>
  <div class="card col-12">
    <div class="ct"><div class="ttl">套保策略建议</div><span class="sub">基于 ${esc(o.contract)} 期权链</span></div>
    <div class="grid g12" style="margin:0">
      ${o.strategies.map((st, i) => `<div class="col-6 strat-box ${i === 1 ? 'strat-gold' : ''}">
        <div class="strat-title"><span class="${st.cls}">${esc(st.name)}</span></div>
        ${st.rows.map(rw => `<div class="stat-row"><span class="k">${esc(rw[0])}</span><span class="v">${esc(rw[1])}</span></div>`).join('')}
      </div>`).join('')}
    </div>
  </div>
  <div class="card col-12">
    <div class="ct"><div class="ttl">期权链（ATM 附近）</div><span class="sub">结算价 / 成交量 / 持仓量 / Delta</span></div>
    <table><thead><tr>
      <th class="l">行权价</th><th>Call 结算</th><th>Call 量</th><th>Call 持仓</th><th>Call Δ</th>
      <th>Put 结算</th><th>Put 量</th><th>Put 持仓</th><th>Put Δ</th>
    </tr></thead><tbody>${o.chain.map(c => `<tr${c.atm ? ' class="row-hl"' : ''}>
      <td class="l"><b class="${c.atm ? 'gl' : ''}">${nf(c.k)}</b>${c.atm ? ' <span class="badge b-gold">ATM</span>' : ''}</td>
      <td class="num up">${nf(c.cp)}</td><td class="num">${nf(c.cv)}</td><td class="num">${nf(c.co)}</td><td class="num up">${Number(c.cd).toFixed(4)}</td>
      <td class="num down">${nf(c.pp)}</td><td class="num">${nf(c.pv)}</td><td class="num">${nf(c.po)}</td><td class="num down">${Number(c.pd).toFixed(4)}</td>
    </tr>`).join('')}</tbody></table>
  </div>
</div>`;
  }

  /* ==================== P6 外盘与宏观 ==================== */
  function pageMacro(D) {
    const e = D.external || {};
    return `
<div class="crumb">DASHBOARD / 外盘与宏观比价</div>
<div class="page-head">
  <h2>外盘与宏观比价<span class="tag">MACRO</span></h2>
  <div class="meta">${esc(e.name || '外盘')} · 跨品种比价（10年分位）</div>
</div>
<div class="grid g12" style="margin-bottom:14px">
  <div class="card kpi glow gold col-4"><span class="lab">${esc(e.name || '外盘')} 最新</span><span class="val num">${e.close}</span><span class="xtra">美元/磅 · MA5 ${e.ma5} / MA20 ${e.ma20}</span></div>
  <div class="card kpi ${e.chg1d >= 0 ? 'up' : 'down'} col-4"><span class="lab">1日涨跌</span><span class="val num">${pct(e.chg1d)}</span></div>
  <div class="card kpi ${e.chg5d >= 0 ? 'up' : 'down'} col-4"><span class="lab">5日涨跌</span><span class="val num">${pct(e.chg5d)}</span></div>
</div>
<div class="grid g12">
  <div class="card col-8">
    <div class="ct"><div class="ttl">宏观比价表（与铜相关）</div></div>
    <table><thead><tr><th class="l">比价</th><th>当前值</th><th>10年分位</th><th class="l">信号</th></tr></thead>
    <tbody>${(D.ratios || []).map(r => `<tr><td class="l">${esc(r.n)}</td><td class="num">${esc(r.v)}</td><td class="num gl">${esc(r.pct)}</td><td class="l"><span class="${r.d}">${esc(r.sig)}</span></td></tr>`).join('')}</tbody></table>
  </div>
  <div class="card col-4">
    <div class="ct"><div class="ttl">30日趋势 Mini</div><span class="sub">铜银比 / 金银比</span></div>
    <div class="cu-mini"></div>
  </div>
</div>`;
  }

  /* ==================== P7 舆情与季节性 ==================== */
  function pageSentiment(D) {
    const sn = D.sentiment;
    if (!sn) return empty('舆情与季节性', 'SENTIMENT');
    return `
<div class="crumb">DASHBOARD / 舆情与季节性</div>
<div class="page-head">
  <h2>舆情与季节性<span class="tag">SENTIMENT</span></h2>
  <div class="meta">多窗口舆情打分 · 月度季节性 · 分析时间 ${esc(sn.snapshot)}</div>
</div>
<div class="grid g12">
  <div class="card col-8">
    <div class="ct"><div class="ttl">舆情信号（多时间窗口）</div><span class="sub">48h 内 ${nf(sn.total48h)} 条 · 高影响力 ${nf(sn.alertCount)} 条</span></div>
    <div class="grid g12" style="margin:0">
      ${sn.windows.map(wd => `<div class="col-3 stat-box"><div class="stat-row"><span class="k">${esc(wd.label)}</span><span class="v ${wd.score > 0.05 ? 'up' : wd.score < -0.05 ? 'down' : 'neu'}">${esc(wd.verdict)} ${wd.score >= 0 ? '+' : ''}${Number(wd.score).toFixed(3)}</span></div><div class="stat-row"><span class="k">条数</span><span class="v num">${nf(wd.count)}</span></div></div>`).join('')}
    </div>
    <div class="note-box">
      <span class="gl">动量方向：</span><b>${esc(sn.momentum)}</b>
      <span class="dim">（${esc(sn.shift)}）</span>
    </div>
    <div class="note-line dim">${esc(sn.macroNote || '')}</div>
  </div>
  <div class="card col-4">
    <div class="ct"><div class="ttl">关键舆情事件 Top5</div></div>
    <div>${(sn.events || []).map(ev => `
      <div class="ev-item">
        <div class="ev-score ${ev.sc >= 0 ? 'up' : 'down'}">${ev.sc >= 0 ? '+' : ''}${Number(ev.sc).toFixed(2)}</div>
        <div class="ev-body"><div><span class="ev-tag">${esc(ev.tag)}</span><span class="ev-txt">${esc(ev.txt)}</span></div><div class="ev-time">${esc(ev.time)}</div></div>
      </div>`).join('')}</div>
  </div>
  <div class="card col-12">
    <div class="ct"><div class="ttl">季节性：月度平均收益率与胜率</div><span class="sub">近9年样本 · 当前月高亮</span></div>
    <div class="cu-season"></div>
  </div>
</div>`;
  }

  /* ==================== P8 交易成本 ==================== */
  function pageCost(D) {
    const c = D.cost;
    if (!c) return empty('交易成本', 'COST');
    return `
<div class="crumb">DASHBOARD / 交易成本</div>
<div class="page-head">
  <h2>交易成本<span class="tag">COST</span></h2>
  <div class="meta">${esc(D.meta.contract)} · 按收盘价 ${nf(c.price)} 计算</div>
</div>
<div class="grid g12">
  <div class="card col-6">
    <div class="ct"><div class="ttl">手续费（公司费率）</div></div>
    <div class="stat-row"><span class="k">开仓</span><span class="v num">${c.openFee} 元/手</span></div>
    <div class="stat-row"><span class="k">平仓</span><span class="v num">${c.closeFee} 元/手</span></div>
    <div class="stat-row"><span class="k">平今</span><span class="v num">${c.closeTodayFee} 元/手</span></div>
    <div class="stat-row"><span class="k">单边费率</span><span class="v num">${c.commissionRate.toFixed(6)}%</span></div>
    <div class="stat-row"><span class="k">交易所费率（投机）</span><span class="v num">${c.exRate.toFixed(4)}% · ${c.exOpen} 元/手</span></div>
    <div class="stat-row"><span class="k">公司 / 交易所倍数</span><span class="v num">${(c.commissionRate / c.exRate).toFixed(2)} 倍</span></div>
  </div>
  <div class="card col-6">
    <div class="ct"><div class="ttl">保证金</div></div>
    <div class="stat-row"><span class="k">多空保证金率</span><span class="v num">${c.marginRate}%</span></div>
    <div class="stat-row"><span class="k">1手保证金</span><span class="v num gl">${nf(c.marginPerLot, 1)} 元</span></div>
    <div class="stat-row"><span class="k">合约乘数</span><span class="v num">${c.volumeMultiple} 吨/手</span></div>
    <div class="stat-row"><span class="k">最小变动价位</span><span class="v num">${c.priceTick} 元/吨（= ${c.priceTick * c.volumeMultiple} 元/手）</span></div>
    <div class="stat-row"><span class="k">保证金模型</span><span class="v num">${esc(c.marginModel)}</span></div>
  </div>
  <div class="card col-12 glow" style="border-left:3px solid ${GOLD}">
    <div class="ttl" style="font-size:11px;color:var(--dim);letter-spacing:1px">成本估算（按1手 @${nf(c.price)}，非平今）</div>
    <div class="cost-big gl">${c.roundTrip} <span class="cost-unit">元（开+平总手续费）</span></div>
    <div class="cost-sub">开仓 ${c.openFee} + 平仓 ${c.closeFee} = ${c.roundTrip} 元 · 交易所成本 ${c.exRoundTrip} 元 · 折合 ${(c.roundTrip / (c.priceTick * c.volumeMultiple)).toFixed(2)} 个最小变动价位 · 不含保证金资金成本</div>
  </div>
</div>`;
  }

  function empty(title, tag) {
    return `<div class="crumb">DASHBOARD / ${title}</div>
<div class="page-head"><h2>${title}<span class="tag">${tag}</span></h2></div>
<div class="card empty-card">该模块缺少对应数据表。请在上传的 Excel 中补齐后重试。</div>`;
  }

  /* ==================== 图表：K线 ==================== */
  function drawKLine(cv, D) {
    if (!cv) return;
    const bars = D.kline, n = bars.length;
    if (!n) return;
    const wrap = cv.parentElement, dpr = window.devicePixelRatio || 1;
    const W = Math.max(320, wrap.clientWidth - 4), H = 430;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = W + 'px'; cv.style.height = H + 'px';
    const ctx = cv.getContext('2d'), P = chartPalette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, W, H);

    const padL = 10, padR = 62, padT = 10, padB = 26;
    const plotW = W - padL - padR;
    const priceTop = padT;
    const priceBot = padT + Math.round((H - padT - padB) * 0.60);
    const volTop = priceBot + 10, volBot = H - padB;
    const step = plotW / n, cw = Math.max(2, step * 0.62);

    let minP = Infinity, maxP = -Infinity, maxV = 0, minOI = Infinity, maxOI = -Infinity;
    bars.forEach(b => {
      minP = Math.min(minP, b.l); maxP = Math.max(maxP, b.h);
      maxV = Math.max(maxV, b.v);
      minOI = Math.min(minOI, b.oi); maxOI = Math.max(maxOI, b.oi);
    });
    const rp = (maxP - minP) * 0.06; minP -= rp; maxP += rp;
    const yP = p => priceBot - (p - minP) / (maxP - minP) * (priceBot - priceTop);
    const yV = v => volBot - (v / maxV) * (volBot - volTop);
    const yOI = oi => volBot - (oi - minOI) / (maxOI - minOI || 1) * (volBot - volTop);

    ctx.strokeStyle = P.grid; ctx.lineWidth = 1;
    ctx.fillStyle = P.axis; ctx.font = '10px monospace'; ctx.textAlign = 'left';
    for (let i = 0; i <= 5; i++) {
      const y = priceTop + (priceBot - priceTop) * i / 5;
      const p = maxP - (maxP - minP) * i / 5;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(W - padR, y); ctx.stroke();
      ctx.fillText(Math.round(p).toLocaleString(), W - padR + 5, y + 3);
    }
    ctx.fillStyle = P.plot; ctx.fillRect(padL, volTop, plotW, volBot - volTop);
    ctx.strokeStyle = P.grid;
    ctx.beginPath(); ctx.moveTo(padL, volTop); ctx.lineTo(W - padR, volTop); ctx.stroke();

    bars.forEach((b, i) => {
      const x = padL + (i + 0.5) * step;
      const up = b.c >= b.o;
      const col = up ? UP : DN;
      ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, Math.round(yP(b.h))); ctx.lineTo(x, Math.round(yP(b.l))); ctx.stroke();
      const yo = yP(b.o), yc = yP(b.c);
      const top = Math.min(yo, yc), hh = Math.max(1, Math.abs(yc - yo));
      ctx.fillRect(Math.round(x - cw / 2), Math.round(top), Math.max(1, Math.round(cw)), Math.round(hh));
      ctx.globalAlpha = 0.5;
      ctx.fillRect(Math.round(x - cw / 2), Math.round(yV(b.v)), Math.max(1, Math.round(cw)), Math.round(volBot - yV(b.v)));
      ctx.globalAlpha = 1;
    });

    ctx.strokeStyle = P.accent; ctx.lineWidth = 1.4; ctx.beginPath();
    bars.forEach((b, i) => {
      const x = padL + (i + 0.5) * step, y = yOI(b.oi);
      i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.fillStyle = P.accent; ctx.font = '10px monospace';
    ctx.fillText('─ 持仓量 OI', padL + 4, volTop + 12);
    ctx.fillText(Math.round(maxOI).toLocaleString(), W - padR + 5, volTop + 12);
    ctx.fillText(Math.round(minOI).toLocaleString(), W - padR + 5, volBot - 2);

    ctx.fillStyle = P.dim2; ctx.textAlign = 'center';
    const idx = [];
    const stride = Math.max(1, Math.floor(n / 7));
    for (let i = n - 1; i >= 0 && idx.length < 7; i -= stride) idx.push(i);
    idx.forEach(i => { const b = bars[i]; if (b.d) ctx.fillText(b.d, padL + (i + 0.5) * step, volBot + 14); });

    const last = bars[n - 1], yl = yP(last.c);
    ctx.strokeStyle = P.accent; ctx.globalAlpha = .5; ctx.setLineDash([3, 3]);
    ctx.beginPath(); ctx.moveTo(padL, yl); ctx.lineTo(W - padR, yl); ctx.stroke(); ctx.setLineDash([]);
    ctx.globalAlpha = 1; ctx.fillStyle = P.accent; ctx.fillRect(W - padR, yl - 8, padR, 16);
    ctx.fillStyle = P.point; ctx.font = 'bold 10px monospace'; ctx.textAlign = 'center';
    ctx.fillText(last.c.toLocaleString(), W - padR / 2, yl + 3);
    ctx.textAlign = 'left';
  }

  /* ==================== 图表：期限结构 ==================== */
  function drawTerm(host, D) {
    if (!host || host.dataset.built) return;
    const C = D.contracts || [], P = chartPalette();
    if (C.length < 2) { host.innerHTML = '<div class="dim" style="padding:20px">合约数据不足</div>'; host.dataset.built = 1; return; }
    const ps = C.map(c => c.p), mn = Math.min(...ps), mx = Math.max(...ps);
    const W = 820, H = 300, padL = 60, padR = 20, padT = 24, padB = 44;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const x = i => padL + (i + 0.5) * plotW / C.length;
    const y = p => padT + plotH - (p - mn) / (mx - mn || 1) * plotH;
    let g = '';
    for (let i = 0; i <= 4; i++) {
      const yy = padT + plotH * i / 4, val = mx - (mx - mn) * i / 4;
      g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${P.grid}"/><text x="${padL - 6}" y="${yy + 3}" fill="${P.axis}" font-size="10" text-anchor="end">${Math.round(val).toLocaleString()}</text>`;
    }
    const area = `<polygon points="${padL},${padT + plotH} ` + C.map((c, i) => `${x(i)},${y(c.p)}`).join(' ') + ` ${x(C.length - 1)},${padT + plotH}" fill="${P.accent}" opacity=".07"/>`;
    const line = `<polyline points="` + C.map((c, i) => `${x(i)},${y(c.p)}`).join(' ') + `" fill="none" stroke="${P.accent}" stroke-width="2"/>`;
    const pts = C.map((c, i) => {
      const isMain = c.c === D.meta.contract;
      const showLabel = C.length <= 8 || i % 2 === 0 || isMain;
      return `<circle cx="${x(i)}" cy="${y(c.p)}" r="${isMain ? 5 : 3}" fill="${isMain ? P.accent : '#3d7fff'}" stroke="${P.point}" stroke-width="1"/>` +
        (showLabel ? `<text x="${x(i)}" y="${y(c.p) - 10}" fill="${isMain ? P.accent2 : P.label}" font-size="10" text-anchor="middle">${c.p.toLocaleString()}</text>` : '') +
        `<text x="${x(i)}" y="${H - padB + 16}" fill="${isMain ? P.accent : P.axis}" font-size="10" text-anchor="middle">${c.c}</text>`;
    }).join('');
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}${area}${line}${pts}</svg>`;
    host.dataset.built = 1;
  }

  /* ==================== 图表：30日 Mini ==================== */
  function drawMini(host, D) {
    if (!host || host.dataset.built) return;
    const t = D.trend || {};
    const mk = (name, color, arr) => {
      if (!arr || arr.length < 2) return '';
      const mn = Math.min(...arr), mx = Math.max(...arr), W = 300, H = 70, pad = 4;
      const x = i => pad + (i / (arr.length - 1)) * (W - 2 * pad);
      const y = v => H - pad - (v - mn) / (mx - mn || 1) * (H - 2 * pad);
      const pl = arr.map((v, i) => `${x(i)},${y(v)}`).join(' ');
      const last = arr[arr.length - 1], first = arr[0];
      const chg = ((last / first - 1) * 100).toFixed(2);
      const c = last >= first ? UP2 : DN2;
      return `<div class="mini-wrap"><div class="mini-label">${esc(name)} · 最新 ${last} <span style="color:${c}">(${last >= first ? '+' : ''}${chg}%)</span></div><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none"><polyline points="${pl}" fill="none" stroke="${color}" stroke-width="1.5"/></svg></div>`;
    };
    host.innerHTML = mk('铜银比 (30日)', GOLD, t.cuag) + mk('金银比 (30日)', '#26c6da', t.auag);
    host.dataset.built = 1;
  }

  /* ==================== 图表：季节性 ==================== */
  function drawSeason(host, D) {
    if (!host || host.dataset.built) return;
    const S = D.season || [], P = chartPalette();
    if (!S.length) { host.innerHTML = '<div class="dim" style="padding:20px">季节性数据缺失</div>'; host.dataset.built = 1; return; }
    const curMonth = new Date().getMonth() + 1;
    const W = 820, H = 290, padL = 46, padR = 10, padT = 20, padB = 50;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxAbs = Math.max(...S.map(s => Math.abs(s.r))) || 1;
    const zeroY = padT + plotH / 2;
    const bw = plotW / S.length * 0.55;
    let g = `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${P.zero}"/>`;
    for (let i = -2; i <= 2; i++) {
      if (i === 0) continue;
      const yy = zeroY - (i * plotH / 4 / 2);
      g += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${P.grid}"/>`;
    }
    g += `<text x="${padL - 6}" y="${zeroY + 3}" fill="${P.axis}" font-size="10" text-anchor="end">0%</text>`;
    g += `<text x="${padL - 6}" y="${padT + 8}" fill="${P.axis}" font-size="10" text-anchor="end">+${maxAbs.toFixed(1)}%</text>`;
    g += `<text x="${padL - 6}" y="${padT + plotH - 2}" fill="${P.axis}" font-size="10" text-anchor="end">-${maxAbs.toFixed(1)}%</text>`;
    S.forEach((s, i) => {
      const cx = padL + (i + 0.5) * plotW / S.length;
      const bh = (Math.abs(s.r) / maxAbs) * (plotH / 2);
      const by = s.r >= 0 ? zeroY - bh : zeroY;
      const col = s.r >= 0 ? UP : DN;
      const mon = parseInt(s.m, 10);
      const cur = mon === curMonth;
      g += `<rect x="${cx - bw / 2}" y="${by}" width="${bw}" height="${Math.max(1, bh)}" fill="${col}" opacity="${cur ? 1 : 0.65}" stroke="${cur ? P.accent2 : 'none'}" stroke-width="2"/>`;
      g += `<text x="${cx}" y="${s.r >= 0 ? by - 5 : by + bh + 12}" fill="${col}" font-size="10" text-anchor="middle" font-weight="${cur ? 'bold' : 'normal'}">${s.r > 0 ? '+' : ''}${Number(s.r).toFixed(2)}%</text>`;
      g += `<text x="${cx}" y="${H - padB + 14}" fill="${cur ? P.accent2 : P.axis}" font-size="11" text-anchor="middle" font-weight="${cur ? 'bold' : 'normal'}">${esc(s.m)}</text>`;
      g += `<text x="${cx}" y="${H - padB + 28}" fill="${P.dim2}" font-size="9" text-anchor="middle">胜率${Math.round(s.w)}%</text>`;
    });
    host.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet">${g}</svg>`;
    host.dataset.built = 1;
  }

  /* ==================== 挂载 ==================== */
  function mount(root, D) {
    if (!root) return;
    if (!D || !D.kline || !D.kline.length) {
      root.innerHTML = '<div class="card empty-card" style="margin:24px">没有可用数据。请先上传数据文件。</div>';
      return;
    }
    root.innerHTML = shell(D);

    const nav = root.querySelectorAll('.nav-item');
    nav.forEach(b => b.addEventListener('click', () => {
      nav.forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      root.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
      const pg = root.querySelector('#' + b.dataset.page);
      if (pg) pg.classList.add('active');
      if (b.dataset.page === 'p1') drawKLine(root.querySelector('.cu-kline'), D);
      if (b.dataset.page === 'p3') drawTerm(root.querySelector('.cu-term'), D);
      if (b.dataset.page === 'p6') drawMini(root.querySelector('.cu-mini'), D);
      if (b.dataset.page === 'p7') drawSeason(root.querySelector('.cu-season'), D);
    }));

    // 时钟
    const clock = root.querySelector('#cuClock');
    if (clock) {
      const tick = () => {
        const d = new Date(), z = n => String(n).padStart(2, '0');
        clock.textContent = z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
      };
      tick();
      if (root.__cuTimer) clearInterval(root.__cuTimer);
      root.__cuTimer = setInterval(tick, 1000);
    }

    const redraw = () => {
      const a = root.querySelector('.page.active');
      if (!a) return;
      if (a.id === 'p1') drawKLine(root.querySelector('.cu-kline'), D);
    };
    if (root.__cuResize) window.removeEventListener('resize', root.__cuResize);
    root.__cuResize = redraw;
    window.addEventListener('resize', redraw);

    drawKLine(root.querySelector('.cu-kline'), D);
    drawTerm(root.querySelector('.cu-term'), D);
    drawMini(root.querySelector('.cu-mini'), D);
    drawSeason(root.querySelector('.cu-season'), D);
  }

  global.CuRender = { mount: mount, drawKLine: drawKLine, drawTerm: drawTerm, drawMini: drawMini, drawSeason: drawSeason };
})(window);
