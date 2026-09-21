(function () {
  'use strict';
  var root, user, codes, timer, active = false;
  var defaults = ['600519.SH', '000001.SZ', '300750.SZ'];
  function storeKey() { return 'fluxdesk_stocks_v1:' + user; }
  function save() { localStorage.setItem(storeKey(), JSON.stringify(codes)); }
  function load() {
    try { var value = JSON.parse(localStorage.getItem(storeKey()));
      return Array.isArray(value) ? value.filter(function (c) { return /^[0-9]{6}\.(SH|SZ|BJ)$/.test(c); }).slice(0, 10) : defaults.slice();
    } catch (e) { return defaults.slice(); }
  }
  function cell(row, value) { var td = document.createElement('td'); td.textContent = value == null ? '—' : String(value); row.appendChild(td); return td; }
  function number(v, digits) { return typeof v === 'number' ? v.toLocaleString('zh-CN', {maximumFractionDigits: digits}) : '—'; }
  function draw(items) {
    var body = root.querySelector('tbody'); body.replaceChildren();
    codes.forEach(function (code) {
      var item = items.find(function (x) { return x.thscode === code; }) || {};
      var row = document.createElement('tr');
      cell(row, code); cell(row, item.name || '—'); cell(row, number(item.last_price, 2));
      var change = cell(row, number(item.price_change, 2));
      var pct = cell(row, item.price_change_ratio_pct == null ? '—' : number(item.price_change_ratio_pct, 2) + '%');
      [change, pct].forEach(function (el) { el.className = item.price_change > 0 ? 'stock-up' : item.price_change < 0 ? 'stock-down' : ''; });
      cell(row, number(item.volume, 0)); cell(row, number(item.turnover, 0));
      var action = document.createElement('td'), button = document.createElement('button');
      button.type = 'button'; button.className = 'btn'; button.textContent = '移除';
      button.onclick = function () { codes = codes.filter(function (c) { return c !== code; }); save(); refresh(); };
      action.appendChild(button); row.appendChild(action); body.appendChild(row);
    });
  }
  async function refresh() {
    if (!active) return;
    if (!codes.length) { draw([]); root.querySelector('[data-stock-status]').textContent = '请输入完整股票代码添加自选股。'; return; }
    try {
      var response = await fetch('/api/stocks?codes=' + encodeURIComponent(codes.join(',')), {cache:'no-store', headers:{'X-FluxDesk-Request':'1'}});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      if (!active) return;
      draw(data.items || []);
      var stamp = data.items && data.items[0] && data.items[0].timestamp;
      root.querySelector('[data-stock-status]').textContent = '行情时间：' + (stamp ? new Date(stamp).toLocaleString('zh-CN', {hour12:false}) : '暂无数据') + ' · 每30秒检查更新';
    } catch (e) { if (active) root.querySelector('[data-stock-status]').textContent = '行情暂不可用，保留上次显示的数据。'; }
  }
  function open(node, userId) {
    close(); root = node; user = userId; active = true; codes = load();
    root.innerHTML = '<div class="stock-heading"><div><small>STOCK WORKSPACE</small><h1>股票工作台</h1><p>A 股自选行情快照</p></div><button class="btn primary" type="button" data-stock-refresh>刷新</button></div>' +
      '<form class="stock-form"><label for="stock-code">完整代码</label><input id="stock-code" placeholder="例如 600519.SH" maxlength="9" autocomplete="off"><button class="btn" type="submit">加入自选</button></form>' +
      '<p class="stock-status" data-stock-status aria-live="polite">正在加载…</p><div class="stock-table-wrap"><table class="tbl"><thead><tr><th>代码</th><th>名称</th><th>最新价</th><th>涨跌</th><th>涨跌幅</th><th>成交量</th><th>成交额</th><th>操作</th></tr></thead><tbody></tbody></table></div>' +
      '<p class="stock-note">数据来源：同花顺金融数据服务。行情快照可能延迟，非逐笔实时数据。</p><section class="finance-explorer" data-finance-root></section>';
    root.querySelector('form').onsubmit = function (event) {
      event.preventDefault(); var input = root.querySelector('input'), code = input.value.trim().toUpperCase();
      if (!/^[0-9]{6}\.(SH|SZ|BJ)$/.test(code)) { root.querySelector('[data-stock-status]').textContent = '请输入完整代码，例如 600519.SH。'; return; }
      if (codes.indexOf(code) < 0 && codes.length >= 10) { root.querySelector('[data-stock-status]').textContent = '最多添加 10 只股票。'; return; }
      if (codes.indexOf(code) < 0) { codes.push(code); save(); } input.value = ''; refresh();
    };
    root.querySelector('[data-stock-refresh]').onclick = refresh;
    FinanceExplorer.open(root.querySelector('[data-finance-root]'));
    refresh(); timer = setInterval(refresh, 30000);
  }
  function close() { active = false; if (timer) clearInterval(timer); timer = null; }
  window.StocksDesk = {open: open, close: close, codes: function () { return codes || []; }};
}());
