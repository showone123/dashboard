/* Independent public-data workspace. No changes to cloud auth or customer data. */
(function () {
  'use strict';
  var categories = [['futures', '期货手续费'], ['options', '期权手续费'], ['companies', '期货公司'], ['articles', '期货资料'], ['software', '期货软件']];
  var root, user = '', key = 'futures', category = 'futures', data = null, favorites = {}, memory = {};
  var query = '', group = '', onlyFavorites = false, page = 1, active = false, timer, generation = 0, loading = false, notice = '';
  var PAGE_SIZE = 30;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]; }); }
  function safeLink(url) { try { var u = new URL(url); return u.protocol === 'https:' && u.hostname === 'www.9qihuo.com' ? u.href : 'https://www.9qihuo.com'; } catch (e) { return 'https://www.9qihuo.com'; } }
  function el(id) { return root.querySelector('[data-ft="' + id + '"]'); }
  function read(k, fallback) { try { return JSON.parse(localStorage.getItem(k)) || fallback; } catch (e) { return fallback; } }
  function write(k, value) { try { localStorage.setItem(k, JSON.stringify(value)); return true; } catch (e) { return false; } }
  function favoriteKey() { return 'fluxdesk_futures_favorites_v1:' + user; }
  function timeLabel(t) { if (!t) return '尚未成功更新'; var d = new Date(t); return isNaN(d.getTime()) ? t : d.toLocaleString('zh-CN', {hour12:false}); }
  function valid(d) { return d && Array.isArray(d.items) && Array.isArray(d.columns); }
  function cached(k) { var d = memory[k] || read('fluxdesk_futures_snapshot_v1:' + k, null); return valid(d) ? d : null; }

  function shell() {
    root.innerHTML = '<div class="ft-heading"><div><div class="ft-eyebrow">FUTURES RESOURCE DESK</div><h1>期货工具箱</h1><p>手续费、机构与资料，集中查询与收藏。</p></div><button type="button" class="btn primary" data-ft="refresh">↻ 立即刷新</button></div>' +
      '<div class="ft-tabs" role="group" aria-label="期货工具分类">' + categories.map(function (c) { return '<button type="button" data-category="' + c[0] + '" aria-pressed="false">' + c[1] + '</button>'; }).join('') + '</div>' +
      '<div class="ft-toolbar"><label class="ft-search">⌕ <input data-ft="search" type="search" placeholder="搜索品种、合约、公司或标题" aria-label="搜索期货工具内容"></label><select data-ft="group" aria-label="按交易所或分类筛选"><option value="">全部分类</option></select><button class="btn" data-ft="favorites" type="button" aria-pressed="false">☆ 只看收藏</button></div>' +
      '<div class="ft-meta"><span data-ft="count"></span><span data-ft="time"></span><a data-ft="source" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></div>' +
      '<div class="ft-status" data-ft="status" role="status" aria-live="polite"></div><div data-ft="back"></div><div data-ft="content"></div>' +
      '<div class="ft-pagination"><button class="btn sm" type="button" data-ft="prev">上一页</button><span data-ft="pages"></span><button class="btn sm" type="button" data-ft="next">下一页</button></div>' +
      '<p class="ft-footnote" data-ft="scope"></p>';
    el('search').value = query;
    el('search').oninput = function () { query = this.value; page = 1; render(); };
    el('group').onchange = function () { group = this.value; page = 1; render(); };
    el('favorites').onclick = function () { onlyFavorites = !onlyFavorites; page = 1; render(); };
    el('refresh').onclick = function () { request(true); };
    el('prev').onclick = function () { page--; render(); };
    el('next').onclick = function () { page++; render(); };
    root.onclick = function (event) {
      var button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.category) select(button.dataset.category);
      if (button.dataset.product) select('option:' + button.dataset.product);
      if (button.dataset.ftBack) select('options');
      if (button.dataset.favorite) {
        var id = button.dataset.favorite;
        if (favorites[id]) delete favorites[id]; else favorites[id] = true;
        if (!write(favoriteKey(), favorites)) notice = '浏览器存储不可用，收藏暂存至本次会话。';
        render();
      }
    };
  }

  function select(next) {
    key = next; category = next.indexOf('option:') === 0 ? 'options' : next;
    query = ''; group = ''; page = 1; notice = ''; loading = false;
    clearTimeout(timer); generation++;
    data = cached(key);
    shell(); render(); request(false);
  }

  function favoriteButton(r) {
    return '<button type="button" class="ft-star' + (favorites[r.id] ? ' selected' : '') + '" data-favorite="' + esc(r.id) + '" aria-pressed="' + !!favorites[r.id] + '" aria-label="' + (favorites[r.id] ? '取消收藏 ' : '收藏 ') + esc(r.title) + '">' + (favorites[r.id] ? '★' : '☆') + '</button>';
  }
  function sourceLink(r) { return '<a href="' + esc(safeLink(r.url)) + '" target="_blank" rel="noopener noreferrer">来源 ↗</a>'; }
  function render() {
    if (!active || !root) return;
    var items = data && data.items || [], columns = data && data.columns || [];
    var ordered = columns.slice(1).sort(function (a, b) {
      var priority = ['开仓手续费', '平昨手续费', '平今手续费', '行权手续费', '保证金/每手', '权利金'];
      var ai = priority.indexOf(a), bi = priority.indexOf(b);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    });
    root.querySelectorAll('[data-category]').forEach(function (b) { b.setAttribute('aria-pressed', b.dataset.category === category ? 'true' : 'false'); });
    var groups = Array.from(new Set(items.map(function (r) { return r.group; }).filter(Boolean)));
    el('group').innerHTML = '<option value="">全部分类 / 交易所</option>' + groups.map(function (g) { return '<option value="' + esc(g) + '">' + esc(g) + '</option>'; }).join('');
    if (groups.indexOf(group) < 0) group = '';
    el('group').value = group;
    el('favorites').setAttribute('aria-pressed', String(onlyFavorites));
    el('favorites').textContent = (onlyFavorites ? '★' : '☆') + ' 只看收藏';
    var q = query.trim().toLowerCase();
    var filtered = items.filter(function (r) { return (!group || r.group === group) && (!onlyFavorites || favorites[r.id]) && (!q || (r.title + ' ' + r.group + ' ' + (r.fields || []).map(function (f) { return f.join(' '); }).join(' ')).toLowerCase().indexOf(q) >= 0); });
    var pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    page = Math.min(Math.max(1, page), pages);
    var shown = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
    el('count').textContent = filtered.length + ' 条结果 / ' + items.length + ' 条已缓存';
    el('time').textContent = '最后成功更新：' + timeLabel(data && data.updated_at);
    el('source').href = safeLink(data && data.source_url || 'https://www.9qihuo.com/' + ({futures:'qihuoshouxufei',options:'qiquanshouxufei',companies:'gongsi',articles:'fenlei/ziliao',software:'ruanjian'}[category]));
    var refreshing = loading || (data && data.refreshing);
    el('refresh').disabled = !!refreshing;
    el('refresh').textContent = refreshing ? '↻ 正在刷新…' : '↻ 立即刷新';
    el('status').textContent = notice || (data && data.error) || (refreshing ? '后台更新中，你可以继续查看已有数据。' : (data && data.stale ? '当前显示已保存快照，可立即刷新获取最新内容。' : '已载入保存的数据，打开页面无需等待抓取。'));
    el('status').classList.toggle('warning', !!(notice || (data && data.error)));
    el('back').innerHTML = key.indexOf('option:') === 0 ? '<button type="button" class="btn sm ft-back" data-ft-back="1">← 返回期权品种</button>' : '';
    if (!shown.length) {
      el('content').innerHTML = '<div class="ft-empty"><b>' + (items.length ? '没有符合条件的内容' : '暂无已保存数据') + '</b><p>' + (items.length ? '试试其他关键词，或关闭「只看收藏」。' : '点击立即刷新；来源暂不可用时也可以直接打开原站。') + '</p></div>';
    } else if (columns.length) {
      el('content').innerHTML = '<div class="ft-table-wrap" tabindex="0" aria-label="手续费表格，可横向滚动"><table class="ft-table"><thead><tr><th>收藏</th><th>' + esc(columns[0]) + '</th><th>交易所</th>' + ordered.map(function (c) { return '<th>' + esc(c) + '</th>'; }).join('') + '<th>来源更新时间</th><th>来源</th></tr></thead><tbody>' + shown.map(function (r) { return '<tr><td>' + favoriteButton(r) + '</td><th scope="row">' + esc(r.title) + '</th><td>' + esc(r.group) + '</td>' + ordered.map(function (label) { var f = r.fields.find(function (pair) { return pair[0] === label; }); return '<td>' + esc(f ? f[1] : '—') + '</td>'; }).join('') + '<td>' + esc(r.source_updated_at || '未标注') + '</td><td>' + sourceLink(r) + '</td></tr>'; }).join('') + '</tbody></table></div>';
    } else {
      el('content').innerHTML = '<div class="ft-cards">' + shown.map(function (r) { return '<article class="ft-card"><div class="ft-card-top"><span class="ft-tag">' + esc(r.group) + '</span>' + favoriteButton(r) + '</div><h2>' + esc(r.title) + '</h2>' + (r.fields || []).map(function (f) { return '<p><span>' + esc(f[0]) + '</span>' + esc(f[1]) + '</p>'; }).join('') + '<div class="ft-card-bottom">' + (r.product ? '<button class="btn sm" type="button" data-product="' + esc(r.product) + '">查看费用明细</button>' : '<small>' + (r.source_updated_at ? esc(r.source_updated_at) : '来源未标注更新时间') + '</small>') + sourceLink(r) + '</div></article>'; }).join('') + '</div>';
    }
    el('pages').textContent = page + ' / ' + pages;
    el('prev').disabled = page <= 1; el('next').disabled = page >= pages;
    el('scope').textContent = (data && data.scope || '期权按品种查看费用明细。') + ' · 来源：九期网 · 抓取时间不等于费用生效时间；收藏保存在当前浏览器、按账号区分。';
  }

  async function request(refresh, poll) {
    if (!active || loading) return;
    var mine = ++generation, requestedKey = key, controller = new AbortController();
    loading = true; if (!poll) notice = ''; render();
    var deadline = setTimeout(function () { controller.abort(); }, 10000);
    try {
      var response = await fetch('/api/futures' + (refresh ? '/refresh' : '') + '?category=' + encodeURIComponent(requestedKey), {
        method: refresh ? 'POST' : 'GET', headers: refresh ? {'X-FluxDesk-Request':'1'} : {}, cache:'no-store', signal:controller.signal
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var result = await response.json();
      if (!valid(result)) throw new Error('invalid snapshot');
      if (!active || mine !== generation) return;
      if (result.items.length || !data || !data.items.length) data = result;
      else { data.error = result.error || '服务暂未返回新数据，继续显示本地快照。'; data.refreshing = result.refreshing; }
      if (data.items.length) { memory[requestedKey] = data; write('fluxdesk_futures_snapshot_v1:' + requestedKey, data); }
      if (result.action === 'cooldown') notice = '刷新请求间隔为 60 秒，请稍后重试。';
      if (result.action === 'busy') notice = '更新任务较多，请稍后重试。';
      if (result.refreshing) {
        if ((poll || 0) < 60) timer = setTimeout(function () { request(false, (poll || 0) + 1); }, 2000);
        else { data.refreshing = false; notice = '更新仍在后台进行，可稍后再次查看。'; }
      } else if (!result.items.length && !result.error && !poll && !refresh) {
        timer = setTimeout(function () { request(true); }, 0);
      }
    } catch (e) {
      if (!active || mine !== generation) return;
      notice = data && data.items.length ? '连接失败，继续显示上次保存的数据。' : '暂时无法获取数据，请稍后重试或查看来源。';
      if (data) data.refreshing = false;
    } finally {
      clearTimeout(deadline);
      if (mine === generation) { loading = false; render(); }
    }
  }
  window.FuturesDesk = {
    open: function (element, userId) {
      root = element; active = true;
      if (user !== String(userId || '')) { user = String(userId || ''); favorites = read(favoriteKey(), {}); onlyFavorites = false; }
      select(key);
    },
    close: function () { active = false; loading = false; generation++; clearTimeout(timer); }
  };
})();
