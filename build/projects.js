/* ==========================================================================
   GitHub 收录项目 —— 全站公开的**只读展示页**
   ---------------------------------------------------------------------------
   两个视图：
     · 收录项目（默认）—— 云表 public.projects 的**全量**，按更新时间倒序铺开；
       支持关键词 / 类别 / 开源程度 / 日期区间 / Star 下限筛选，可导出 Excel。
     · 热点榜 —— 静态资源 /assets/hot-projects.json，按升星速度或总星数排名。

   ★ 2026-10-04 改版：**删掉了整个写入口**（新增 / 编辑 / 删除 / Excel 导入 /
     下载模板 / 云同步状态条）。需求原话是「这个分区以后就纯做展示页」。
     写现在只由运维侧的定时任务产生（走 db_exec_sql 管理通道，天然绕过 RLS）。

   ★ 数据存在云数据库 public.projects，**读是公开的**：
     迁移 004 的 projects_public_read 是 `FOR SELECT TO anon, authenticated USING (true)`，
     所以任何访客都能看到全部收录项目；写权限仍只有 operators 名单内的人有
     （迁移 003 的 projects_operator_all，未改动）。
     ⚠️ 反向推论：这个模块**不能**出现任何写调用。verify.py §6.2b 会从源码层面拦
        （扫描 .insert( / .update( / .upsert( / .delete( 四个字面量）。

   ★ 为什么 id 还留着：它是表主键，也是 Excel 重复导入时代的 upsert 锚点；
     展示页不需要它，但删掉会让历史数据失去稳定标识，所以只读不改。

   对外接口：window.ProjectsDesk.open(node) / .close() / .count()
   数据契约（也是 Excel 导出的表头顺序）见 COLS —— 改这里等于改模板契约。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- 数据契约 ---------- */
  var COLS = [
    { k: 'added_at', t: '入库日期' },
    { k: 'name', t: '项目名称' },
    { k: 'url', t: '仓库地址' },
    { k: 'category', t: '项目类别' },
    { k: 'summary', t: '项目简介' },
    { k: 'openness', t: '开源程度' },
    { k: 'stars', t: 'Star 数' },
    { k: 'note', t: '备注' }
  ];

  var CATS = ['AI / LLM', '数据分析', '量化交易', '开发者工具', '前端 UI', '后端服务',
    '数据库', '运维部署', '爬虫采集', '文档知识库', '效率工具', '学习资源', '其他'];

  var OPEN = ['完全开源', '开源核心', '部分开源', '源码可见', '闭源'];

  var TONE = { '完全开源': 'good', '开源核心': 'info', '部分开源': 'warn', '源码可见': 'muted', '闭源': 'bad' };

  /* ---------- 纯函数（可被 node 直接测，不碰 DOM） ---------- */
  function pad(n) { return String(n).padStart(2, '0'); }
  function ymd(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function today() { return ymd(new Date()); }

  // Excel 里日期可能是 Date / 序列号 / 各种字符串，统一成 YYYY-MM-DD
  function toDate(v) {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !isNaN(v)) return ymd(v);
    if (typeof v === 'number' && isFinite(v)) {
      return ymd(new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000));
    }
    var s = String(v).trim();
    var m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
    if (m) return m[1] + '-' + pad(m[2]) + '-' + pad(m[3]);
    var d = new Date(s);
    return isNaN(d.getTime()) ? '' : ymd(d);
  }

  function toStars(v) {
    if (typeof v === 'number' && isFinite(v)) return Math.max(0, Math.round(v));
    var s = String(v === null || v === undefined ? '' : v).replace(/[,\s个★⭐]/g, '');
    // GitHub 页面上是「74.2k」这种写法，直接 Number() 会变成 NaN 静默丢成 0
    var k = s.match(/^([\d.]+)[kK]$/);
    if (k) return Math.max(0, Math.round(Number(k[1]) * 1000));
    var n = Number(s);
    return isFinite(n) ? Math.max(0, Math.round(n)) : 0;
  }

  function rowToArray(it) {
    return COLS.map(function (c) { return it[c.k]; });
  }

  // 筛选：空值 = 不限制
  function matchItem(it, f) {
    if (f.cat && it.category !== f.cat) return false;
    if (f.open && it.openness !== f.open) return false;
    if (f.from && it.added_at && it.added_at < f.from) return false;
    if (f.to && it.added_at && it.added_at > f.to) return false;
    if (f.minStars !== '' && Number(it.stars || 0) < Number(f.minStars)) return false;
    if (f.q) {
      var hay = [it.name, it.url, it.summary, it.category, it.openness, it.note].join(' ').toLowerCase();
      if (hay.indexOf(f.q.toLowerCase()) < 0) return false;
    }
    return true;
  }

  /* ---------- 「更新顺序」是这个页面的默认口径 ----------
     需求原话：「点进去默认按照更新顺序全部显示」。
     ⇒ 用 updated_at 倒序（最近被更新过的排最前），它才是真正的"更新顺序"；
        added_at 只是"第一次收录的日期"，手工补录/回填的数据两者会不一致。
     ⚠️ 兜底不能省：早期数据与运维侧直插的行可能没有 updated_at，
        这时退到 added_at（补一个 T00:00:00Z 让两种格式能直接比字符串）。
     ⚠️ 副键必须给（同日/同秒按 Star 降序），否则同一份数据两次渲染顺序会漂。 */
  function orderOf(it) {
    var u = String((it && it.updated_at) || '').trim();
    if (u) return u;
    return String((it && it.added_at) || '') + 'T00:00:00Z';
  }

  function sortRows(list) {
    return (list || []).slice().sort(function (a, b) {
      var ua = orderOf(a), ub = orderOf(b);
      if (ua !== ub) return ua < ub ? 1 : -1;
      return Number(b && b.stars || 0) - Number(a && a.stars || 0);
    });
  }

  var PURE = { COLS: COLS, toDate: toDate, toStars: toStars, rowToArray: rowToArray,
    matchItem: matchItem, today: today, sortRows: sortRows, orderOf: orderOf };

  /* ---------- 热点榜（静态资源，只读情报） ----------
     数据由 build/refresh_hot.py 每晚生成，作为静态资源放在 /assets/hot-projects.json。
     为什么不直接写进云表：这是**只读的公共情报**，每天自动灌进"收录项目"里
     会让展示表变成流水账；收录与否由运维侧的定时任务决定。
     —— 静态资源不需要动 server.py，所以 dist/server.py 的字节契约保持不变。 */
  var HOT_URL = '/assets/hot-projects.json';

  function hotHeat(h) {
    var w = Number(h && h.stars_week) || 0;
    var d = Number(h && h.stars_today) || 0;
    return Math.max(w, d * 7, Number(h && h.heat) || 0);
  }

  /* ---------- 榜单口径（2026-10-04 新增）
     上游数据有两套量纲：日榜（stars today）与周榜（stars this week）。
     ① 升星榜要能横向比，就必须先折成同一单位：日榜直接取日增；
        **只有周榜数据的仓库**按 7 天摊成日均。不折算的话，周榜项永远碾压日榜项。
     ② 总星榜按 stars 降序 —— 这个榜不看热度，看存量，两个榜互补。
     ★ 排序必须稳定：主键相等时用副键兜底，否则同一份数据两次渲染顺序会漂。 */
  function hotGain(h) {
    var d = Number(h && h.stars_today) || 0;
    var w = Number(h && h.stars_week) || 0;
    if (d > 0) return d;
    return w > 0 ? Math.round(w / 7) : 0;
  }

  function hotRank(list, key) {
    var byStars = key === 'stars';
    return (list || []).slice().sort(function (a, b) {
      var s = (Number(b && b.stars) || 0) - (Number(a && a.stars) || 0);
      var g = hotGain(b) - hotGain(a);
      return byStars ? (s || g) : (g || s);
    });
  }

  // 「日榜 +556 · 周榜 +3,124 · Shell · 建库 2026-01-02」
  function hotFacts(h) {
    var n = function (x) { return Number(x || 0).toLocaleString('zh-CN'); };
    var bits = [];
    if (Number(h && h.stars_today) > 0) bits.push('日榜 +' + n(h.stars_today));
    if (Number(h && h.stars_week) > 0) bits.push('周榜 +' + n(h.stars_week));
    if (h && h.language) bits.push(String(h.language));
    if (h && h.created_at) bits.push('建库 ' + h.created_at);
    return bits.join(' · ');
  }

  // 去重键：地址优先，其次名称（统一小写）
  function depKey(o) { return String((o && (o.url || o.name)) || '').toLowerCase(); }

  function hotFresh(list, owned) {
    var seen = {};
    (owned || []).forEach(function (it) { var k = depKey(it); if (k) seen[k] = 1; });
    return (list || []).filter(function (h) {
      var k = depKey(h);
      // 没有 key 的脏项直接丢：既无法去重，也不该被算成"已收录"
      return k && !seen[k];
    });
  }

  PURE.HOT_URL = HOT_URL;
  PURE.hotHeat = hotHeat;
  PURE.hotGain = hotGain;
  PURE.hotRank = hotRank;
  PURE.hotFacts = hotFacts;
  PURE.hotFresh = hotFresh;
  PURE.depKey = depKey;

  if (typeof module === 'object' && module.exports) { module.exports = PURE; return; }

  /* ---------- 运行时状态 ---------- */
  var root = null, items = [], active = false;
  /* 正在读取的次数（>0 即"数据还在路上"）。状态位必须用它，不能拿 items.length 反推 ——
     见 renderState() 里的踩坑记录。 */
  var pending = 0;
  var f = { q: '', cat: '', open: '', from: '', to: '', minStars: '' };
  var hot = null, hotErr = '';   // hot=null 表示还没拉过（成功/失败都会落地）
  /* 两个视图：收录项目（默认，主视图）与热点榜。
     改版前这里是「我的库 / 热点榜」——库是私有的、默认只给运营方看；
     现在收录项目是全站公开的展示页，所以它继续当默认视图。 */
  var VIEWS = ['all', 'hot'];
  var view = 'all';
  // 榜单口径：gain=升星速度（日均），stars=总星数。默认升星，那才是"热点"。
  var hotSort = 'gain';

  // 表格自己的列数（序号 + 6 个业务列）—— 空态那一行的 colspan 用它。
  // ⚠️ 它与 COLS.length（Excel 导出契约 8 列）是**两回事**，别互相代用。
  var TCOLS = 7;

  function $(sel) { return root.querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(n) { return Number(n || 0).toLocaleString('zh-CN'); }

  /* ---------- 读取：云数据库 public.projects（公开只读） ----------
     权限边界见 migrations/004_projects_public_read.sql：
     SELECT 对 anon + authenticated 全开，所以这里**不需要**任何身份判断，
     也不需要 .eq('owner_id', ...) —— 全表就是展示内容。
     ★ 本模块**只读**。任何 .insert/.update/.upsert/.delete 都会被
       verify.py §6.2b 从源码层面拦下（这是"纯展示页"这条需求的回归哨兵）。 */
  var TABLE = 'projects';
  var loadErr = '';

  function api() {
    return (global.cloud && global.cloud.database) ? global.cloud.database : null;
  }

  // SDK 报错 → 能照着做的中文（不要把 traceback 甩给用户）
  function dbErr(e) {
    var m = (e && e.message) ? String(e.message) : String(e || '未知错误');
    if (/42501|permission denied|row-level security/i.test(m)) return '没有权限读取：请确认迁移 004 已应用（projects_public_read）';
    if (/401|not authenticated|jwt|token/i.test(m)) return '登录已过期，请刷新页面重新登录';
    if (/failed to fetch|network|load failed/i.test(m)) return '网络不通，请检查网络后重试';
    return m;
  }

  /* 云客户端没接上时的提示要**指得出下一步**，不能只说"未就绪"：
     真实故障是 app.js 忘了把实例挂到 window 上，然后这个模块静默地一直渲染空表，
     界面上一切正常（骨架/筛选器/空态都在），只有数字是 0 —— 2026-10-04 排查实录。 */
  var NO_CLOUD = '云服务未就绪（app.js 未把 cloud 实例挂到 window）';

  function normalize(it) {
    var o = {
      id: (it && it.id) ? String(it.id) : '',
      // 审计时间要留着：默认排序口径就是 updated_at，丢掉它页面就退回"入库日期"排序
      updated_at: String((it && it.updated_at) || ''),
      created_at: String((it && it.created_at) || '')
    };
    COLS.forEach(function (c) {
      o[c.k] = c.k === 'stars' ? toStars(it && it[c.k]) : String((it && it[c.k]) || '').trim();
    });
    o.added_at = toDate(o.added_at) || '';
    return o;
  }

  function load() {
    var a = api();
    if (!a) { loadErr = NO_CLOUD; return Promise.resolve(); }
    // 服务端先按 updated_at 倒序取（表可能超过 1000 行，不能无条件全量拉），
    // 客户端再算一遍同样的口径 —— 两条路径（表格 / 导出）共用 sortRows()，顺序不会分叉。
    // ⚠️ 老列的兼容兜底：万一 updated_at 排序不被支持（返回 error），退回 added_at，
    //    而不是把整页变成"读取失败"。
    function q(col) { return a.from(TABLE).select('*').order(col, { ascending: false }).limit(1000); }
    pending++;
    return q('updated_at').then(function (r) {
      return r && r.error ? q('added_at') : r;
    }).then(function (r) {
      if (r && r.error) throw r.error;
      items = (r.data || []).map(normalize);
      loadErr = '';
    }).catch(function (e) { items = []; loadErr = dbErr(e); })
      // 成功/失败都要归零，否则状态位会永久卡在 loading（另一个方向的假象）
      .then(function () { if (pending > 0) pending--; });
  }

  /* ---------- 派生 ---------- */
  function visible() {
    return sortRows(items.filter(function (it) { return matchItem(it, f); }));
  }

  /* ---------- 渲染 ---------- */
  /* ⚠️ 状态位必须把"正在读"算进去（pending>0 → loading），不能靠"items 为空"反推。
     2026-10-04 踩坑：open() 先渲染骨架时 items 是空的、loadErr 也是空的 ⇒ 状态位
     立刻被写成 empty（"暂无收录项目"），而数据其实还在路上。两个后果：
       ① 界面上先闪一句"暂无收录项目"，几百毫秒后才跳出 22 条，看着像 bug；
       ② 渲染验收探针等的是「状态位 ≠ loading」，被这个**假的 empty** 提前放行，
          于是量到 0 行，排序/筛选/全量铺开 一共 6 项断言集体假红 ——
          结论"页面没数据"是错的，错的是测量时机。加载态只能由读取计数决定。 */
  function renderState() {
    var el = $('[data-pr-state]');
    if (!el) return;
    var state = pending > 0 ? 'loading'
      : (loadErr ? 'error' : (items.length ? 'ready' : 'empty'));
    el.setAttribute('data-pr-state', state);
    el.className = 'pr-state ' + state;
    el.textContent = loadErr
      ? ('读取失败：' + loadErr)
      : (pending > 0 ? '正在读取…'
        : (items.length ? ('共 ' + items.length + ' 个收录项目 · 按最近更新排序') : '暂无收录项目'));
  }

  function renderStats() {
    var days30 = new Date(Date.now() - 30 * 86400000);
    var recent = items.filter(function (it) {
      var d = new Date(it.added_at + 'T00:00:00');
      return !isNaN(d.getTime()) && d >= days30;
    }).length;
    var cats = {};
    items.forEach(function (it) { if (it.category) cats[it.category] = (cats[it.category] || 0) + 1; });
    var stars = items.reduce(function (a, it) { return a + Number(it.stars || 0); }, 0);
    var top = Object.keys(cats).sort(function (a, b) { return cats[b] - cats[a]; })[0];
    var cards = [
      ['收录项目', num(items.length), '个仓库'],
      ['项目类别', num(Object.keys(cats).length), top ? '最多：' + top : '尚未分类'],
      ['Star 合计', num(stars), '入库时快照'],
      ['近 30 天入库', num(recent), '持续整理中']
    ];
    $('[data-pr-stats]').innerHTML = cards.map(function (c) {
      return '<div class="pr-stat"><span>' + c[0] + '</span><b>' + c[1] + '</b><em>' + esc(c[2]) + '</em></div>';
    }).join('');
  }

  function renderBars() {
    var counts = {}, max = 0;
    items.forEach(function (it) {
      var k = it.category || '未分类';
      counts[k] = (counts[k] || 0) + 1;
      if (counts[k] > max) max = counts[k];
    });
    var ks = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    if (!ks.length) { $('[data-pr-bars]').innerHTML = ''; return; }
    $('[data-pr-bars]').innerHTML = ks.map(function (k) {
      var on = f.cat === k ? ' active' : '';
      var w = Math.max(3, Math.round(counts[k] / max * 34));
      return '<button class="pr-bar' + on + '" type="button" data-pr-bar="' + esc(k) + '">'
        + '<i style="width:' + w + 'px"></i>' + esc(k) + ' <u>' + counts[k] + '</u></button>';
    }).join('');
  }

  /* 导出条：把"导的是哪一批"写在按钮上。
     筛选与导出必须同一口径 —— 否则用户以为导了全部、其实只导了当前筛选结果。
     全量导出单独给一个按钮，而不是靠"先点重置再导出"这种口头约定。
     ⚠️ 位置：右上角动作区（见 skeleton 的注释）。两个按钮同为 .btn 尺寸，
        次要那个弱化一档颜色 —— 在这条动作带里再塞个 11px 小按钮会显得像误入的。 */
  function renderExportBar(rows) {
    var box = $('[data-pr-export-row]');
    if (!box) return;
    var n = rows.length;
    var html = '<button class="btn" type="button" data-pr-export' + (n ? '' : ' disabled')
      + '>导出当前 ' + n + ' 条</button>';
    if (n !== items.length) {
      html += '<button class="btn" type="button" data-pr-export-all>导出全部 '
        + items.length + ' 条</button>';
    }
    box.innerHTML = html;
  }

  function renderTable() {
    var rows = visible();
    var box = $('[data-pr-body]');
    $('[data-pr-count]').textContent = rows.length === items.length
      ? ('共 ' + items.length + ' 个项目 · 按最近更新排序')
      : ('筛选出 ' + rows.length + ' / ' + items.length + ' 个项目');
    renderExportBar(rows);

    if (!rows.length) {
      box.innerHTML = '<tr><td colspan="' + TCOLS + '"><div class="pr-empty">'
        + (items.length
          ? '<b>没有符合条件的项目</b>放宽筛选条件，或点「重置」。'
          : (loadErr
            ? '<b>数据没读到</b>' + esc(loadErr) + '。点右上角「刷新数据」重试。'
            : '<b>还没有收录任何项目</b>收录内容由运维侧的定时任务写入云端，稍后刷新即可看到。'))
        + '</div></td></tr>';
      return;
    }

    box.innerHTML = rows.map(function (it, i) {
      var tone = TONE[it.openness] || 'muted';
      var link = it.url
        ? '<a href="' + esc(it.url) + '" target="_blank" rel="noopener noreferrer">' + esc(it.name || it.url) + '</a>'
        : esc(it.name || '—');
      /* 备注与地址分成两行、各自单行省略（title 里挂全文）。
         为什么：备注现在会写上「… ｜ 商业价值：…」，跟地址拼成一行会把单元格撑成一大片，
         十行表格看着像糊了一层字。 */
      var note = String(it.note || '').trim();
      var raw = (it.url && it.name) ? String(it.url) : '';
      var meta = (note ? '<small class="pr-note-line" title="' + esc(note) + '">' + esc(note) + '</small>' : '')
        + (raw ? '<small class="pr-url-line" title="' + esc(raw) + '">' + esc(raw) + '</small>' : '');
      return '<tr>'
        + '<td class="pr-no">' + (i + 1) + '</td>'
        + '<td class="pr-date">' + esc(it.added_at || '—') + '</td>'
        + '<td class="pr-name">' + link + meta + '</td>'
        + '<td><span class="pr-tag">' + esc(it.category || '未分类') + '</span></td>'
        + '<td class="pr-summary"><p>' + esc(it.summary || '—') + '</p></td>'
        + '<td><span class="pr-open ' + tone + '">' + esc(it.openness || '未标注') + '</span></td>'
        + '<td class="pr-stars">' + num(it.stars) + '</td>'
        + '</tr>';
    }).join('');
  }

  /* ---------- 视图切换（收录项目 / 热点榜） ----------
     只切可见性 + 按钮态：两个视图各自的数据源独立（表=云库，榜=静态 JSON），
     互相不重绘，切换是零成本的。计数直接写在按钮上，扫一眼就知道各有多少。 */
  function renderView() {
    if (!root) return;
    root.setAttribute('data-pr-view', view);
    var panes = root.querySelectorAll('[data-pr-pane]');
    for (var i = 0; i < panes.length; i++) {
      if (panes[i].getAttribute('data-pr-pane') === view) panes[i].removeAttribute('hidden');
      else panes[i].setAttribute('hidden', '');
    }
    var btns = root.querySelectorAll('[data-pr-view]');
    for (var j = 0; j < btns.length; j++) {
      var k = btns[j].getAttribute('data-pr-view');
      btns[j].className = 'pr-view-btn' + (k === view ? ' active' : '');
      var u = btns[j].querySelector('u');
      if (u) {
        u.textContent = (k === 'all')
          ? String(items.length)
          : (hot && hot.items ? String(hot.items.length) : '—');
      }
    }
  }

  /* ⚠️ renderView() 必须在最前面：它负责把 `data-pr-view` 写到根节点上并切 pane 的
     hidden。漏掉它不会报错、页面也看着正常（默认那个 pane 本来就没带 hidden），
     但根节点上少了状态标记 —— 验收探针与 CSS 选择器（`.projects-workspace[data-pr-view=…]`）
     都会失准。2026-10-04 重写时漏过一次，被本地渲染探针抓住。 */
  function render() { renderView(); renderState(); renderStats(); renderBars(); renderTable(); }

  /* ---------- 热点榜：排名 / 渲染 ----------
     榜就该有榜的样子：① 有排名号；② 排序口径写在界面上而不是藏在代码里；
     ③ 两个口径各自成榜，由用户选；④ 顺便标出"是否已收录"。 */
  var SORT_LABEL = { gain: '升星速度', stars: '总星数' };

  function tabBtn(key) {
    return '<button class="pr-rank-tab' + (hotSort === key ? ' active' : '') + '" type="button" '
      + 'data-pr-sort="' + key + '">' + SORT_LABEL[key] + '</button>';
  }

  function renderHot() {
    var box = root && $('[data-pr-hot]');
    if (!box) return;
    /* 对外暴露加载状态：数据是异步来的，验收脚本必须能等到「不是 loading」再断言，
       否则会在 fetch 落地前读到空区块 —— 那是假红，不是功能坏了。 */
    if (hot === null) {
      box.setAttribute('data-pr-hot-state', 'loading');
      box.innerHTML = '<div class="pr-hot-empty">正在读取热点数据…</div>';
      return;
    }
    var list = hot.items || [];
    box.setAttribute('data-pr-hot-state', list.length ? 'ready' : (hotErr ? 'error' : 'empty'));
    if (!list.length) {
      box.innerHTML = '<div class="pr-hot-empty">'
        + (hotErr ? '热点数据没读到（' + esc(hotErr) + '）。不影响收录项目的浏览。'
                  : '热点数据为空。跑 <code>python build/refresh_hot.py</code> 生成。')
        + '</div>';
      return;
    }
    var fresh = hotFresh(list, items);
    var ranked = hotRank(list, hotSort);
    var head = '<div class="pr-hot-head">'
      + '<div><small>TRENDING ON GITHUB</small><b>热点榜</b>'
      + '<em>更新于 ' + esc(hot.updated_at || '—') + ' · 共 ' + list.length + ' 个'
      + (fresh.length ? ' · 其中 <u>' + fresh.length + '</u> 个尚未收录' : ' · 已全部收录') + '</em></div>'
      + '<div class="pr-hot-act">'
      + '<div class="pr-rank-tabs" data-pr-rank-tabs>' + tabBtn('gain') + tabBtn('stars') + '</div>'
      + '</div></div>';

    var body = '<div class="pr-hot-grid">' + ranked.map(function (h, i) {
      var owned = fresh.indexOf(h) < 0;
      return '<article class="pr-hot-card' + (owned ? ' owned' : '') + (i < 3 ? ' top' : '') + '"'
        + ' data-pr-rank="' + (i + 1) + '">'
        + '<div class="pr-hot-top">'
        + '<span class="pr-rank' + (i < 3 ? ' hot' : '') + '">' + (i + 1) + '</span>'
        + '<a href="' + esc(h.url || '#') + '" target="_blank" rel="noopener noreferrer">'
        + esc(h.name || '') + '</a>'
        + '<span class="pr-tag">' + esc(h.category || '其他') + '</span>'
        + '</div>'
        + '<div class="pr-hot-meta">'
        + '<span class="pr-stars">★ ' + num(h.stars) + '</span>'
        + '<span class="pr-gain">日均 +' + num(hotGain(h)) + '</span>'
        + '<span>' + esc(hotFacts(h)) + '</span>'
        + '<span class="pr-open ' + (TONE[h.openness] || 'muted') + '">' + esc(h.openness || '') + '</span>'
        + '</div>'
        + '<p class="pr-hot-sum">' + esc(h.summary || '（无简介）') + '</p>'
        + (h.biz ? '<p class="pr-hot-biz"><b>商业价值</b>' + esc(h.biz) + '</p>' : '')
        + '<div class="pr-hot-foot">'
        /* 只显示状态，不给按钮 —— 这个页面是只读展示，收进由运维侧定时任务负责 */
        + (owned ? '<span class="pr-owned">✓ 已收录</span>'
                 : '<span class="pr-unowned">待收录</span>')
        + '</div></article>';
    }).join('') + '</div>';

    var basis = hotSort === 'gain'
      ? '按日均升星排序：日榜项取日增，只有周榜数据的按「周增 ÷ 7」折算成日均'
        + '（两个榜量纲不同，不折算的话周榜项会永远碾压日榜项）。'
      : '按总 Star 数排序：看存量不看热度，这是一张家底榜。';
    box.innerHTML = head + body + '<p class="pr-hot-more">' + esc(basis)
      + ' 排名每天随上游榜单变化。</p>';
  }

  function fetchHot() {
    if (typeof global.fetch !== 'function') { hot = { updated_at: '', items: [] }; hotErr = '浏览器不支持 fetch'; renderHot(); return; }
    global.fetch(HOT_URL, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var arr = (j && Array.isArray(j.items)) ? j.items : [];
      // 先按综合热度排一遍：hotRank() 是稳定排序，主键相等时就会落到这个顺序上
      arr = arr.filter(function (h) { return h && (h.url || h.name); })
               .sort(function (a, b) { return hotHeat(b) - hotHeat(a); });
      hot = { updated_at: (j && j.updated_at) || '', items: arr };
      hotErr = '';
      renderHot();
      renderView();      // 榜单条数写在切换按钮上，数据到了要顺手更新
    }).catch(function () {
      // 离线 / 资源缺失都不该让模块报错，只是这块空着
      hot = { updated_at: '', items: [] };
      hotErr = '离线或数据文件缺失';
      renderHot();
      renderView();
    });
  }

  /* ---------- Excel 导出 ----------
     ⚠️ 导出的是 COLS 那 8 列（与历史 Excel 模板逐列一致），不是页面上的 7 列。
        页面列是给人看的，导出列是给下游表格吃的 —— 两套列不是一回事，别互相改。 */
  function colWidths() {
    return COLS.map(function (c) { return { wch: c.k === 'summary' ? 52 : (c.k === 'note' ? 26 : 15) }; });
  }

  function sheetFromRows(rows) {
    var aoa = [COLS.map(function (c) { return c.t; })].concat(rows.map(rowToArray));
    var ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = colWidths();
    return ws;
  }

  function fileName(ext) {
    var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
    return 'FluxDesk_收录项目_' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '.' + ext;
  }

  function exportXlsx(rows, label) {
    rows = rows || visible();
    if (!rows.length) { toast('当前没有可导出的项目。'); return; }
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), '收录项目');
    XLSX.writeFile(wb, fileName('xlsx'));
    toast('已导出' + (label ? label + ' ' : '') + rows.length + ' 个项目。');
  }

  function toast(text) {
    /* ★★ 必须用 `typeof ... === 'function'` 判，不能写成 `if (global.X)`：
       页面里存在 `<div class="toast" id="toast">`，浏览器会把带 id 的元素自动挂成
       同名全局变量 ⇒ `global.toast` 恒为真，但它是个 **DOM 元素不是函数**，
       调用即 "global.toast is not a function"。
       所以：① 类型判；② 优先用 app.js 暴露的 window.FluxToast（样式统一）。 */
    if (typeof global.FluxToast === 'function') { global.FluxToast(text); return; }
    if (typeof global.toast === 'function') { global.toast('info', text); return; }
    var el = $('[data-pr-toast]');
    if (!el) return;                      // 兜底路径也不能因为缺元素就抛
    el.textContent = text;
    el.classList.add('on');
    clearTimeout(toast.t);
    toast.t = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  /* ---------- 筛选控件 ---------- */
  function readFilters() {
    f.q = $('[data-pr-q]').value.trim();
    f.cat = $('[data-pr-cat]').value;
    f.open = $('[data-pr-open]').value;
    f.from = $('[data-pr-from]').value;
    f.to = $('[data-pr-to]').value;
    f.minStars = $('[data-pr-min]').value;
  }

  function resetFilterInputs() {
    $('[data-pr-q]').value = '';
    $('[data-pr-cat]').value = '';
    $('[data-pr-open]').value = '';
    $('[data-pr-from]').value = '';
    $('[data-pr-to]').value = '';
    $('[data-pr-min]').value = '';
    f = { q: '', cat: '', open: '', from: '', to: '', minStars: '' };
  }

  function options(list, all) {
    return '<option value="">' + all + '</option>' + list.map(function (x) {
      return '<option value="' + esc(x) + '">' + esc(x) + '</option>';
    }).join('');
  }

  /* ---------- 骨架 ---------- */
  function skeleton() {
    return ''
      + '<div class="pr-heading">'
      + '<div><small>GITHUB COLLECTION · 公开</small><h1>收录项目</h1>'
      + '<p>把收集到的开源项目建档、归类、筛选，随时导出成 Excel 归档或带走。'
      + '内容全站公开，无需登录即可查看。</p>'
      + '<div class="pr-state" data-pr-state="loading">正在读取…</div></div>'
      /* ★ 导出条常驻右上角动作区。
         它原来挂在 22 行表格**下面**的工具栏里 ⇒ 不滚到底根本看不见，
         用户直接来问"导出按钮去哪儿了"（2026-10-04）。
         动作就该待在动作区：和「刷新数据」并排，任何滚动位置都够得着。
         表格下方只保留计数文字，不再重复放一份按钮（单一出口，不给自己留两套口径）。 */
      + '<div class="pr-actions">'
      + '<span class="pr-export-row" data-pr-export-row></span>'
      + '<button class="btn" type="button" data-pr-refresh>刷新数据</button>'
      + '</div></div>'
      /* 视图切换：两个按钮，计数写在按钮上。默认「收录项目」——
         这才是这个模块的主视图（热点榜是每天变化的行情面）。 */
      + '<div class="pr-views" role="tablist">'
      + '<button class="pr-view-btn active" type="button" data-pr-view="all" role="tab">'
      + '<span class="nav-glyph">▤</span>收录项目 <u>0</u></button>'
      + '<button class="pr-view-btn" type="button" data-pr-view="hot" role="tab">'
      + '<span class="nav-glyph">★</span>热点榜 <u>—</u></button>'
      + '</div>'
      + '<section class="pr-pane" data-pr-pane="all">'
      + '<section class="pr-stats" data-pr-stats></section>'
      + '<div class="pr-panel">'
      + '<div class="pr-bars" data-pr-bars></div>'
      + '<div class="pr-filters">'
      + '<div><label for="prQ">关键词</label><input id="prQ" type="search" data-pr-q placeholder="名称 / 简介 / 地址"></div>'
      + '<div><label for="prCat">项目类别</label><select id="prCat" data-pr-cat>' + options(CATS, '全部类别') + '</select></div>'
      + '<div><label for="prOpen">开源程度</label><select id="prOpen" data-pr-open>' + options(OPEN, '全部程度') + '</select></div>'
      + '<div><label for="prFrom">入库日期 从</label><input id="prFrom" type="date" data-pr-from></div>'
      + '<div><label for="prTo">到</label><input id="prTo" type="date" data-pr-to></div>'
      + '<div><label for="prMin">Star 数 ≥</label><input id="prMin" type="number" min="0" step="100" data-pr-min placeholder="0"></div>'
      + '<button class="pr-reset" type="button" data-pr-reset>重置</button>'
      + '</div>'
      + '<div class="pr-scroll"><table class="pr-table">'
      + '<colgroup><col class="c-no"/><col class="c-date"/><col class="c-name"/><col class="c-cat"/>'
      + '<col class="c-sum"/><col class="c-open"/><col class="c-star"/></colgroup>'
      + '<thead><tr>'
      + '<th>#</th><th>入库日期</th><th>项目</th><th>类别</th><th>项目简介</th><th>开源程度</th>'
      + '<th style="text-align:right">Star</th>'
      + '</tr></thead><tbody data-pr-body></tbody></table></div>'
      /* 计数 + 导出条曾经同一行；导出按钮已移到右上角动作区，这里只留计数
         （「导的是哪一批」由按钮自己写明白，不需要在这里再复述一遍）。 */
      + '<div class="pr-toolbar"><p class="pr-note" data-pr-count></p></div>'
      + '</div>'
      + '<p class="pr-note">数据保存在云数据库，读权限对所有人开放（含未登录访客），'
      + '由运维侧的定时任务更新。列表按最近更新时间倒序排列，即"更新顺序"。</p>'
      + '</section>'
      + '<section class="pr-pane" data-pr-pane="hot" hidden>'
      + '<section class="pr-hot" data-pr-hot></section>'
      + '</section>'
      + '<div class="pr-note" data-pr-toast style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 18px;border:1px solid var(--border2);border-radius:10px;background:var(--panel2);color:var(--text);opacity:0;pointer-events:none;transition:opacity .2s"></div>';
  }

  /* ---------- 事件（全部委托在 root 上，重绘不用重绑） ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-pr-refresh],[data-pr-export],[data-pr-export-all],'
      + '[data-pr-reset],[data-pr-bar],[data-pr-view],[data-pr-sort]');
    if (!t) return;
    if (t.hasAttribute('data-pr-view')) {
      var v = t.getAttribute('data-pr-view');
      if (VIEWS.indexOf(v) >= 0) { view = v; renderView(); }
      return;
    }
    if (t.hasAttribute('data-pr-sort')) {
      var s = t.getAttribute('data-pr-sort');
      if (SORT_LABEL[s]) { hotSort = s; renderHot(); }
      return;
    }
    if (t.hasAttribute('data-pr-refresh')) return refresh();
    if (t.hasAttribute('data-pr-export-all')) return exportXlsx(sortRows(items), '全部');
    if (t.hasAttribute('data-pr-export')) return exportXlsx();
    if (t.hasAttribute('data-pr-reset')) { resetFilterInputs(); return render(); }
    if (t.hasAttribute('data-pr-bar')) {
      var k = t.getAttribute('data-pr-bar');
      f.cat = f.cat === k ? '' : k;
      $('[data-pr-cat]').value = f.cat;
      return render();
    }
  }

  function onFilter() { readFilters(); render(); }

  function onChange(e) {
    if (e.target.closest && e.target.closest('.pr-filters')) onFilter();
  }

  /* ---------- 生命周期 ---------- */
  function refresh() {
    var btn = $('[data-pr-refresh]');
    if (btn) btn.disabled = true;
    fetchHot();
    /* 顺序与 open() 一致：先 load()（内部 pending++），再写状态位 ——
       否则 setState('loading') 会被随后的 render() 用 empty 覆盖回去。 */
    var p = load();
    setState('loading');
    p.then(function () {
      render();
      if (loadErr) toast('读取失败：' + loadErr);
      if (btn) btn.disabled = false;
    });
  }

  function setState(state) {
    var el = $('[data-pr-state]');
    if (!el) return;
    el.setAttribute('data-pr-state', state);
    el.className = 'pr-state ' + state;
    el.textContent = state === 'loading' ? '正在读取…' : el.textContent;
  }

  function open(node) {
    if (active) close();
    root = node;
    active = true;
    root.innerHTML = skeleton();
    resetFilterInputs();
    items = [];
    hot = null;        // 每次重开都重新拉热点（榜单每天变）
    loadErr = '';
    view = 'all';      // 每次打开都落在「收录项目」——展示页的主角是收录内容
    hotSort = 'gain';
    /* ⚠️ 顺序不能反：先 load()（内部 pending++ 落在微任务之前），再 render()。
       反过来的话首帧状态位会是 empty 而不是 loading（renderState 注释里有完整踩坑记录）。 */
    var p = load();
    render();          // 先铺骨架，别让用户对着白屏等
    renderHot();
    fetchHot();

    p.then(function () {
      render();
      if (loadErr) toast('读取失败：' + loadErr);
    });

    root.addEventListener('click', onClick);
    root.addEventListener('input', onFilter);
    root.addEventListener('change', onChange);
  }

  function close() {
    if (!root) return;
    active = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onFilter);
    root.removeEventListener('change', onChange);
    root.innerHTML = '';
    root = null;
    items = [];
  }

  window.ProjectsDesk = {
    open: open,
    close: close,
    count: function () { return items.length; },
    _pure: PURE
  };
}(typeof window !== 'undefined' ? window : globalThis));
