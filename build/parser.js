/* ==========================================================================
   数据契约解析器 (Data Contract Parser)
   把客户上传的多 sheet Excel 解析成本看板的统一渲染数据结构。
   与 build/make_excel.py 生成的模板一一对应。
   导出：window.CuParser.build(workbook, fileName) / CuParser.SHEETS
   ========================================================================== */
(function (global) {
  'use strict';

  var SHEETS = ['META', 'SUMMARY', 'KLINE', 'TECH', 'CONTRACTS', 'ROLL', 'RANK', 'RANK_META',
    'WAREHOUSE', 'INVENTORY', 'OPTIONS_META', 'OPTION_CHAIN', 'OPT_STRATEGY', 'EXTERNAL',
    'RATIOS', 'TREND', 'SENTIMENT', 'SENTIMENT_WINDOWS', 'SENTIMENT_EVENTS', 'SEASON', 'COST'];

  function fmtTime(t) {
    var d = new Date(t);
    if (isNaN(d.getTime())) return '';
    var z = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes());
  }

function sheetRows(wb, name) {
    var ws = wb.Sheets[name];
    if (!ws) return null;
    return XLSX.utils.sheet_to_json(ws, { defval: null, raw: true });
  }
  function kvOf(wb, name) {
    var rs = sheetRows(wb, name);
    var o = {};
    if (!rs) return o;
    rs.forEach(function (r) {
      var ks = Object.keys(r);
      if (!ks.length) return;
      var k = r[ks[0]], v = ks.length > 1 ? r[ks[1]] : null;
      if (k === null || k === undefined || String(k).trim() === '') return;
      o[String(k).trim()] = v;
    });
    return o;
  }
  function num(v, dflt) {
    if (v === null || v === undefined || v === '') return dflt === undefined ? null : dflt;
    var n = Number(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : (dflt === undefined ? null : dflt);
  }
  function normDay(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') { // Excel 序列号
      var d = new Date(Date.UTC(1899, 11, 30) + v * 86400000);
      return String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
    }
    var s = String(v).trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) { var p = s.slice(5, 10); return p; }
    if (/^\d{1,2}[-/.]\d{1,2}$/.test(s)) {
      var pp = s.split(/[-/.]/);
      return String(pp[0]).padStart(2, '0') + '-' + String(pp[1]).padStart(2, '0');
    }
    return s;
  }

  function buildDataFromWorkbook(wb, fileName) {
    var present = wb.SheetNames.filter(function (n) { return SHEETS.indexOf(n) >= 0; });
    if (!present.length) throw new Error('未识别到任何数据表。请使用导出的 Excel 模板（含 KLINE / META 等 sheet），当前 sheet：' + wb.SheetNames.join('、'));

    var metaKv = kvOf(wb, 'META');
    var sumKv = kvOf(wb, 'SUMMARY');

    // KLINE
    var klineRs = sheetRows(wb, 'KLINE') || [];
    var kline = [];
    klineRs.forEach(function (r) {
      var ks = Object.keys(r);
      var c = r['收盘'] !== undefined ? r['收盘'] : r[ks[4]];
      var o = r['开盘'] !== undefined ? r['开盘'] : r[ks[1]];
      var h = r['最高'] !== undefined ? r['最高'] : r[ks[2]];
      var l = r['最低'] !== undefined ? r['最低'] : r[ks[3]];
      if (num(c) === null) return;
      kline.push({
        d: normDay(r['日期'] !== undefined ? r['日期'] : r[ks[0]]),
        o: num(o, num(c)), h: num(h, num(c)), l: num(l, num(c)), c: num(c),
        v: num(r['成交量'], 0), oi: num(r['持仓量'], 0)
      });
    });
    if (!kline.length) throw new Error('KLINE 表没有可用数据行（需要「日期/开盘/最高/最低/收盘/成交量/持仓量」表头）。');

    // CONTRACTS
    var cRs = sheetRows(wb, 'CONTRACTS') || [];
    var contracts = cRs.map(function (r) {
      var ks = Object.keys(r);
      return {
        c: String(r['合约'] !== undefined ? r['合约'] : r[ks[0]] || ''),
        p: num(r['收盘价'] !== undefined ? r['收盘价'] : r[ks[1]]),
        set: num(r['结算价'] !== undefined ? r['结算价'] : r[ks[2]]),
        vol: num(r['成交量'] !== undefined ? r['成交量'] : r[ks[3]], 0),
        oi: num(r['持仓量'] !== undefined ? r['持仓量'] : r[ks[4]], 0)
      };
    }).filter(function (x) { return x.c && x.p !== null; });

    var mainContract = metaKv['主力合约'] ? String(metaKv['主力合约']) : '';
    if (!mainContract && contracts.length) {
      var best = contracts.slice().sort(function (a, b) { return (b.vol || 0) - (a.vol || 0); })[0];
      mainContract = best.c;
    }

    // SUMMARY（缺失时由 KLINE 推导）
    var closes = kline.map(function (b) { return b.c; });
    var last = kline[kline.length - 1], prev = kline[kline.length - 2] || last;
    var ma = function (n) {
      if (closes.length < 1) return null;
      var seg = closes.slice(Math.max(0, closes.length - n));
      return seg.reduce(function (a, b) { return a + b; }, 0) / seg.length;
    };
    var atrCalc = function (n) {
      if (kline.length < 2) return null;
      var trs = [];
      for (var i = Math.max(1, kline.length - n); i < kline.length; i++) {
        var a = kline[i], b = kline[i - 1];
        trs.push(Math.max(a.h - a.l, Math.abs(a.h - b.c), Math.abs(a.l - b.c)));
      }
      return trs.length ? trs.reduce(function (x, y) { return x + y; }, 0) / trs.length : null;
    };
    var d5 = num(sumKv['MA5'], ma(5)), d20 = num(sumKv['MA20'], ma(20));
    var hi = Math.max.apply(null, kline.map(function (b) { return b.h; }));
    var lo = Math.min.apply(null, kline.map(function (b) { return b.l; }));
    var summary = {
      close: num(sumKv['最新收盘'], last.c),
      prevClose: num(sumKv['前收盘'], prev.c),
      chg: num(sumKv['涨跌'], last.c - prev.c),
      chgPct: num(sumKv['涨跌幅%'], prev.c ? (last.c - prev.c) / prev.c * 100 : 0),
      ma5: d5, ma20: d20, atr: num(sumKv['ATR14'], atrCalc(14)),
      high60: num(sumKv['60日最高'], hi), low60: num(sumKv['60日最低'], lo),
      volume: num(sumKv['成交量'], last.v), openInterest: num(sumKv['持仓量'], last.oi),
      oiChange: num(sumKv['持仓变化'], last.oi - prev.oi)
    };
    summary.ma5Diff = num(sumKv['偏离MA5'], summary.ma5 ? summary.close - summary.ma5 : 0);
    summary.ma5DiffPct = num(sumKv['偏离MA5%'], summary.ma5 ? (summary.close - summary.ma5) / summary.ma5 * 100 : 0);
    summary.fromHigh = num(sumKv['距高点%'], hi ? (summary.close - hi) / hi * 100 : 0);
    summary.weekHigh = num(sumKv['本周最高'], hi);
    summary.weekLow = num(sumKv['本周最低'], lo);
    if (summary.ma5 === null) summary.ma5 = 0;
    if (summary.ma20 === null) summary.ma20 = 0;
    if (summary.atr === null) summary.atr = 0;

    // TECH
    var tRs = sheetRows(wb, 'TECH') || [];
    var tOrder = [], tMap = {};
    tRs.forEach(function (r) {
      var p = String(r['周期'] || '').trim();
      if (!p) return;
      if (!tMap[p]) { tMap[p] = { p: p, price: num(r['周期价格'], 0), items: [], tags: [], bias: String(r['综合偏向'] || ''), biasCls: 'neu' }; tOrder.push(p); }
      var t = tMap[p];
      if (r['周期价格'] !== undefined && r['周期价格'] !== null) t.price = num(r['周期价格'], t.price);
      if (r['综合偏向']) t.bias = String(r['综合偏向']);
      var tags = String(r['标签'] || '').split('/').map(function (s) { return s.trim(); }).filter(Boolean);
      tags.forEach(function (x) { if (t.tags.indexOf(x) < 0) t.tags.push(x); });
      if (r['指标'] !== undefined && r['指标'] !== null) {
        t.items.push({ n: String(r['指标']), v: String(r['数值'] === null || r['数值'] === undefined ? '' : r['数值']), d: String(r['方向'] || 'neu') });
      }
    });
    var tech = tOrder.map(function (p) {
      var t = tMap[p];
      var up = t.items.filter(function (i) { return i.d === 'up'; }).length;
      var dn = t.items.filter(function (i) { return i.d === 'down'; }).length;
      t.biasCls = up - dn >= 2 ? 'up' : (dn - up >= 2 ? 'down' : 'neu');
      return t;
    });

    // TERM
    var term = {};
    if (contracts.length >= 2) {
      var near = contracts[0], mainC = contracts.filter(function (c) { return c.c === mainContract; })[0] || contracts[1];
      var far = contracts[contracts.length - 1];
      var idx = contracts.indexOf(mainC);
      var sub = contracts[idx + 1] || contracts[idx];
      var rollRs = sheetRows(wb, 'ROLL') || [];
      var roll = rollRs.map(function (r) {
        var ks = Object.keys(r);
        return { name: String(r['组合'] !== undefined ? r['组合'] : r[ks[0]]), spread: num(r['价差'], 0), annual: num(r['年化%'], 0) };
      });
      if (!roll.length && idx >= 0) {
        roll = [
          { name: '主力-次主力 (' + mainC.c + '-' + sub.c + ')', spread: mainC.p - sub.p, annual: (mainC.p - sub.p) / mainC.p * 12 * 100 },
          { name: '近月-主力 (' + near.c + '-' + mainC.c + ')', spread: near.p - mainC.p, annual: (near.p - mainC.p) / near.p * 12 * 100 }
        ];
      }
      term = {
        structure: (near.p - far.p) >= 0 ? 'Backwardation' : 'Contango',
        near: near.p, main: mainC.p, far: far.p,
        nearFarSpread: near.p - far.p, mainSubSpread: mainC.p - sub.p,
        roll: roll.map(function (r) { return { name: r.name, spread: r.spread, annual: Number(r.annual).toFixed(2) }; }),
        note: ''
      };
    }

    // RANK
    var kRs = sheetRows(wb, 'RANK') || [];
    var rank = { volume: [], long: [], short: [] };
    kRs.forEach(function (r) {
      var type = String(r['类型'] || '');
      var item = { rank: num(r['排名'], 0), name: String(r['会员'] || ''), value: num(r['数值'], 0), change: num(r['变化'], 0) };
      if (type.indexOf('成交') >= 0) rank.volume.push(item);
      else if (type.indexOf('多') >= 0) rank.long.push(item);
      else if (type.indexOf('空') >= 0) rank.short.push(item);
    });
    var rkKv = kvOf(wb, 'RANK_META');
    rank.top20 = {
      volume: num(rkKv['前20成交量'], 0), volumeChange: num(rkKv['前20成交量变化'], 0),
      long: num(rkKv['前20多头'], 0), longChange: num(rkKv['前20多头变化'], 0),
      short: num(rkKv['前20空头'], 0), shortChange: num(rkKv['前20空头变化'], 0)
    };
    rank.netLongShort = num(rkKv['净多净空差'], (rank.top20.long || 0) - (rank.top20.short || 0));
    rank.signal = String(rkKv['信号'] || (rank.netLongShort >= 0 ? '净多增加' : '净空增加'));

    // WAREHOUSE / INVENTORY
    var wKv = kvOf(wb, 'WAREHOUSE');
    var warehouse = {
      stocks: num(wKv['最新仓单'], 0), change: num(wKv['变化'], 0),
      exchange: String(wKv['交易所'] || metaKv['交易所'] || ''), date: String(wKv['日期'] || metaKv['数据日期'] || ''),
      note: String(wKv['解读'] || '')
    };
    var inventory = (sheetRows(wb, 'INVENTORY') || []).map(function (r) {
      var ks = Object.keys(r);
      return { name: String(r['指标'] !== undefined ? r['指标'] : r[ks[0]]), value: String(r['数值'] !== undefined ? r['数值'] : r[ks[1]]), unit: String(r['单位'] !== undefined ? r['单位'] : r[ks[2]] || ''), asOf: String(r['截止日期'] !== undefined ? r['截止日期'] : r[ks[3]] || ''), note: String(r['备注'] !== undefined ? r['备注'] : r[ks[4]] || '') };
    });

    // OPTIONS
    var oKv = kvOf(wb, 'OPTIONS_META');
    var chainRs = sheetRows(wb, 'OPTION_CHAIN') || [];
    var options = null;
    if (Object.keys(oKv).length || chainRs.length) {
      var stRs = sheetRows(wb, 'OPT_STRATEGY') || [];
      var sGroups = [], sIdx = {};
      stRs.forEach(function (r) {
        var nm = String(r['策略'] || '');
        if (!sIdx[nm]) { sIdx[nm] = { name: nm, cls: sGroups.length === 1 ? 'gl' : 'up', rows: [] }; sGroups.push(sIdx[nm]); }
        sIdx[nm].rows.push([String(r['项目'] || ''), String(r['内容'] === null || r['内容'] === undefined ? '' : r['内容'])]);
      });
      options = {
        contract: String(oKv['标的合约'] || mainContract),
        date: String(oKv['数据日期'] || metaKv['数据日期'] || ''),
        atmStrike: num(oKv['ATM行权价'], 0), callPrice: num(oKv['Call价格'], 0), putPrice: num(oKv['Put价格'], 0),
        callDelta: num(oKv['CallDelta'], 0), futuresPrice: num(oKv['标的期货价'], 0), maxPain: num(oKv['MaxPain'], 0),
        hv20: num(oKv['HV20'], 0), hv60: num(oKv['HV60'], 0),
        pcrOi: num(oKv['PCR(OI)'], 0), pcrVolume: num(oKv['PCR(Vol)'], 0),
        totalCallOi: num(oKv['总CallOI'], 0), totalPutOi: num(oKv['总PutOI'], 0),
        pcrSignal: String(oKv['PCR信号'] || ''), volNote: String(oKv['波动率解读'] || ''),
        strategies: sGroups,
        chain: chainRs.map(function (r) {
          var ks = Object.keys(r);
          var atm = String(r['是否ATM'] || '') === '是';
          return {
            k: num(r['行权价'] !== undefined ? r['行权价'] : r[ks[0]], 0),
            cp: num(r['Call结算'], 0), cv: num(r['Call量'], 0), co: num(r['Call持仓'], 0), cd: num(r['CallDelta'], 0),
            pp: num(r['Put结算'], 0), pv: num(r['Put量'], 0), po: num(r['Put持仓'], 0), pd: num(r['PutDelta'], 0),
            atm: atm
          };
        }).filter(function (x) { return x.k; })
      };
    }

    // EXTERNAL
    var eKv = kvOf(wb, 'EXTERNAL');
    var external = {
      name: String(eKv['品种'] || ''), symbol: String(eKv['代码'] || ''), close: num(eKv['最新价'], 0),
      date: String(eKv['日期'] || ''), chg1d: num(eKv['1日涨跌%'], 0), chg5d: num(eKv['5日涨跌%'], 0),
      ma5: num(eKv['MA5'], 0), ma20: num(eKv['MA20'], 0)
    };

    // RATIOS
    var ratios = (sheetRows(wb, 'RATIOS') || []).map(function (r) {
      var ks = Object.keys(r);
      return {
        n: String(r['比价'] !== undefined ? r['比价'] : r[ks[0]]),
        v: String(r['当前值'] !== undefined ? r['当前值'] : r[ks[1]]),
        pct: String(r['10年分位'] !== undefined ? r['10年分位'] : r[ks[2]]),
        sig: String(r['信号'] !== undefined ? r['信号'] : r[ks[3]] || ''),
        d: String(r['方向'] !== undefined ? r['方向'] : r[ks[4]] || 'neu')
      };
    });

    // TREND
    var trendRs = sheetRows(wb, 'TREND') || [];
    var cuag = [], auag = [];
    trendRs.forEach(function (r) {
      var ks = Object.keys(r);
      var a = num(r['铜银比'] !== undefined ? r['铜银比'] : r[ks[1]], null);
      var b = num(r['金银比'] !== undefined ? r['金银比'] : r[ks[2]], null);
      if (a !== null) cuag.push(a);
      if (b !== null) auag.push(b);
    });

    // SENTIMENT
    var sKv = kvOf(wb, 'SENTIMENT');
    var wRs = sheetRows(wb, 'SENTIMENT_WINDOWS') || [];
    var evRs = sheetRows(wb, 'SENTIMENT_EVENTS') || [];
    var sentiment = null;
    if (Object.keys(sKv).length || wRs.length || evRs.length) {
      sentiment = {
        snapshot: String(sKv['快照时间'] || ''),
        total48h: num(sKv['48h条数'], 0), total24h: num(sKv['24h条数'], 0),
        alertCount: num(sKv['高影响力事件'], 0),
        signal: String(sKv['当前信号'] || ''), momentum: String(sKv['动量方向'] || ''),
        shift: String(sKv['边际变化'] || ''), weekly: String(sKv['中长期'] || ''),
        macroNote: String(sKv['宏观占比说明'] || ''),
        windows: wRs.map(function (r) {
          var ks = Object.keys(r);
          return {
            label: String(r['窗口'] !== undefined ? r['窗口'] : r[ks[0]]),
            score: num(r['打分'] !== undefined ? r['打分'] : r[ks[1]], 0),
            verdict: String(r['判定'] !== undefined ? r['判定'] : r[ks[2]] || '中性'),
            count: num(r['条数'] !== undefined ? r['条数'] : r[ks[3]], 0)
          };
        }),
        events: evRs.map(function (r) {
          var ks = Object.keys(r);
          return {
            sc: num(r['评分'] !== undefined ? r['评分'] : r[ks[0]], 0),
            tag: String(r['标签'] !== undefined ? r['标签'] : r[ks[1]] || ''),
            time: String(r['时间'] !== undefined ? r['时间'] : r[ks[2]] || ''),
            txt: String(r['内容'] !== undefined ? r['内容'] : r[ks[3]] || '')
          };
        })
      };
    }

    // SEASON
    var season = (sheetRows(wb, 'SEASON') || []).map(function (r) {
      var ks = Object.keys(r);
      return {
        m: String(r['月份'] !== undefined ? r['月份'] : r[ks[0]]),
        r: num(r['平均收益率%'] !== undefined ? r['平均收益率%'] : r[ks[1]], 0),
        w: num(r['胜率%'] !== undefined ? r['胜率%'] : r[ks[2]], 0)
      };
    });

    // COST
    var cKv = kvOf(wb, 'COST');
    var cost = Object.keys(cKv).length ? {
      price: num(cKv['计算价格'], summary.close), volumeMultiple: num(cKv['合约乘数'], 5),
      priceTick: num(cKv['最小变动价位'], 1),
      openFee: num(cKv['开仓手续费'], 0), closeFee: num(cKv['平仓手续费'], 0), closeTodayFee: num(cKv['平今手续费'], 0),
      roundTrip: num(cKv['开平合计'], 0),
      exOpen: num(cKv['交易所开仓'], 0), exClose: num(cKv['交易所平仓'], 0), exRoundTrip: num(cKv['交易所开平合计'], 0),
      commissionRate: num(cKv['公司单边费率%'], 0), exRate: num(cKv['交易所费率%'], 0),
      closeTodayRate: num(cKv['公司平今费率%'], 0),
      marginRate: num(cKv['保证金率%'], 0), marginPerLot: num(cKv['1手保证金'], 0),
      marginModel: String(cKv['保证金模型'] || '')
    } : null;

    var meta = {
      product: String(metaKv['product'] || 'cu'), productName: String(metaKv['产品名称'] || '铜'),
      exchange: String(metaKv['交易所'] || ''), unit: String(metaKv['价格单位'] || '元/吨'),
      contract: mainContract, continuous: String(metaKv['连续合约'] || ''),
      date: String(metaKv['数据日期'] || (kline[kline.length - 1] ? '20' + '' : '')),
      generatedAt: String(metaKv['生成时间'] || fmtTime(new Date())),
      source: String(metaKv['数据来源'] || '客户上传'), project: String(metaKv['项目'] || ''),
      disclaimer: String(metaKv['免责声明'] || '仅供研究参考，不构成投资建议')
    };
    if (!meta.date || meta.date === '20' ) meta.date = (function () {
      var d = new Date(), z = function (n) { return String(n).padStart(2, '0'); };
      return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
    })();
    if (fileName) meta.project = meta.project || fileName;

    var out = {
      meta: meta, summary: summary, kline: kline, tech: tech, contracts: contracts, term: term,
      rank: rank, warehouse: warehouse, inventory: inventory, options: options, external: external,
      ratios: ratios, trend: { cuag: cuag, auag: auag }, sentiment: sentiment, season: season, cost: cost
    };
    out.__sheetCount = present.length;
    out.__sheets = wb.SheetNames;
    return out;
  }

  global.CuParser = { build: buildDataFromWorkbook, SHEETS: SHEETS };
})(window);
