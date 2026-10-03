/* projects.js 纯逻辑自检 —— 不碰 DOM，直接跑：
     node build/check_projects.js
   覆盖三处最容易静默出错的地方：Excel 日期、star 解析、筛选匹配。 */
'use strict';
const assert = require('assert');
const P = require('./projects.js');

/* ---------- 入库日期：Excel 里可能是 Date / 序列号 / 各种字符串 ---------- */
assert.strictEqual(P.toDate('2026-10-03'), '2026-10-03');
assert.strictEqual(P.toDate('2026/10/3'), '2026-10-03');
assert.strictEqual(P.toDate('2026.10.03'), '2026-10-03');
assert.strictEqual(P.toDate('2026-10-03T09:30:00Z'), '2026-10-03');
assert.strictEqual(P.toDate(new Date(2026, 9, 3)), '2026-10-03');

// Excel 序列号必须和 Date 路径算出同一天，否则导入会整体错位
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

/* ---------- 表头容错：空格、换行、别名都要认得 ---------- */
const parsed = P.rowFromExcel({
  '入库日期 ': '2026/10/3',
  '项目名称': ' openai/whisper ',
  '仓库地址': 'https://github.com/openai/whisper',
  '分类': 'AI / LLM',
  '简介': '语音识别',
  '开源': '完全开源',
  'star': '74.2k',
  '备注': '待试'
});
assert.strictEqual(parsed.added_at, '2026-10-03');
assert.strictEqual(parsed.name, 'openai/whisper', '名称两侧空格要去掉');
assert.strictEqual(parsed.category, 'AI / LLM', '「分类」别名要认得');
assert.strictEqual(parsed.openness, '完全开源', '「开源」别名要认得');
assert.strictEqual(parsed.stars, 74200);

/* ---------- 导出列顺序必须与 COLS 一致，否则整表错列 ---------- */
const item = { added_at: '2026-10-03', name: 'n', url: 'u', category: 'c',
  summary: 's', openness: 'o', stars: 7, note: 'x' };
assert.deepStrictEqual(P.rowToArray(item),
  ['2026-10-03', 'n', 'u', 'c', 's', 'o', 7, 'x']);
assert.strictEqual(P.COLS.map(c => c.t).join(','),
  '入库日期,项目名称,仓库地址,项目类别,项目简介,开源程度,Star 数,备注');

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

/* ---------- 热点推荐：排序热度 / 收进行 / 去重 ---------- */
// 日榜与周榜量纲不同，heat 必须按「日增 × 7」折算后再比，否则日榜永远打不过周榜
assert.strictEqual(P.hotHeat({ stars_today: 100, stars_week: 0 }), 700);
assert.strictEqual(P.hotHeat({ stars_today: 0, stars_week: 900 }), 900);
assert.strictEqual(P.hotHeat({ stars_today: 100, stars_week: 900 }), 900);
assert.strictEqual(P.hotHeat({}), 0);
assert.ok(P.hotHeat({ stars_today: 200 }) > P.hotHeat({ stars_today: 150 }), '日榜要能比大小');

// 热点项 → 库行：字段名和类型都要落成库里的口径
const hotRow = P.hotToRow({
  name: 'obra/superpowers', url: 'https://github.com/obra/superpowers',
  category: '开发者工具', summary: '技能框架', openness: '完全开源',
  stars: 294629, note: '热点推荐 · 日榜 +556', found_at: '2026-10-03'
});
assert.deepStrictEqual(P.rowToArray(hotRow),
  ['2026-10-03', 'obra/superpowers', 'https://github.com/obra/superpowers',
   '开发者工具', '技能框架', '完全开源', 294629, '热点推荐 · 日榜 +556'],
  '热点项收进后必须与导出列顺序对齐');

// 缺字段的脏数据不能把库行搞成 undefined
const dirty = P.hotToRow({ url: 'https://github.com/a/b' });
assert.strictEqual(dirty.name, '');
assert.strictEqual(dirty.category, '其他', '缺类别要有兜底，不能是空');
assert.strictEqual(dirty.openness, '源码可见');
assert.strictEqual(dirty.stars, 0);
assert.strictEqual(dirty.added_at, P.today(), '缺入库日期时按今天算');
assert.ok(dirty.note.length > 0, '备注要有兜底');

// 副信息拼装
assert.strictEqual(P.hotFacts({ stars_today: 556, language: 'Shell' }), '日榜 +556 · Shell');
assert.strictEqual(P.hotFacts({ stars_week: 12825, created_at: '2026-01-02' }), '周榜 +12,825 · 建库 2026-01-02');
assert.strictEqual(P.hotFacts({}), '', '没有可展示的信息时不该留下分隔符');

// 去重：以「地址优先、其次名称」为键，且忽略大小写
assert.strictEqual(P.depKey({ url: 'HTTPS://GitHub.com/A/B' }), 'https://github.com/a/b');
assert.strictEqual(P.depKey({ name: 'A/B' }), 'a/b');
const owned = [{ url: 'https://github.com/obra/superpowers' }];
const fresh = P.hotFresh([
  { url: 'https://github.com/obra/superpowers' },          // 已在库
  { url: 'https://github.com/OBRA/Superpowers' },          // 大小写不同也算已在库
  { url: 'https://github.com/new/one', name: 'new/one' }   // 新的
], owned);
assert.strictEqual(fresh.length, 1, '去重必须与 Excel 导入同口径，否则会收进重复项');
assert.strictEqual(fresh[0].url, 'https://github.com/new/one');
assert.strictEqual(P.hotFresh([{ name: 'x' }], []).length, 1, '空库时全都是新的');
// 无 url 无 name 的脏项不能算「新」
assert.strictEqual(P.hotFresh([{ url: '' , name: '' }], []).length, 0);

/* ---------- 热点数据源路径必须与 make_app.py 的白名单一致 ---------- */
assert.strictEqual(P.HOT_URL, '/assets/hot-projects.json');

/* ==========================================================================
   数据库字段集（2026-10-03 改为云端存储时新增）
   --------------------------------------------------------------------------
   这是最需要机器盯着的一段：字段表一旦漂移，症状是"某一列永远存不进去"，
   而且界面看起来完全正常（因为它只从内存渲染），非要刷新页面才发现。
   ========================================================================== */

// [1] 字段集必须**恰好**是这 9 个 —— 多了会往库里塞多余列，少了会静默丢字段
const EXPECT_FIELDS = ['added_at', 'category', 'name', 'note', 'openness',
  'stars', 'summary', 'updated_at', 'url'];
assert.deepStrictEqual(
  Object.keys(P.fieldsOf({})).sort(), EXPECT_FIELDS,
  'fieldsOf 的字段集与约定不符（改字段必须同步改 migrations/003_projects.sql 的建表）');

// [2] ★ 绝不能有身份列：身份交给列的 DEFAULT auth.uid()。
//     客户端自报身份既不可信，也会被 RLS 拒绝；历史上还炸过一次
//     （notifications.created_by 传了 19 位数字串，Postgres 按 uuid 解析失败）。
const idCols = P.IDENTITY_COLS;
assert.ok(Array.isArray(idCols) && idCols.length, 'IDENTITY_COLS 必须是数组');
Object.keys(P.fieldsOf({})).forEach(k => {
  assert.ok(idCols.indexOf(k) < 0, '字段集里出现了身份列：' + k);
});
// 反向确认哨兵列名本身没写错（写错成 ownerId 之类就永远扫不到了）
['owner_id', 'created_by'].forEach(c => {
  assert.ok(idCols.indexOf(c) >= 0, 'IDENTITY_COLS 漏了 ' + c + '，哨兵会失效');
});

// [3] ★★ 漂移守卫：Excel 契约（COLS）里的每一个业务列，数据库字段集里都必须有。
//     加了一列到 COLS 却忘了 fieldsOf → 导出里有、存库时丢 → 这里必须炸。
P.COLS.forEach(c => {
  assert.ok(EXPECT_FIELDS.indexOf(c.k) >= 0,
    'COLS 里的 ' + c.k + ' 没有对应的数据库字段，导出有值但存不进库');
});
// 且 fieldsOf 不该有 COLS 之外凭空多出来的业务列（updated_at 是审计列，豁免）
Object.keys(P.fieldsOf({})).forEach(k => {
  if (k === 'updated_at') return;
  assert.ok(P.COLS.some(c => c.k === k), 'fieldsOf 多出 COLS 之外的业务列：' + k);
});

// [4] 脏数据的兜底默认值：必须和建表时的 DEFAULT 一致，否则"空值"和"缺字段"会写出两种结果
const f0 = P.fieldsOf({});
assert.strictEqual(f0.category, '其他');
assert.strictEqual(f0.openness, '源码可见');
assert.strictEqual(f0.stars, 0);
assert.strictEqual(f0.name, '');
assert.strictEqual(f0.url, '');
assert.strictEqual(f0.summary, '');
assert.strictEqual(f0.note, '');
assert.strictEqual(f0.added_at, P.today(), '空日期要落到今天，不能写空串（列是 NOT NULL）');

// [5] 类型必须落成数据库能吃的形态
const f1 = P.fieldsOf({ stars: '74.2k', added_at: '2026/10/3', name: '  a/b  ' }, '2026-10-03T00:00:00.000Z');
assert.strictEqual(f1.stars, 74200, 'stars 必须转成整数（列是 integer，传字符串会被拒）');
assert.strictEqual(f1.added_at, '2026-10-03', '日期要规范化成 YYYY-MM-DD');
assert.strictEqual(f1.name, 'a/b', '字符串字段要 trim');
assert.strictEqual(f1.updated_at, '2026-10-03T00:00:00.000Z', 'updated_at 应可直接注入以便复现');

// [6] null 不能漏进来 —— 显式 null 会覆盖列的 DEFAULT（平台文档明确警告过）
const f2 = P.fieldsOf({ name: null, url: undefined, stars: null, category: '', openness: null });
Object.keys(f2).forEach(k => {
  assert.notStrictEqual(f2[k], null, k + ' 不该是 null（会覆盖列默认值）');
  assert.notStrictEqual(f2[k], undefined, k + ' 不该是 undefined');
});

// [7] ★★ 全局名遮蔽守卫：页面里任何 `id="x"` 都会在 window 上生成同名全局变量 x。
//     所以 `if (window.foo) window.foo(...)` 这种写法天生不可靠 —— id 一撞名，
//     window.foo 就是 DOM 元素，调用直接 TypeError；若在 .then 链里，整条链被打断，
//     表现为「数据写成功了但界面不动」，极难定位。
//     真实事故：<div class="toast" id="toast"> 撞掉了 global.toast（2026-10-03）。
//     规则：projects.js 里凡是 `global.X(...)` 的调用，X 都不能是产物里的某个 id。
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'projects.js'), 'utf8');
const htmlPath = path.join(__dirname, '..', 'index.html');
if (fs.existsSync(htmlPath)) {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const ids = new Set();
  let m, reId = /\sid="([A-Za-z_$][\w$-]*)"/g;
  while ((m = reId.exec(html))) ids.add(m[1]);
  const called = new Set();
  let reCall = /\bglobal\.([A-Za-z_$][\w$]*)\s*\(/g;
  while ((m = reCall.exec(src))) called.add(m[1]);
  const shadowed = [...called].filter(n => ids.has(n));
  // 允许调用撞名全局，但**必须**先做类型判断（typeof）。只写 `if (global.X)` 是不行的：
  // X 恒为真（元素存在）却不是函数，照样 TypeError。
  const unguarded = shadowed.filter(n => src.indexOf('typeof global.' + n) < 0);
  assert.strictEqual(unguarded.length, 0,
    '这些名字既是页面元素 id 又被当全局函数调用，且没有 typeof 判断：' + unguarded.join(', ') +
    ' —— 会拿到 DOM 元素去调用；换成 typeof 判断 + 不撞名的出口（如 window.FluxToast）');
  assert.ok(called.size >= 2, '全局调用点扫描结果为空，说明正则失效了（不是真通过）');
  // 顺带禁掉最危险的那个写法：对撞名全局做真值判断后调用
  const truthyOnShadowed = shadowed.filter(n => new RegExp('if\\s*\\(\\s*global\\.' + n + '\\s*\\)').test(src));
  assert.strictEqual(truthyOnShadowed.length, 0,
    '对撞名全局写了 `if (global.X)`（X 恒真但不是函数）：' + truthyOnShadowed.join(', '));
  // 反向确认：守卫的样本还在（改了 id 就会让这条守卫悄悄失效）
  assert.ok(ids.has('toast'), '产物里找不到 id="toast"，守卫样本没了，检查是否改了 id');
}

console.log('projects.js 自检通过：日期 7 · Star 7 · 表头 8 · 列序 2 · 筛选 13 · 边界 2 · 热点 18 · 库字段 6 · 全局遮蔽 1');
