/* ==========================================================================
   GitHub 项目收藏（Project Library）—— 运营方独占 · 云端存储
   ---------------------------------------------------------------------------
   把从 GitHub 上收集到的项目建档、分类、筛选、导出。
   Excel 读写复用页面已引入的 SheetJS（XLSX），不新增依赖。

   ★ 数据存在云数据库 public.projects，不在 localStorage。
     版本历史：2026-10-03 之前是纯 localStorage（fluxdesk_projects_v1:<userId>），
     换设备就丢、且每个用户各存一份。现改为服务端存储，老数据会**一次性自动搬迁**
     （见 migrateLocal()）。
   ★ 权限：整张表由 migrations/003_projects.sql 的 projects_operator_all 策略收死成
     「仅 operators 名单内可读写」。前端把导航项藏起来只是体验，真正的门在 RLS ——
     非运营方手工构造 REST 请求也只会拿到 0 行。

   对外接口：window.ProjectsDesk.open(node, userId) / .close()
   数据契约（也是 Excel 模板的表头顺序）见 COLS —— 改这里等于改模板契约。
   改字段集必须同步改三处：本文件 COLS、migrations/003_projects.sql 的建表、
   check_projects.js 的断言。
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

  function field(row, keys) {
    for (var i = 0; i < keys.length; i++) {
      for (var j = 0; j < Object.keys(row).length; j++) {
        var k = Object.keys(row)[j];
        if (String(k).replace(/\s/g, '') === keys[i].replace(/\s/g, '')) {
          var v = row[k];
          if (v !== null && v !== undefined && String(v).trim() !== '') return v;
        }
      }
    }
    return '';
  }

  // Excel 行 → 数据项。表头容错：带不带空格、用不用别名都能认。
  function rowFromExcel(row) {
    return {
      added_at: toDate(field(row, ['入库日期', '日期', 'added_at'])),
      name: String(field(row, ['项目名称', '名称', '项目', 'name']) || '').trim(),
      url: String(field(row, ['仓库地址', '地址', '链接', 'url']) || '').trim(),
      category: String(field(row, ['项目类别', '类别', '分类', 'category']) || '').trim(),
      summary: String(field(row, ['项目简介', '简介', '说明', 'summary']) || '').trim(),
      openness: String(field(row, ['开源程度', '开源', 'openness']) || '').trim(),
      stars: toStars(field(row, ['Star 数', 'Star数', 'star', 'stars', '星标'])),
      note: String(field(row, ['备注', 'note']) || '').trim()
    };
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

  /* ---------- 数据库字段集（单一事实来源） ----------
     ★ 插入与更新都走这一个函数，绝不在调用处另写一份字段表 ——
       字段表抄两遍必然漂移，而漂移的后果是"某一列永远存不进去"。
     ★ 这里**永远不能出现身份列**（owner_id / created_by）：
       身份交给列的 DEFAULT auth.uid()，客户端自报身份既不可信也会被 RLS 拒。
       同理 update 里也不放 created_at。
     ★ 也不要传 null 去"触发默认值" —— 显式 null 会覆盖 DEFAULT，反而被 RLS 拒。
       （平台文档明确写了这条，见 cloud-service/references/database/code-generation.md）
     check_projects.js 会断言本函数的键集：既不含身份列，也不缺业务列。 */
  var IDENTITY_COLS = ['owner_id', 'created_by', 'user_id'];

  function fieldsOf(it, now) {
    return {
      added_at: toDate(it && it.added_at) || today(),
      name: String((it && it.name) || '').trim(),
      url: String((it && it.url) || '').trim(),
      category: String((it && it.category) || '').trim() || '其他',
      summary: String((it && it.summary) || '').trim(),
      openness: String((it && it.openness) || '').trim() || '源码可见',
      stars: toStars(it && it.stars),
      note: String((it && it.note) || '').trim(),
      updated_at: now || new Date().toISOString()
    };
  }

  var PURE = { COLS: COLS, toDate: toDate, toStars: toStars, rowFromExcel: rowFromExcel,
    rowToArray: rowToArray, matchItem: matchItem, today: today,
    fieldsOf: fieldsOf, IDENTITY_COLS: IDENTITY_COLS };

  /* ---------- 热点推荐（服务端数据源 → 可一键收进个人库） ----------
     数据由 build/refresh_hot.py 每晚生成，作为静态资源放在 /assets/hot-projects.json。
     为什么不直接写进 localStorage：这是**只读的公共情报**，不该每天自动污染个人库；
     收进与否由人决定（收进后即可编辑/导出/纳入筛选）。
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

  // 热点项 → 库里那套字段（收进时直接用）
  function hotToRow(h) {
    return {
      added_at: toDate(h && h.found_at) || today(),
      name: String((h && h.name) || '').trim(),
      url: String((h && h.url) || '').trim(),
      category: String((h && h.category) || '').trim() || '其他',
      summary: String((h && h.summary) || '').trim(),
      openness: String((h && h.openness) || '').trim() || '源码可见',
      stars: toStars(h && h.stars),
      note: String((h && h.note) || '热点推荐').trim()
    };
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

  // 去重键：地址优先，其次名称（与 Excel 导入同一口径）
  function depKey(o) { return String((o && (o.url || o.name)) || '').toLowerCase(); }

  function hotFresh(list, owned) {
    var seen = {};
    (owned || []).forEach(function (it) { var k = depKey(it); if (k) seen[k] = 1; });
    return (list || []).filter(function (h) {
      var k = depKey(h);
      // 没有 key 的脏项直接丢：既无法去重，也不该被收进库（与 Excel 导入同一口径）
      return k && !seen[k];
    });
  }

  PURE.HOT_URL = HOT_URL;
  PURE.hotHeat = hotHeat;
  PURE.hotGain = hotGain;
  PURE.hotRank = hotRank;
  PURE.hotToRow = hotToRow;
  PURE.hotFacts = hotFacts;
  PURE.hotFresh = hotFresh;
  PURE.depKey = depKey;

  if (typeof module === 'object' && module.exports) { module.exports = PURE; return; }

  /* ---------- 运行时状态 ---------- */
  var root = null, user = '', items = [], active = false;
  var f = { q: '', cat: '', open: '', from: '', to: '', minStars: '' };
  var editingId = null;
  var hot = null, hotErr = '';   // hot=null 表示还没拉过（成功/失败都会落地）
  /* 两个视图（2026-10-04）：个人库与热点榜互不遮挡。
     改之前是「热点卡片压在库表格上方、默认只铺 6 张」—— 用户想找自己收录的东西得先
     滚过热点区，反过来想看榜单又只能看到 6 条，两头别扭。拆成两个视图后，
     各自都能铺满：库视图是主视图（默认），热点榜铺全部 20 条并给排名。 */
  var VIEWS = ['lib', 'hot'];
  var view = 'lib';
  // 榜单口径：gain=升星速度（日均），stars=总星数。默认升星，那才是"热点"。
  var hotSort = 'gain';

  function $(sel) { return root.querySelector(sel); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function uid() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

  /* ---------- 持久化：云数据库 public.projects（运营方独占） ----------
     权限边界见 migrations/003_projects.sql 的 projects_operator_all：
     读 / 增 / 改 / 删四个动作全部要求 auth.uid() 出现在 operators 名单里。
     ⇒ 这里**不需要**自己 .eq('owner_id', ...)，RLS 已经把别人的行过滤掉了。

     ★ 关键陷阱：RLS 的拒绝是**静默**的 —— 不报错、只返回空行集。
       所以每个写操作之后都必须显式检查返回行数，否则"被拦下"会被当成"成功"，
       用户看到"已入库"但刷新后什么都没了。（平台文档原话：
       "An empty result array means RLS blocked the write — not that it succeeded."） */

  var TABLE = 'projects';
  var LS_KEY = 'fluxdesk_projects_v1:';           // 旧版本地键，仅用于一次性搬迁
  var MIG_KEY = 'fluxdesk_projects_migrated_v1';  // 搬迁完成标记
  var loadErr = '';                               // 读取失败原因，渲染成顶部红条

  function api() {
    return (global.cloud && global.cloud.database) ? global.cloud.database : null;
  }

  // SDK 报错 → 能照着做的中文（不要把 traceback 甩给用户）
  function dbErr(e) {
    var m = (e && e.message) ? String(e.message) : String(e || '未知错误');
    if (/42501|permission denied|row-level security/i.test(m)) return '没有权限：该功能仅管理员可用';
    if (/401|not authenticated|jwt|token/i.test(m)) return '登录已过期，请刷新页面重新登录';
    if (/failed to fetch|network|load failed/i.test(m)) return '网络不通，请检查网络后重试';
    return m;
  }

  // 写操作的统一收口：把"静默被拒"变成显式错误
  function assertWrote(r, what) {
    if (r && r.error) throw r.error;
    var n = (r && Array.isArray(r.data)) ? r.data.length : 0;
    if (!n) throw new Error(what + '未生效（没有权限，或记录已被删除）');
    return r.data;
  }

  function load() {
    var a = api();
    if (!a) { loadErr = '云服务未就绪'; return Promise.resolve(); }
    return a.from(TABLE).select('*').order('added_at', { ascending: false }).limit(1000)
      .then(function (r) {
        if (r.error) throw r.error;
        items = (r.data || []).map(normalize);
        loadErr = '';
      })
      .catch(function (e) { items = []; loadErr = dbErr(e); });
  }

  function insertRows(rows) {
    var a = api();
    if (!a) return Promise.reject(new Error('云服务未就绪'));
    var now = new Date().toISOString();
    // 用 map 逐行套 fieldsOf()，而不是在这里再写一份字段表（见 fieldsOf 的注释）
    return a.from(TABLE).insert(rows.map(function (it) {
      var o = fieldsOf(it, now);
      o.id = it.id;      // id 由前端生成，作为主键（也是 Excel 重复导入时的 upsert 锚点）
      return o;
    })).select();
  }

  function updateRow(id, it) {
    var a = api();
    if (!a) return Promise.reject(new Error('云服务未就绪'));
    return a.from(TABLE).update(fieldsOf(it)).eq('id', id).select();
  }

  // Excel 重复导入时用 upsert：主键就是前端 id，所以"同一份表再导一次"是个幂等覆盖，
  // 而不是每导一次多一批重复行。一次请求写完，不逐行打圈。
  function upsertRows(rows) {
    var a = api();
    if (!a) return Promise.reject(new Error('云服务未就绪'));
    var now = new Date().toISOString();
    return a.from(TABLE).upsert(rows.map(function (it) {
      var o = fieldsOf(it, now);
      o.id = it.id;
      return o;
    })).select();
  }

  function deleteRow(id) {
    var a = api();
    if (!a) return Promise.reject(new Error('云服务未就绪'));
    return a.from(TABLE).delete().eq('id', id).select();
  }

  // 一次性搬迁：把旧版本的 localStorage 数据搬进云库。
  // 只在「没搬过 + 本地确实有数据」时动手；云库已有数据时不搬（由 open() 判断），
  // 避免把本地那份陈旧副本盖到云端。搬失败不打扰用户，下次再说。
  function migrateLocal() {
    var a = api();
    if (!a) return Promise.resolve(0);
    var raw = null;
    try {
      if (localStorage.getItem(MIG_KEY)) return Promise.resolve(0);
      raw = localStorage.getItem(LS_KEY + (user || 'anon'));
    } catch (e) { return Promise.resolve(0); }
    var rows = null;
    try { rows = JSON.parse(raw); } catch (e) { rows = null; }
    if (!Array.isArray(rows) || !rows.length) {
      try { localStorage.setItem(MIG_KEY, '1'); } catch (e) {}
      return Promise.resolve(0);
    }
    return insertRows(rows.map(normalize)).then(function (r) {
      var data = assertWrote(r, '搬迁本地数据');
      try { localStorage.setItem(MIG_KEY, '1'); } catch (e) {}
      return data.length;
    }).catch(function () { return 0; });
  }

  function normalize(it) {
    var o = { id: it && it.id ? String(it.id) : uid() };
    COLS.forEach(function (c) {
      o[c.k] = c.k === 'stars' ? toStars(it && it[c.k]) : String((it && it[c.k]) || '').trim();
    });
    o.added_at = toDate(o.added_at) || today();
    return o;
  }

  /* ---------- 选择 ---------- */
  // 排序口径只有一处：入库日期倒序，同日按 Star 降序。
  // 库表格与「导出全部」共用它，免得两条路径排出两种顺序。
  function sortRows(list) {
    return list.slice().sort(function (a, b) {
      if (a.added_at !== b.added_at) return a.added_at < b.added_at ? 1 : -1;
      return Number(b.stars) - Number(a.stars);
    });
  }

  function visible() {
    return sortRows(items.filter(function (it) { return matchItem(it, f); }));
  }

  /* ---------- 渲染 ---------- */
  function num(n) { return Number(n || 0).toLocaleString('zh-CN'); }

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
     全量导出单独给一个按钮，而不是靠"先点重置再导出"这种口头约定。 */
  function renderExportBar(rows) {
    var box = $('[data-pr-export-row]');
    if (!box) return;
    var filtered = rows.length !== items.length;
    var html = '<button class="btn" type="button" data-pr-export>导出当前 ' + rows.length + ' 条</button>';
    if (filtered) {
      html += '<button class="pr-rowbtn" type="button" data-pr-export-all>导出全部 '
        + items.length + ' 条</button>';
    }
    box.innerHTML = html;
  }

  function renderTable() {
    var rows = visible();
    var box = $('[data-pr-body]');
    $('[data-pr-count]').textContent = rows.length === items.length
      ? ('共 ' + items.length + ' 个项目')
      : ('筛选出 ' + rows.length + ' / ' + items.length + ' 个项目');
    renderExportBar(rows);

    if (!rows.length) {
      box.innerHTML = '<tr><td colspan="' + (COLS.length + 1) + '"><div class="pr-empty">'
        + (items.length
          ? '<b>没有符合条件的项目</b>放宽筛选条件，或点右侧「重置」。'
          : '<b>项目库还是空的</b>先「下载模板」按格式填好，再「导入 Excel」批量入库；也可以直接「新增项目」。')
        + '</div></td></tr>';
      return;
    }

    box.innerHTML = rows.map(function (it) {
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
        + '<td class="pr-date">' + esc(it.added_at) + '</td>'
        + '<td class="pr-name">' + link + meta + '</td>'
        + '<td><span class="pr-tag">' + esc(it.category || '未分类') + '</span></td>'
        + '<td class="pr-summary"><p>' + esc(it.summary || '—') + '</p></td>'
        + '<td><span class="pr-open ' + tone + '">' + esc(it.openness || '未标注') + '</span></td>'
        + '<td class="pr-stars">' + num(it.stars) + '</td>'
        + '<td><button class="pr-rowbtn" type="button" data-pr-edit="' + esc(it.id) + '">编辑</button> '
        + '<button class="pr-rowbtn danger" type="button" data-pr-del="' + esc(it.id) + '">删除</button></td>'
        + '</tr>';
    }).join('');
  }

  /* ---------- 视图切换（我的库 / 热点榜） ----------
     只切可见性 + 按钮态：两个视图各自的数据源独立（库=云表，榜=静态 JSON），
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
        u.textContent = (k === 'lib')
          ? String(items.length)
          : (hot && hot.items ? String(hot.items.length) : '—');
      }
    }
  }

  function render() { renderView(); renderStats(); renderBars(); renderTable(); }

  /* ---------- 热点榜：排名 / 渲染 / 收进 ----------
     榜就该有榜的样子：① 有排名号；② 排序口径写在界面上而不是藏在代码里；
     ③ 两个口径各自成榜，由用户选。 */
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
        + (hotErr ? '热点数据没读到（' + esc(hotErr) + '）。不影响个人库的使用。'
                  : '热点数据为空。跑 <code>python build/refresh_hot.py</code> 生成。')
        + '</div>';
      return;
    }
    var fresh = hotFresh(list, items);
    var ranked = hotRank(list, hotSort);
    var head = '<div class="pr-hot-head">'
      + '<div><small>TRENDING ON GITHUB</small><b>热点榜</b>'
      + '<em>更新于 ' + esc(hot.updated_at || '—') + ' · 共 ' + list.length + ' 个'
      + (fresh.length ? ' · 其中 <u>' + fresh.length + '</u> 个尚未收进' : ' · 已全部收进') + '</em></div>'
      + '<div class="pr-hot-act">'
      + '<div class="pr-rank-tabs" data-pr-rank-tabs>' + tabBtn('gain') + tabBtn('stars') + '</div>'
      + '<button class="btn sm" type="button" data-pr-adopt-all' + (fresh.length ? '' : ' disabled') + '>'
      + '全部收进' + (fresh.length ? '（' + fresh.length + '）' : '') + '</button>'
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
        + (owned
          ? '<span class="pr-owned">✓ 已在个人库</span>'
          : '<button class="pr-rowbtn" type="button" data-pr-adopt="' + (list.indexOf(h)) + '">收进我的库</button>')
        + '</div></article>';
    }).join('') + '</div>';

    var basis = hotSort === 'gain'
      ? '按日均升星排序：日榜项取日增，只有周榜数据的按「周增 ÷ 7」折算成日均'
        + '（两个榜量纲不同，不折算的话周榜项会永远碾压日榜项）。'
      : '按总 Star 数排序：看存量不看热度，这是一张家底榜。';
    box.innerHTML = head + body + '<p class="pr-hot-more">' + esc(basis)
      + ' 排名每天随上游榜单变化。</p>';
  }

  // 收进：按 depKey 去重（与 Excel 导入同一口径），已存在则跳过。
  // 云端写入 —— 先写成功再刷新本地，不做乐观更新（这个模块写入频率低，
  // 省掉"回滚"那套状态机，代价只是几百毫秒的等待，换来的是界面永远不会骗人）。
  function adopt(list) {
    var owned = {};
    items.forEach(function (it) { owned[depKey(it)] = 1; });
    var fresh = [], skip = 0;
    list.forEach(function (h) {
      var row = normalize(hotToRow(h));
      var k = depKey(row);
      if (!k || owned[k]) { skip++; return; }
      owned[k] = 1;
      fresh.push(row);
    });
    if (!fresh.length) { toast('这些都已经在你的库里了。'); return; }

    setSync('loading', '正在写入云端…');
    insertRows(fresh).then(function (r) {
      assertWrote(r, '收进我的库');
      return load();
    }).then(function () {
      if (loadErr) throw new Error(loadErr);
      setSync('ready', '已同步到云端 · ' + items.length + ' 个项目');
      render(); renderHot();
      toast('已收进 ' + fresh.length + ' 个' + (skip ? '，跳过 ' + skip + ' 个已在库的' : '') + '。');
    }).catch(function (e) {
      setSync('error', '写入失败');
      toast('收进失败：' + dbErr(e));
    });
  }

  function fetchHot() {
    if (typeof global.fetch !== 'function') { hot = { updated_at: '', items: [] }; hotErr = '浏览器不支持 fetch'; renderHot(); return; }
    global.fetch(HOT_URL, { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    }).then(function (j) {
      var arr = (j && Array.isArray(j.items)) ? j.items : [];
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

  /* ---------- 编辑 ---------- */
  function openEditor(id) {
    editingId = id || null;
    var it = id ? items.filter(function (x) { return x.id === id; })[0] : null;
    var dlg = $('[data-pr-dialog]');
    $('[data-pr-dlg-title]').textContent = it ? '编辑项目' : '新增项目';
    $('[data-pr-f-name]').value = it ? it.name : '';
    $('[data-pr-f-url]').value = it ? it.url : '';
    $('[data-pr-f-date]').value = (it && it.added_at) || today();
    $('[data-pr-f-stars]').value = it ? it.stars : '';
    $('[data-pr-f-summary]').value = it ? it.summary : '';
    $('[data-pr-f-note]').value = it ? it.note : '';
    $('[data-pr-f-cat]').value = (it && it.category) || CATS[0];
    $('[data-pr-f-open]').value = (it && it.openness) || OPEN[0];
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
  }

  function submitEditor() {
    var name = $('[data-pr-f-name]').value.trim();
    var url = $('[data-pr-f-url]').value.trim();
    if (!name && !url) { toast('请至少填写项目名称或仓库地址。'); return; }
    var patch = {
      added_at: toDate($('[data-pr-f-date]').value) || today(),
      name: name,
      url: url,
      category: $('[data-pr-f-cat]').value.trim() || '其他',
      summary: $('[data-pr-f-summary]').value.trim(),
      openness: $('[data-pr-f-open]').value.trim(),
      stars: toStars($('[data-pr-f-stars]').value),
      note: $('[data-pr-f-note]').value.trim()
    };
    var editing = editingId;
    var row = normalize(Object.assign({ id: editing || uid() }, patch));
    var btn = $('[data-pr-save]');
    if (btn) btn.disabled = true;
    setSync('loading', editing ? '正在保存…' : '正在入库…');

    (editing ? updateRow(editing, row) : insertRows([row]))
      .then(function (r) {
        assertWrote(r, editing ? '保存' : '入库');
        return load();
      })
      .then(function () {
        if (loadErr) throw new Error(loadErr);
        closeEditor();
        syncReady();
        render();
        toast(editing ? '已更新。' : '已入库。');
      })
      .catch(function (e) {
        setSync('error', '写入失败');
        toast('保存失败：' + dbErr(e));
      })
      .then(function () { if (btn) btn.disabled = false; });
  }

  function closeEditor() {
    editingId = null;
    var dlg = $('[data-pr-dialog]');
    if (typeof dlg.close === 'function') dlg.close(); else dlg.removeAttribute('open');
  }

  function removeItem(id) {
    var it = items.filter(function (x) { return x.id === id; })[0];
    if (!it) return;
    if (!global.confirm('删除「' + (it.name || it.url) + '」？此操作不可撤销。')) return;
    setSync('loading', '正在删除…');
    deleteRow(id).then(function (r) {
      assertWrote(r, '删除');
      return load();
    }).then(function () {
      if (loadErr) throw new Error(loadErr);
      syncReady(); render();
      toast('已删除。');
    }).catch(function (e) {
      setSync('error', '删除失败');
      toast('删除失败：' + dbErr(e));
    });
  }

  /* ---------- 同步状态条 ----------
     让"数据在云端"这件事在界面上可见：读写中 / 已同步 / 失败。
     同时它也是**验收锚点** —— 探针靠 [data-pr-sync-state] 等异步落定，
     固定 sleep 会读到中间态（本项目在热点推荐上已经吃过一次假红）。 */
  function setSync(state, text) {
    var el = $('[data-pr-sync]');
    if (!el) return;
    el.setAttribute('data-pr-sync-state', state);
    el.textContent = text;
    el.className = 'pr-sync ' + state;
  }

  function syncReady() {
    setSync(items.length ? 'ready' : 'empty',
      items.length ? ('已同步到云端 · ' + items.length + ' 个项目') : '云端暂无数据，新增即自动保存');
  }

  function toast(text) {
    /* ★★ 必须用 `typeof ... === 'function'` 判，不能写成 `if (global.X)`：
       页面里存在 `<div class="toast" id="toast">`，浏览器会把带 id 的元素自动挂成
       同名全局变量 ⇒ `global.toast` 恒为真，但它是个 **DOM 元素不是函数**，
       调用即 "global.toast is not a function"。
       而这个 toast 大量出现在 .then 链里，一抛就把整条链打断 ——
       症状极具迷惑性：**数据其实已经写进服务端了，界面却停在旧状态**
       （2026-10-03 实测：?fresh=1 搬迁成功 14 条，界面仍是"项目库还是空的"）。
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

  /* ---------- Excel ---------- */
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
    return 'FluxDesk_项目库_' + d.getFullYear() + z(d.getMonth() + 1) + z(d.getDate()) + '.' + ext;
  }

  function exportXlsx(rows, label) {
    rows = rows || visible();
    if (!rows.length) { toast('当前没有可导出的项目。'); return; }
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheetFromRows(rows), '项目库');
    XLSX.writeFile(wb, fileName('xlsx'));
    toast('已导出' + (label ? label + ' ' : '') + rows.length + ' 个项目。');
  }

  function downloadTemplate() {
    var wb = XLSX.utils.book_new();

    var demo = [
      { added_at: today(), name: 'openai/whisper', url: 'https://github.com/openai/whisper',
        category: 'AI / LLM', summary: '通用语音识别模型，多语种、鲁棒性好，适合做会议与录音转写。',
        openness: '完全开源', stars: 74000, note: '示例行，导入前请删除' },
      { added_at: today(), name: 'obsidianmd/obsidian-releases', url: 'https://github.com/obsidianmd/obsidian-releases',
        category: '文档知识库', summary: '本地优先的双链笔记工具，插件生态丰富，适合搭建个人知识库。',
        openness: '源码可见', stars: 9200, note: '示例行，导入前请删除' }
    ];
    var ws = sheetFromRows(demo);
    ws['!rows'] = [{}, { hpt: 30 }, { hpt: 30 }];
    XLSX.utils.book_append_sheet(wb, ws, '项目库');

    var help = [
      ['字段', '是否必填', '填写说明'],
      ['入库日期', '建议', '格式 YYYY-MM-DD，例如 2026-10-03。留空则按导入当天计。'],
      ['项目名称', '至少填一项', '建议用「作者/仓库名」，例如 openai/whisper。'],
      ['仓库地址', '至少填一项', '完整的 GitHub 链接。导入时以此列去重：地址相同则更新原记录。'],
      ['项目类别', '建议', '参考取值：' + CATS.join('、') + '。也可自行填写新类别。'],
      ['项目简介', '建议', '一两句话说清「它是干什么的、好在哪」，便于日后检索。'],
      ['开源程度', '建议', '参考取值：' + OPEN.join('、') + '。'],
      ['Star 数', '建议', '只填数字，不要带逗号或「k」。记录的是截至入库时的快照。'],
      ['备注', '选填', '你自己的使用心得、待办、关联项目等。'],
      ['', '', ''],
      ['导入规则', '', '按「仓库地址」去重（无地址时按项目名称）。已存在的记录会被覆盖更新，其余追加。'],
      ['导出规则', '', '导出的是「当前筛选结果」，不是全量。想导全量请先点重置。']
    ];
    var wsHelp = XLSX.utils.aoa_to_sheet(help);
    wsHelp['!cols'] = [{ wch: 14 }, { wch: 14 }, { wch: 78 }];
    XLSX.utils.book_append_sheet(wb, wsHelp, '填写说明');

    XLSX.writeFile(wb, 'FluxDesk_项目库_模板.xlsx');
    toast('模板已下载，填好后用「导入 Excel」送回。');
  }

  function importXlsx(file) {
    var reader = new FileReader();
    reader.onload = function (e) {
      var wb;
      try { wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array', cellDates: true }); }
      catch (err) { toast('这个文件读不出来，确认是 .xlsx 或 .csv。'); return; }
      var name = wb.SheetNames.indexOf('项目库') >= 0 ? '项目库' : wb.SheetNames[0];
      var rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', raw: true });
      if (!rows.length) { toast('没有读到数据行（第一行需要是表头）。'); return; }

      var toInsert = [], toUpdate = [], skipped = 0;
      var index = {};
      items.forEach(function (it) { index[(it.url || it.name).toLowerCase()] = it; });

      rows.forEach(function (raw) {
        var it = rowFromExcel(raw);
        var key = (it.url || it.name).toLowerCase();
        if (!key || key === '示例行') { skipped++; return; }
        if (!it.added_at) it.added_at = today();
        var hit = index[key];
        if (hit) {
          // 已存在：沿用原 id（upsert 的锚点）与原有备注；缺字段的用新值补
          var merged = normalize(Object.assign({}, hit, it, { id: hit.id }));
          index[key] = merged;
          toUpdate.push(merged);
        } else {
          var fresh = normalize(it);
          index[key] = fresh;
          toInsert.push(fresh);
        }
      });

      if (!toInsert.length && !toUpdate.length) { toast('没有读到可导入的数据行。'); return; }

      setSync('loading', '正在写入云端…');
      var chain = Promise.resolve();
      if (toInsert.length) {
        chain = chain.then(function () { return insertRows(toInsert); })
                     .then(function (r) { assertWrote(r, '导入'); });
      }
      if (toUpdate.length) {
        chain = chain.then(function () { return upsertRows(toUpdate); })
                     .then(function (r) { assertWrote(r, '导入更新'); });
      }
      chain.then(function () { return load(); })
        .then(function () {
          if (loadErr) throw new Error(loadErr);
          syncReady(); render(); resetFilterInputs();
          var msg = '导入完成：新增 ' + toInsert.length + ' 条';
          if (toUpdate.length) msg += '，更新 ' + toUpdate.length + ' 条';
          if (skipped) msg += '，跳过 ' + skipped + ' 行空行/标题行';
          toast(msg + '。');
        })
        .catch(function (e) {
          setSync('error', '导入失败');
          toast('导入失败：' + dbErr(e));
        });
    };
    reader.onerror = function () { toast('文件读取失败，重试一次。'); };
    reader.readAsArrayBuffer(file);
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
      + '<div><small>GITHUB PROJECT LIBRARY · 仅管理员</small><h1>GitHub 项目收藏</h1>'
      + '<p>把收集到的开源项目建档、归类、筛选，随时导出成 Excel 归档或带走。'
      + '数据保存在云端，换设备打开也在。</p>'
      + '<div class="pr-sync" data-pr-sync data-pr-sync-state="loading">正在从云端读取…</div></div>'
      + '<div class="pr-actions">'
      + '<button class="btn primary" type="button" data-pr-new>新增项目</button>'
      + '<button class="btn" type="button" data-pr-tpl>下载模板</button>'
      + '<button class="btn" type="button" data-pr-import>导入 Excel</button>'
      + '</div></div>'
      /* 视图切换：两个按钮，计数写在按钮上。默认「我的库」——
         这才是这个模块的主视图（改之前热点卡片压在库表格上方，还得先滚过去）。 */
      + '<div class="pr-views" role="tablist">'
      + '<button class="pr-view-btn active" type="button" data-pr-view="lib" role="tab">'
      + '<span class="nav-glyph">▤</span>我的库 <u>0</u></button>'
      + '<button class="pr-view-btn" type="button" data-pr-view="hot" role="tab">'
      + '<span class="nav-glyph">★</span>热点榜 <u>—</u></button>'
      + '</div>'
      + '<section class="pr-pane" data-pr-pane="lib">'
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
      + '<colgroup><col class="c-date"/><col class="c-name"/><col class="c-cat"/><col class="c-sum"/>'
      + '<col class="c-open"/><col class="c-star"/><col class="c-act"/></colgroup>'
      + '<thead><tr>'
      + '<th>入库日期</th><th>项目</th><th>类别</th><th>项目简介</th><th>开源程度</th><th style="text-align:right">Star</th><th>操作</th>'
      + '</tr></thead><tbody data-pr-body></tbody></table></div>'
      /* 计数 + 导出条同一行：导的是"当前筛选"还是"全部"，按钮上直接写明条数 */
      + '<div class="pr-toolbar"><p class="pr-note" data-pr-count></p>'
      + '<div class="pr-toolbar-act" data-pr-export-row></div></div>'
      + '</div>'
      + '<p class="pr-note">数据保存在服务端（仅管理员可见），来源是手工录入或 Excel 导入。换设备或换浏览器登录，看到的是同一份库。</p>'
      + '</section>'
      + '<section class="pr-pane" data-pr-pane="hot" hidden>'
      + '<section class="pr-hot" data-pr-hot></section>'
      + '</section>'
      + '<div class="pr-note" data-pr-toast style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);padding:10px 18px;border:1px solid var(--border2);border-radius:10px;background:var(--panel2);color:var(--text);opacity:0;pointer-events:none;transition:opacity .2s"></div>'
      + '<dialog class="pr-dialog" data-pr-dialog>'
      + '<div class="pr-dlg-head"><h2 data-pr-dlg-title>新增项目</h2>'
      + '<button class="pr-rowbtn" type="button" data-pr-cancel>关闭</button></div>'
      + '<div class="pr-dlg-body">'
      + '<div class="pr-field wide"><label for="prFName">项目名称</label><input id="prFName" data-pr-f-name maxlength="120" placeholder="作者/仓库名，例如 openai/whisper"></div>'
      + '<div class="pr-field wide"><label for="prFUrl">仓库地址</label><input id="prFUrl" data-pr-f-url maxlength="300" placeholder="https://github.com/..."></div>'
      + '<div class="pr-field"><label for="prFDate">入库日期</label><input id="prFDate" type="date" data-pr-f-date></div>'
      + '<div class="pr-field"><label for="prFStars">Star 数（入库时）</label><input id="prFStars" type="number" min="0" step="100" data-pr-f-stars placeholder="0"></div>'
      + '<div class="pr-field"><label for="prFCat">项目类别</label><select id="prFCat" data-pr-f-cat>' + options(CATS, '—') + '</select></div>'
      + '<div class="pr-field"><label for="prFOpen">开源程度</label><select id="prFOpen" data-pr-f-open>' + options(OPEN, '—') + '</select></div>'
      + '<div class="pr-field wide"><label for="prFSummary">项目简介</label><textarea id="prFSummary" data-pr-f-summary maxlength="400" placeholder="它是干什么的、好在哪"></textarea></div>'
      + '<div class="pr-field wide"><label for="prFNote">备注</label><input id="prFNote" data-pr-f-note maxlength="200" placeholder="使用心得、待办、关联项目"></div>'
      + '</div>'
      + '<div class="pr-dlg-foot"><button class="btn" type="button" data-pr-cancel>取消</button>'
      + '<button class="btn primary" type="button" data-pr-save>保存</button></div>'
      + '</dialog>'
      + '<input type="file" accept=".xlsx,.xls,.csv" data-pr-file hidden>';
  }

  /* ---------- 事件（全部委托在 root 上，重绘不用重绑） ---------- */
  function onClick(e) {
    var t = e.target.closest('[data-pr-new],[data-pr-tpl],[data-pr-import],[data-pr-export],'
      + '[data-pr-export-all],[data-pr-reset],[data-pr-edit],[data-pr-del],[data-pr-save],'
      + '[data-pr-cancel],[data-pr-bar],[data-pr-view],[data-pr-sort],'
      + '[data-pr-adopt],[data-pr-adopt-all]');
    if (!t) return;
    if (t.hasAttribute('data-pr-adopt')) {
      var one = (hot && hot.items) ? hot.items[Number(t.getAttribute('data-pr-adopt'))] : null;
      return one ? adopt([one]) : undefined;
    }
    if (t.hasAttribute('data-pr-adopt-all')) return adopt(hotFresh(hot && hot.items, items));
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
    if (t.hasAttribute('data-pr-export-all')) return exportXlsx(sortRows(items), '全部');
    if (t.hasAttribute('data-pr-new')) return openEditor(null);
    if (t.hasAttribute('data-pr-tpl')) return downloadTemplate();
    if (t.hasAttribute('data-pr-import')) return $('[data-pr-file]').click();
    if (t.hasAttribute('data-pr-export')) return exportXlsx();
    if (t.hasAttribute('data-pr-save')) return submitEditor();
    if (t.hasAttribute('data-pr-cancel')) return closeEditor();
    if (t.hasAttribute('data-pr-reset')) { resetFilterInputs(); return render(); }
    if (t.hasAttribute('data-pr-edit')) return openEditor(t.getAttribute('data-pr-edit'));
    if (t.hasAttribute('data-pr-del')) return removeItem(t.getAttribute('data-pr-del'));
    if (t.hasAttribute('data-pr-bar')) {
      var k = t.getAttribute('data-pr-bar');
      f.cat = f.cat === k ? '' : k;
      $('[data-pr-cat]').value = f.cat;
      return render();
    }
  }

  function onFilter() { readFilters(); render(); }

  function onChange(e) {
    if (e.target.hasAttribute && e.target.hasAttribute('data-pr-file')) {
      var file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (file) importXlsx(file);
      return;
    }
    if (e.target.closest && e.target.closest('.pr-filters')) onFilter();
  }

  function onKey(e) {
    if (e.key === 'Enter' && e.target.closest && e.target.closest('[data-pr-dialog]')
        && e.target.tagName !== 'TEXTAREA') { e.preventDefault(); submitEditor(); }
  }

  /* ---------- 生命周期 ---------- */
  function open(node, userId) {
    if (active) close();
    root = node;
    user = userId || '';
    active = true;
    root.innerHTML = skeleton();
    resetFilterInputs();
    items = [];
    hot = null;        // 每次重开都重新拉热点（榜单每天变），热点自身有模块内缓存
    loadErr = '';
    view = 'lib';      // 每次打开都落在「我的库」——收录的东西不该被热点挡在后面
    hotSort = 'gain';
    setSync('loading', '正在从云端读取…');
    render();          // 先铺骨架与空态，别让用户对着白屏等
    renderHot();
    fetchHot();

    load().then(function () {
      // 只有云端为空时才考虑搬迁本地旧数据 —— 免得把一份陈旧副本盖到云端
      if (items.length) return 0;
      return migrateLocal();
    }).then(function (moved) {
      if (!moved) return;
      return load().then(function () {
        toast('已把本地保存的 ' + moved + ' 个项目搬迁到云端。');
      });
    }).then(function () {
      if (loadErr) setSync('error', loadErr); else syncReady();
      render();
    });

    root.addEventListener('click', onClick);
    root.addEventListener('input', onFilter);
    root.addEventListener('change', onChange);
    root.addEventListener('keydown', onKey);
  }

  function close() {
    if (!root) return;
    active = false;
    root.removeEventListener('click', onClick);
    root.removeEventListener('input', onFilter);
    root.removeEventListener('change', onChange);
    root.removeEventListener('keydown', onKey);
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
