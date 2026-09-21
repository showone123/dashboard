(function () {
  'use strict';
  var root, catalog = [], current, lastResult;
  var domains = [['a-share','A 股'], ['index','指数与板块'], ['meta','标的检索'], ['fund','基金'], ['futures','期货'], ['options','期权']];
  function el(tag, text) { var node = document.createElement(tag); if (text != null) node.textContent = text; return node; }
  function field(parent, tag, text) { var node = el(tag, text); parent.appendChild(node); return node; }
  function show(message) { root.querySelector('[data-finance-status]').textContent = message; }
  function selected() { return catalog.find(function (x) { return x.id === root.querySelector('[data-finance-endpoint]').value; }); }
  function renderParams() {
    current = selected(); var form = root.querySelector('[data-finance-form]'); form.replaceChildren();
    lastResult = null; root.querySelector('[data-finance-download]').disabled = true;
    if (!current) return;
    current.params.forEach(function (p) {
      var label = field(form, 'label'); label.className = 'finance-field';
      field(label, 'span', p.name + (p.required ? ' *' : ''));
      var input = field(label, 'input'); input.name = p.name; input.placeholder = p.description || p.name;
      input.required = p.required; input.maxLength = 2000;
      if (p.name === 'thscodes' && window.StocksDesk.codes) input.value = window.StocksDesk.codes().join(',');
      field(label, 'small', p.description);
    });
    root.querySelector('[data-finance-docs]').href = current.docs;
    show('填写参数后查询。* 为必填项；日期和枚举格式见接口文档。');
    root.querySelector('[data-finance-result]').replaceChildren();
  }
  function renderEndpoints() {
    var domain = root.querySelector('[data-finance-domain]').value;
    var select = root.querySelector('[data-finance-endpoint]'); select.replaceChildren();
    catalog.filter(function (x) { return x.domain === domain; }).forEach(function (x) {
      var option = field(select, 'option', x.group + ' · ' + x.title); option.value = x.id;
    });
    renderParams();
  }
  function renderResult(result) {
    var box = root.querySelector('[data-finance-result]'); box.replaceChildren();
    var data = result.data, items = data && Array.isArray(data.item) ? data.item : null;
    if (items && items.length && items.every(function (x) { return x && typeof x === 'object' && !Array.isArray(x); })) {
      var columns = Object.keys(items[0]).slice(0, 16), wrap = field(box, 'div'), table = field(wrap, 'table');
      wrap.className = 'finance-table-wrap'; table.className = 'tbl';
      var head = field(table, 'thead'), hr = field(head, 'tr');
      columns.forEach(function (key) { field(hr, 'th', key); });
      var body = field(table, 'tbody');
      items.slice(0, 100).forEach(function (item) { var row = field(body, 'tr'); columns.forEach(function (key) {
        var value = item[key]; field(row, 'td', value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value));
      }); });
      field(box, 'p', '显示前 ' + Math.min(items.length, 100) + ' / ' + items.length + ' 条；下载 JSON 获取完整结构。');
    } else {
      var pre = field(box, 'pre', JSON.stringify(data, null, 2).slice(0, 80000)); pre.className = 'finance-json';
      if (JSON.stringify(data).length > 80000) field(box, 'p', '预览已截断；下载 JSON 获取完整结构。');
    }
  }
  async function submit(event) {
    event.preventDefault(); if (!current) return;
    lastResult = null; root.querySelector('[data-finance-download]').disabled = true;
    var params = {}; new FormData(root.querySelector('[data-finance-submit]')).forEach(function (value, key) {
      if (String(value).trim()) params[key] = String(value).trim();
    });
    show('正在查询…'); root.querySelector('[data-finance-run]').disabled = true;
    try {
      var response = await fetch('/api/finance/query', {method:'POST', headers:{'Content-Type':'application/json','X-FluxDesk-Request':'1'}, body:JSON.stringify({id:current.id,params:params})});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json(); lastResult = result;
      if (result.code !== 0) { show('接口返回 ' + result.code + '：' + result.message + (result.request_id ? ' · 请求 ' + result.request_id : '')); return; }
      renderResult(result);
      show('查询成功 · ' + current.title + (result.data && result.data.timestamp ? ' · 数据时间 ' + new Date(result.data.timestamp).toLocaleString('zh-CN', {hour12:false}) : ''));
      root.querySelector('[data-finance-download]').disabled = false;
    } catch (error) { show('查询失败：' + error.message + '。请检查参数、配额或服务端配置。'); }
    finally { root.querySelector('[data-finance-run]').disabled = false; }
  }
  async function open(node) {
    root = node;
    root.innerHTML = '<div class="finance-heading"><div><small>HITHINK FINANCE DATA</small><h2>金融数据查询</h2><p>按官方公开接口选择业务与参数，结果保留原始字段。</p></div></div>' +
      '<div class="finance-toolbar"><label>业务域 <select data-finance-domain></select></label><label>接口 <select data-finance-endpoint></select></label><a data-finance-docs target="_blank" rel="noopener noreferrer">接口文档 ↗</a></div>' +
      '<form data-finance-submit><div class="finance-fields" data-finance-form></div><div class="finance-actions"><button class="btn primary" data-finance-run type="submit">查询数据</button><button class="btn" data-finance-download type="button" disabled>下载 JSON</button></div></form>' +
      '<p class="finance-status" data-finance-status aria-live="polite">正在加载接口目录…</p><div data-finance-result></div>';
    root.querySelector('[data-finance-submit]').onsubmit = submit;
    root.querySelector('[data-finance-domain]').onchange = renderEndpoints;
    root.querySelector('[data-finance-endpoint]').onchange = renderParams;
    root.querySelector('[data-finance-download]').onclick = function () {
      if (!lastResult) return;
      var url = URL.createObjectURL(new Blob([JSON.stringify(lastResult, null, 2)], {type:'application/json'}));
      var link = el('a'); link.href = url; link.download = current.id + '.json'; link.click(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    };
    try {
      var response = await fetch('/financial_catalog.json', {cache:'force-cache'});
      if (!response.ok) throw new Error('HTTP ' + response.status);
      catalog = await response.json();
      var select = root.querySelector('[data-finance-domain]');
      domains.forEach(function (d) { var option = field(select, 'option', d[1]); option.value = d[0]; });
      renderEndpoints();
    } catch (error) { show('接口目录加载失败：' + error.message); }
  }
  window.FinanceExplorer = {open: open};
}());
