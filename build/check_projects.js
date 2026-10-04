/* projects.js 纯逻辑自检 —— 不碰 DOM，直接跑：
     node build/check_projects.js
   覆盖最容易静默出错的地方：日期归一、star 解析、筛选匹配、榜单排序、默认展示顺序。

   ⚠️ 2026-10-04 改版：模块已改成**公开只读展示页**，所以这里**不再**有
      字段集/身份列（fieldsOf / IDENTITY_COLS）那一组断言 —— 那些守卫的对象是
      "客户端把字段写进云表"这条路径，而写入口已经整段删除。
      取而代之的是下面「默认排序」与「只读形态」两组断言：
        · sortRows 的口径（表与导出共用同一个顺序）
        · projects.js 源码里不得出现任何写调用（INSERT/UPDATE/UPSERT/DELETE）
      后者同时也是"纯展示页"这条需求的回归哨兵 —— 有人把编辑功能加回来就会炸。 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const P = require('./projects.js');

/* ---------- 入库日期：Excel 里可能是 Date / 序列号 / 各种字符串 ---------- */
assert.strictEqual(P.toDate('2026-10-03'), '2026-10-03');
assert.strictEqual(P.toDate('2026/10/3'), '2026-10-03');
assert.strictEqual(P.toDate('2026.10.03'), '2026-10-03');
assert.strictEqual(P.toDate('2026-10-03T09:30:00Z'), '2026-10-03');
assert.strictEqual(P.toDate(new Date(2026, 9, 3)), '2026-10-03');

// Excel 序列号必须和 Date 路径算出同一天，否则历史数据整体错位
const serial = (new Date(2026, 9, 3) - new Date(Date.UTC(1899, 11, 30))) / 86400000;
assert.strictEqual(P.toDate(serial), '2026-10-03', 'Excel 序列号解析错误');

assert.strictEqual(P.toDate(''), '', '空值必须是空串，不是今天');
assert.strictEqual(P.toDate('待定'), '', '认不出来的日期不该瞎猜');

/* ---------- Star 数：GitHub 页面上常显示成 74.2k ---------- */
assert.strictEqual(P.toStars(74000), 74000);
assert.strictEqual(P.toStars('12,345'), 12345);
assert.strictEqual(P.toStars('74.2k'), 74200, 'k 后缀不能被丢成 0');
assert.strictEqual(P.toStars('1.5K'), 1500);
assert.strictEqual(P.toStars('8200 ★'), 8200);
assert.strictEqual(P.toStars(''), 0);
assert.strictEqual(P.toStars('很多'), 0);

/* ---------- 导出列顺序必须与 COLS 一致，否则整表错列 ----------
   ⚠️ COLS 是 **Excel 导出契约**（8 列），与页面表格的 7 列（TCOLS）是两回事。 */
const item = { added_at: '2026-10-03', name: 'n', url: 'u', category: 'c',
  summary: 's', openness: 'o', stars: 7, note: 'x' };
assert.deepStrictEqual(P.rowToArray(item),
  ['2026-10-03', 'n', 'u', 'c', 's', 'o', 7, 'x']);
assert.strictEqual(P.COLS.map(c => c.t).join(','),
  '入库日期,项目名称,仓库地址,项目类别,项目简介,开源程度,Star 数,备注');
assert.strictEqual(P.COLS.length, 8, '导出契约就是 8 列，改了要同步改模板说明');

/* ---------- 筛选 ---------- */
const NONE = { q: '', cat: '', open: '', from: '', to: '', minStars: '' };
const A = { added_at: '2026-10-03', name: 'whisper', url: 'github.com/openai/whisper',
  category: 'AI / LLM', summary: '语音识别', openness: '完全开源', stars: 74000, note: '' };
const B = { added_at: '2026-08-01', name: 'dbeaver', url: 'github.com/dbeaver',
  category: '数据库', summary: '通用数据库客户端', openness: '开源核心', stars: 39000, note: '' };

assert.ok(P.matchItem(A, NONE), '空筛选必须全放行');
assert.ok(!P.matchItem(A, Object.assign({}, NONE, { cat: '数据库' })));
assert.ok(P.matchItem(B, Object.assign({}, NONE, { cat: '数据库' })));
assert.ok(!P.matchItem(A, Object.assign({}, NONE, { open: '开源核心' })));
assert.ok(!P.matchItem(A, Object.assign({}, NONE, { minStars: '80000' })));
assert.ok(P.matchItem(A, Object.assign({}, NONE, { minStars: '70000' })));
assert.ok(P.matchItem(B, Object.assign({}, NONE, { from: '2026-01-01', to: '2026-12-31' })));
assert.ok(!P.matchItem(B, Object.assign({}, NONE, { from: '2026-09-01' })), '日期范围下界要生效');
assert.ok(!P.matchItem(B, Object.assign({}, NONE, { to: '2026-07-01' })), '日期范围上界要生效');
assert.ok(P.matchItem(A, Object.assign({}, NONE, { q: 'WHISPER' })), '关键词不分大小写');
assert.ok(P.matchItem(B, Object.assign({}, NONE, { q: '客户端' })), '关键词要能搜到简介');
assert.ok(!P.matchItem(A, Object.assign({}, NONE, { q: '数据库' })));
// 组合条件必须同时满足
assert.ok(!P.matchItem(B, Object.assign({}, NONE, { cat: '数据库', minStars: '50000' })));

/* ---------- 日期区间边界：同一天必须落在 [from,to] 内 ---------- */
assert.ok(P.matchItem(A, Object.assign({}, NONE, { from: '2026-10-03', to: '2026-10-03' })),
  '同一天应命中（闭区间）');

/* ---------- today() 形状 ---------- */
assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(P.today()));

/* ---------- ★ 默认展示顺序（2026-10-04 新增）----------
   需求原话：「点进去默认按照更新顺序全部显示」。
   口径是 updated_at 倒序，**不是** added_at —— "更新顺序"与"首次收录日期"是两回事：
   一条 9 月收录、今天才被更新的记录，应该排在最前面。 */
const OLD = { name: 'old', added_at: '2026-09-01', updated_at: '2026-09-01T00:00:00Z', stars: 100 };
const NEW = { name: 'new', added_at: '2026-09-02', updated_at: '2026-10-04T12:00:00Z', stars: 1 };
const MID = { name: 'mid', added_at: '2026-10-03', updated_at: '2026-10-03T08:00:00Z', stars: 5 };
assert.deepStrictEqual(P.sortRows([OLD, NEW, MID]).map(x => x.name), ['new', 'mid', 'old'],
  '必须先按 updated_at 倒序');
// ★ 关键反例：added_at 更新但 updated_at 更旧 → 仍然排在后面
assert.deepStrictEqual(P.sortRows([OLD, MID]).map(x => x.name), ['mid', 'old'],
  '不能退化成按 added_at 排序');

// 缺 updated_at 的脏数据（运维侧直插的行可能没有）要能用 added_at 兜底，且不能 NaN/崩
const NOUP = { name: 'noup', added_at: '2026-10-04', stars: 3 };
assert.strictEqual(P.orderOf(NOUP), '2026-10-04T00:00:00Z', '缺 updated_at 要退到 added_at');
assert.strictEqual(P.orderOf({}), 'T00:00:00Z', '两个都没有也不能抛');
assert.strictEqual(P.sortRows([NOUP, OLD]).length, 2, '兜底路径不能吃掉条目');
assert.strictEqual(P.orderOf(new Date(0)), 'T00:00:00Z', '非字符串的脏值不能把排序搞崩');

// updated_at 相同时按 Star 降序兜底 —— 否则同一份数据两次渲染顺序会漂
const S1 = { name: 's1', updated_at: '2026-10-04T00:00:00Z', stars: 1 };
const S2 = { name: 's2', updated_at: '2026-10-04T00:00:00Z', stars: 900 };
assert.deepStrictEqual(P.sortRows([S1, S2]).map(x => x.name), ['s2', 's1'], '同刻按 Star 兜底');

// 排序不能就地改原数组（表格与导出会各自调一次，原地改会让两边口径打架）
const src = [OLD, NEW];
P.sortRows(src);
assert.deepStrictEqual(src, [OLD, NEW], 'sortRows 必须是纯函数，不能就地改原数组');
assert.deepStrictEqual(P.sortRows([]), [], '空数组要能过');

/* ---------- 热点推荐：热度 / 榜单 / 已收录判定 ---------- */
// 日榜与周榜量纲不同，heat 必须按「日增 × 7」折算后再比，否则日榜永远打不过周榜
assert.strictEqual(P.hotHeat({ stars_today: 100, stars_week: 0 }), 700);
assert.strictEqual(P.hotHeat({ stars_today: 0, stars_week: 900 }), 900);
assert.strictEqual(P.hotHeat({ stars_today: 100, stars_week: 900 }), 900);
assert.strictEqual(P.hotHeat({}), 0);
assert.ok(P.hotHeat({ stars_today: 200 }) > P.hotHeat({ stars_today: 150 }), '日榜要能比大小');

// 副信息拼装
assert.strictEqual(P.hotFacts({ stars_today: 556, language: 'Shell' }), '日榜 +556 · Shell');
assert.strictEqual(P.hotFacts({ stars_week: 12825, created_at: '2026-01-02' }), '周榜 +12,825 · 建库 2026-01-02');
assert.strictEqual(P.hotFacts({}), '', '没有可展示的信息时不该留下分隔符');

// 去重：以「地址优先、其次名称」为键，且忽略大小写
assert.strictEqual(P.depKey({ url: 'HTTPS://GitHub.com/A/B' }), 'https://github.com/a/b');
assert.strictEqual(P.depKey({ name: 'A/B' }), 'a/b');
const owned = [{ url: 'https://github.com/obra/superpowers' }];
const fresh = P.hotFresh([
  { url: 'https://github.com/obra/superpowers' },          // 已收录
  { url: 'https://github.com/OBRA/Superpowers' },          // 大小写不同也算已收录
  { url: 'https://github.com/new/one', name: 'new/one' }   // 新的
], owned);
assert.strictEqual(fresh.length, 1, '已收录判定必须忽略大小写，否则会重复显示');
assert.strictEqual(fresh[0].url, 'https://github.com/new/one');
assert.strictEqual(P.hotFresh([{ name: 'x' }], []).length, 1, '空集合时全都是新的');
// 无 url 无 name 的脏项不能算「新」
assert.strictEqual(P.hotFresh([{ url: '', name: '' }], []).length, 0);

/* ---------- 榜单口径：升星速度榜 / 总星数榜 ---------- */
assert.strictEqual(P.hotGain({ stars_today: 120, stars_week: 900 }), 120, '有日增就用日增');
assert.strictEqual(P.hotGain({ stars_today: 0, stars_week: 700 }), 100, '只有周增要折成日均');
assert.strictEqual(P.hotGain({ stars_today: 0, stars_week: 10 }), 1, '折算要四舍五入');
assert.strictEqual(P.hotGain({}), 0);
assert.strictEqual(P.hotGain({ stars_today: '88' }), 88, '字符串也要能解析');

const R_A = { name: 'a', stars: 100, stars_today: 10, stars_week: 0 };
const R_B = { name: 'b', stars: 999999, stars_today: 0, stars_week: 700 };  // 日均 100
const R_C = { name: 'c', stars: 500000, stars_today: 0, stars_week: 0 };
assert.deepStrictEqual(P.hotRank([R_A, R_B, R_C], 'gain').map(x => x.name), ['b', 'a', 'c'],
  '升星榜按日均升星降序，两个量纲要能混排');
assert.deepStrictEqual(P.hotRank([R_A, R_B, R_C], 'stars').map(x => x.name), ['b', 'c', 'a'],
  '总星榜按总星数降序');
assert.strictEqual(P.hotRank([R_A, R_B], 'gain').length, 2, '排名不能吃掉条目');
const rankSrc = [R_A, R_B];
P.hotRank(rankSrc, 'stars');
assert.deepStrictEqual(rankSrc, [R_A, R_B], 'hotRank 不能就地改原数组（否则已收录判定会错位）');
// 主键相等时用副键兜底 —— 否则两次渲染顺序会漂
const T1 = { name: 't1', stars: 5, stars_today: 0, stars_week: 0 };
const T2 = { name: 't2', stars: 9, stars_today: 0, stars_week: 0 };
assert.deepStrictEqual(P.hotRank([T1, T2], 'gain').map(x => x.name), ['t2', 't1'],
  '日均相同时按总星兜底，排序要稳定');

/* ---------- 热点数据源路径必须与 make_app.py 的白名单一致 ---------- */
assert.strictEqual(P.HOT_URL, '/assets/hot-projects.json');

/* ==========================================================================
   只读形态守卫（2026-10-04 新增，取代原「数据库字段集 6 条」）
   --------------------------------------------------------------------------
   需求：「这个分区以后就纯做展示页」。
   这条需求最容易静默回退 —— 有人顺手把"编辑/删除/新增"加回来，页面照常工作、
   测试照绿，但"公开只读"的承诺就破了（而且 RLS 会把非运营方的写请求静默拒掉，
   表现为"点了没反应"，极难排查）。
   所以在源码层面钉死：这个模块**一个写调用都不能有**。
   ⚠️ 同时 verify.py §6.2b 会再做一遍同样的扫描 —— 两道互补：
      这一道跑在 node 里（能连纯函数一起测），那一道跑在门禁里（不依赖 node）。
   ========================================================================== */
const pjs = fs.readFileSync(path.join(__dirname, 'projects.js'), 'utf8');
/* ⚠️ 扫描前必须先剥掉注释 —— 下面 pjsCode 的做法就是为此。
   projects.js 的模块头注释里明写着四个写调用的名字，不剥的话第一条断言直接假红
   （2026-10-04 已踩过一次）。这里只剥两种：块注释，以及**整行**注释。
   刻意不剥行尾注释 —— URL 字符串里（'https://…'）也含两个斜杠，
   按行尾剥会把那一行后面的真实代码一起吃掉，反而制造"扫不到"的假阴性。 */
const pjsCode = pjs.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const WRITES = [
  { re: /\.insert\s*\(/g, what: '.insert(' },
  { re: /\.update\s*\(/g, what: '.update(' },
  { re: /\.upsert\s*\(/g, what: '.upsert(' },
  { re: /\.delete\s*\(/g, what: '.delete(' }
];
WRITES.forEach(w => {
  // 逐处报行号，不然改坏了不知道去哪找
  const lines = [];
  const all = pjsCode.split('\n');
  all.forEach((line, i) => {
    w.re.lastIndex = 0;
    if (w.re.test(line)) lines.push('L' + (i + 1));
  });
  assert.strictEqual(lines.length, 0,
    'projects.js 里出现了写调用 ' + w.what + '（' + lines.join(', ') + '）—— ' +
    '这个模块是公开只读展示页，写入口已在 2026-10-04 全部删除，不要再加回来');
});

// 反向确认扫描真的在干活：文件里必须至少有一个 .from(TABLE) 读调用
assert.ok(/\.from\(\s*TABLE\s*\)/.test(pjsCode), '.from(TABLE) 读调用都不见了，说明读路径被改坏或扫描失效');
// 摘要是唯一的数据源，不能再回到 localStorage 多副本时代
assert.ok(pjsCode.indexOf('localStorage.setItem') < 0,
  'projects.js 又往 localStorage 写数据了 —— 展示页的数据源必须只有云表一份');

/* [7] ★★ 全局名遮蔽守卫：页面里任何 `id="x"` 都会在 window 上生成同名全局变量 x。
     所以 `if (window.foo) window.foo(...)` 这种写法天生不可靠 —— id 一撞名，
     window.foo 就是 DOM 元素，调用直接 TypeError；若在 .then 链里，整条链被打断，
     表现为「数据读到了但界面不动」，极难定位。
     真实事故：<div class="toast" id="toast"> 撞掉了 global.toast（2026-10-03）。
     规则：projects.js 里凡是 `global.X(...)` 的调用，X 都不能是产物里的某个 id。 */
const htmlPath = path.join(__dirname, '..', 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const ids = new Set();
  let m, reId = /\sid="([A-Za-z_$][\w$-]*)"/g;
  while ((m = reId.exec(html))) ids.add(m[1]);
  const called = new Set();
  let reCall = /\bglobal\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = reCall.exec(pjsCode))) called.add(m[1]);
  const shadowed = [...called].filter(n => ids.has(n));
  // 允许调用撞名全局，但**必须**先做类型判断（typeof）。只写 `if (global.X)` 是不行的：
  // X 恒为真（元素存在）却不是函数，照样 TypeError。
  const unguarded = shadowed.filter(n => pjsCode.indexOf('typeof global.' + n) < 0);
  assert.strictEqual(unguarded.length, 0,
    '这些名字既是页面元素 id 又被当全局函数调用，且没有 typeof 判断：' + unguarded.join(', ') +
    ' —— 会拿到 DOM 元素去调用；换成 typeof 判断 + 不撞名的出口（如 window.FluxToast）');
  assert.ok(called.size >= 2, '全局调用点扫描结果为空，说明正则失效了（不是真通过）');
  // 顺带禁掉最危险的那个写法：对撞名全局做真值判断后调用
  const truthyOnShadowed = shadowed.filter(n => new RegExp('if\\s*\\(\\s*global\\.' + n + '\\s*\\)').test(pjsCode));
  assert.strictEqual(truthyOnShadowed.length, 0,
    '对撞名全局写了 `if (global.X)`（X 恒真但不是函数）：' + truthyOnShadowed.join(', '));
  // 反向确认：守卫的样本还在（改了 id 就会让这条守卫悄悄失效）
  assert.ok(ids.has('toast'), '产物里找不到 id="toast"，守卫样本没了，检查是否改了 id');
}

console.log('projects.js 自检通过：日期 7 · Star 7 · 导出列 3 · 筛选 14 · 默认排序 11 · '
  + '热点 22 · 只读形态 6 · 全局遮蔽 1');
