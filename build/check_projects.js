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

console.log('projects.js 自检通过：日期 7 · Star 7 · 表头 8 · 列序 2 · 筛选 13 · 边界 2');
