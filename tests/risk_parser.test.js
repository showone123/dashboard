const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

global.XLSX = require('../vendor/xlsx.full.min.js');
vm.runInThisContext(fs.readFileSync(require.resolve('../build/risk_parser.js'), 'utf8'));

const rows = [
  ['交易日', '事件发生日期', '事件发生时间', '资金帐号', '客户姓名', '登录IP地址', '登录MAC地址', '客户端类型', '部门'],
  ['20260901', '20260901', '09:00:00', '35010001', '客户甲', '10.0.0.1', '00-1c-42-05-f3-bc', 'PC', '成都'],
  ['20260901', '20260901', '09:10:00', '35010002', '客户乙', '10.0.0.2', '001C4205F3BC', 'PC', '成都'],
  ['20260901', '20260901', '09:20:00', '56590001', '客户丙', '10.0.0.3', '001C4205F3BC', '移动端', '成都'],
  ['20260901', '20260901', '10:00:00', '35250001', '客户丁', '10.0.0.4', 'AABBCCDDEEFF', 'PC', '成都']
];

const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
const data = RiskLogParser.build(wb, 'risk.xlsx');

assert.strictEqual(data.validRows, 4);
assert.strictEqual(data.uniqueMacs, 2);
assert.strictEqual(data.uniqueAccounts, 4);
assert.strictEqual(data.groups[0].mac, '00:1C:42:05:F3:BC');
assert.strictEqual(data.groups[0].accountCount, 3);
assert.strictEqual(RiskLogParser.filter(data, { prefixes: '3501', minAccounts: 2 }).length, 1);
assert.strictEqual(RiskLogParser.filter(data, { prefixes: '3525', minAccounts: 2 }).length, 0);
assert.strictEqual(RiskLogParser.filter(data, { query: '客户乙', minAccounts: 2 }).length, 1);
assert.deepStrictEqual(RiskLogParser.parsePrefixes('3501，3502 3501'), ['3501', '3502']);

console.log('risk_parser tests passed');
