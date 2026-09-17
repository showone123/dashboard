/* ========================================================================== 
   期货账户实控人风险日志解析器
   纯解析模块：不访问网络、不操作 DOM，只把 Excel 汇总成可筛选的数据结构。
   ========================================================================== */
(function (root) {
  'use strict';

  var FIELD_ALIASES = {
    account: ['资金账号', '资金帐号', '账号', '帐号', '客户号', 'account', 'accountid'],
    customer: ['客户姓名', '客户名称', '客户名', '姓名', 'customer', 'customername'],
    mac: ['登录mac地址', 'mac地址', 'mac', '物理地址', '客户端mac'],
    tradeDate: ['交易日', '业务日期', 'tradedate'],
    eventDate: ['事件发生日期', '发生日期', '登录日期', '日期', 'eventdate'],
    eventTime: ['事件发生时间', '发生时间', '登录时间', '时间', 'eventtime'],
    ip: ['登录ip地址', 'ip地址', 'ip', '客户端ip'],
    clientType: ['客户端类型', '终端类型', '登录类型', 'clienttype'],
    department: ['部门', '营业部', '机构', 'department']
  };

  function text(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && isFinite(v)) return Math.floor(v) === v ? String(Math.floor(v)) : String(v);
    return String(v).trim();
  }

  function norm(v) {
    return text(v).toLowerCase().replace(/[\s_\-—–:：()（）【】\[\].。/\\]+/g, '');
  }

  function aliasSet(list) {
    var out = {};
    list.forEach(function (v) { out[norm(v)] = true; });
    return out;
  }

  var ALIASES = {};
  Object.keys(FIELD_ALIASES).forEach(function (k) { ALIASES[k] = aliasSet(FIELD_ALIASES[k]); });

  function mapHeader(row) {
    var map = {}, score = 0;
    for (var c = 0; c < row.length; c++) {
      var h = norm(row[c]);
      if (!h) continue;
      Object.keys(ALIASES).some(function (field) {
        if (map[field] === undefined && ALIASES[field][h]) {
          map[field] = c; score++; return true;
        }
        return false;
      });
    }
    return { map: map, score: score };
  }

  function findTable(wb) {
    var best = null;
    (wb.SheetNames || []).forEach(function (sheetName) {
      var ws = wb.Sheets[sheetName];
      if (!ws || !ws['!ref']) return;
      var range = XLSX.utils.decode_range(ws['!ref']);
      var last = Math.min(range.e.r, range.s.r + 29);
      for (var r = range.s.r; r <= last; r++) {
        var row = [];
        for (var c = range.s.c; c <= range.e.c; c++) {
          var cell = ws[XLSX.utils.encode_cell({ r: r, c: c })];
          row.push(cell ? cell.v : '');
        }
        var hit = mapHeader(row);
        if (hit.map.account !== undefined && hit.map.customer !== undefined && hit.map.mac !== undefined) {
          if (!best || hit.score > best.score) best = { sheetName: sheetName, headerRow: r, map: hit.map, score: hit.score };
        }
      }
    });
    if (!best) {
      throw new Error('未找到风险日志表头。至少需要“资金帐号/资金账号、客户姓名、登录MAC地址”三列。');
    }
    return best;
  }

  function macKey(v) {
    var raw = text(v).toUpperCase();
    var compact = raw.replace(/[^0-9A-F]/g, '');
    return compact.length === 12 ? compact : raw;
  }

  function macLabel(key) {
    return /^[0-9A-F]{12}$/.test(key) ? key.match(/.{2}/g).join(':') : key;
  }

  function when(row, map) {
    var d = map.eventDate !== undefined ? text(row[map.eventDate]) : '';
    if (!d && map.tradeDate !== undefined) d = text(row[map.tradeDate]);
    var t = map.eventTime !== undefined ? text(row[map.eventTime]) : '';
    return (d + (d && t ? ' ' : '') + t).trim();
  }

  function addUnique(arr, value, max) {
    value = text(value);
    if (value && arr.indexOf(value) < 0 && arr.length < (max || 20)) arr.push(value);
  }

  function build(wb, fileName) {
    if (!wb || !wb.Sheets) throw new Error('Excel 工作簿无效');
    var table = findTable(wb);
    var ws = wb.Sheets[table.sheetName];
    var rows = XLSX.utils.sheet_to_json(ws, {
      header: 1, raw: true, defval: '', blankrows: false, range: table.headerRow
    });
    var map = table.map, groups = {}, validRows = 0, skippedRows = 0;
    var firstEvent = '', lastEvent = '';

    for (var i = 1; i < rows.length; i++) {
      var row = rows[i];
      var account = text(row[map.account]);
      var customer = text(row[map.customer]);
      var key = macKey(row[map.mac]);
      if (!account || !key) { skippedRows++; continue; }
      validRows++;
      var stamp = when(row, map);
      if (stamp && (!firstEvent || stamp < firstEvent)) firstEvent = stamp;
      if (stamp && (!lastEvent || stamp > lastEvent)) lastEvent = stamp;

      var g = groups[key];
      if (!g) g = groups[key] = {
        mac: macLabel(key), macKey: key, totalEvents: 0, firstEvent: '', lastEvent: '',
        accountMap: {}, ips: [], clientTypes: [], departments: []
      };
      g.totalEvents++;
      if (stamp && (!g.firstEvent || stamp < g.firstEvent)) g.firstEvent = stamp;
      if (stamp && (!g.lastEvent || stamp > g.lastEvent)) g.lastEvent = stamp;
      if (map.ip !== undefined) addUnique(g.ips, row[map.ip], 8);
      if (map.clientType !== undefined) addUnique(g.clientTypes, row[map.clientType], 8);
      if (map.department !== undefined) addUnique(g.departments, row[map.department], 8);

      var a = g.accountMap[account];
      if (!a) a = g.accountMap[account] = { account: account, customers: [], count: 0, firstEvent: '', lastEvent: '' };
      a.count++;
      addUnique(a.customers, customer, 6);
      if (stamp && (!a.firstEvent || stamp < a.firstEvent)) a.firstEvent = stamp;
      if (stamp && (!a.lastEvent || stamp > a.lastEvent)) a.lastEvent = stamp;
    }

    var outGroups = Object.keys(groups).map(function (key) {
      var g = groups[key];
      g.accounts = Object.keys(g.accountMap).map(function (account) { return g.accountMap[account]; })
        .sort(function (a, b) { return a.account.localeCompare(b.account, 'zh-CN', { numeric: true }); });
      g.accountCount = g.accounts.length;
      delete g.accountMap;
      return g;
    }).sort(function (a, b) {
      return b.accountCount - a.accountCount || b.totalEvents - a.totalEvents || a.mac.localeCompare(b.mac);
    });

    var uniqueAccounts = {};
    outGroups.forEach(function (g) { g.accounts.forEach(function (a) { uniqueAccounts[a.account] = true; }); });
    return {
      fileName: fileName || '', sheetName: table.sheetName, headerRow: table.headerRow + 1,
      columns: map, validRows: validRows, skippedRows: skippedRows,
      uniqueMacs: outGroups.length, uniqueAccounts: Object.keys(uniqueAccounts).length,
      firstEvent: firstEvent, lastEvent: lastEvent, groups: outGroups,
      sheets: wb.SheetNames.slice()
    };
  }

  function parsePrefixes(input) {
    var seen = {};
    return text(input).split(/[\s,，;；]+/).map(function (v) { return v.trim(); }).filter(function (v) {
      if (!v || seen[v]) return false; seen[v] = true; return true;
    });
  }

  function filter(data, opts) {
    opts = opts || {};
    var prefixes = parsePrefixes(opts.prefixes || '');
    var query = text(opts.query).toLowerCase();
    var minAccounts = Math.max(2, Number(opts.minAccounts) || 2);
    return (data && data.groups ? data.groups : []).filter(function (g) {
      if (g.accountCount < minAccounts) return false;
      if (prefixes.length && !g.accounts.some(function (a) {
        return prefixes.some(function (p) { return a.account.indexOf(p) === 0; });
      })) return false;
      if (query) {
        var hay = [g.mac, g.macKey].concat(g.accounts.map(function (a) {
          return a.account + ' ' + a.customers.join(' ');
        })).join(' ').toLowerCase();
        if (hay.indexOf(query) < 0) return false;
      }
      return true;
    });
  }

  root.RiskLogParser = { build: build, filter: filter, parsePrefixes: parsePrefixes, mapHeader: mapHeader };
})(typeof window !== 'undefined' ? window : globalThis);
