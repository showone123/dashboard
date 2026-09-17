# -*- coding: utf-8 -*-
"""生成往返测试页：Excel(base64) → CuParser → 与 canonical JSON 逐项比对。"""
import base64, json, os

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)

xlsx = os.path.join(ROOT, "outputs", "铜期货源数据_20260915.xlsx")
with open(xlsx, "rb") as f:
    b64 = base64.b64encode(f.read()).decode()
with open(os.path.join(BUILD, "copper_data.json"), encoding="utf-8") as f:
    expect = json.load(f)
with open(os.path.join(BUILD, "parser.js"), encoding="utf-8") as f:
    parser = f.read()

# 只比对解析器应当还原的字段
CHECKS = [
    ("meta.contract", "meta.contract"),
    ("meta.date", "meta.date"),
    ("meta.exchange", "meta.exchange"),
    ("kline 根数", "kline.length"),
    ("kline 首根收盘", "kline.0.c"),
    ("kline 末根收盘", "kline.59.c"),
    ("kline 末根持仓", "kline.59.oi"),
    ("summary 收盘", "summary.close"),
    ("summary MA5", "summary.ma5"),
    ("summary MA20", "summary.ma20"),
    ("summary ATR", "summary.atr"),
    ("summary 涨跌幅", "summary.chgPct"),
    ("summary 60日高", "summary.high60"),
    ("contracts 合约数", "contracts.length"),
    ("term 近远月价差", "term.nearFarSpread"),
    ("term 主力-次主力", "term.mainSubSpread"),
    ("term 结构", "term.structure"),
    ("rank 成交量第一名", "rank.volume.0.name"),
    ("rank 成交量第一值", "rank.volume.0.value"),
    ("rank 净多净空", "rank.netLongShort"),
    ("warehouse 仓单", "warehouse.stocks"),
    ("warehouse 变化", "warehouse.change"),
    ("inventory 条数", "inventory.length"),
    ("options ATM", "options.atmStrike"),
    ("options 链第3档行权价", "options.chain.2.k"),
    ("options 链第3档ATM", "options.chain.2.atm"),
    ("options MaxPain", "options.maxPain"),
    ("options HV20", "options.hv20"),
    ("options 策略数", "options.strategies.length"),
    ("external 最新价", "external.close"),
    ("external 5日涨跌", "external.chg5d"),
    ("ratios 条数", "ratios.length"),
    ("ratios 第一条", "ratios.0.n"),
    ("trend 铜银比点数", "trend.cuag.length"),
    ("trend 金银比点数", "trend.auag.length"),
    ("sentiment 窗口数", "sentiment.windows.length"),
    ("sentiment 事件数", "sentiment.events.length"),
    ("sentiment 48h条数", "sentiment.total48h"),
    ("season 月数", "season.length"),
    ("season 9月收益", "season.8.r"),
    ("cost 开平合计", "cost.roundTrip"),
    ("cost 1手保证金", "cost.marginPerLot"),
    ("cost 平今", "cost.closeTodayFee"),
    ("识别到的表数", "__sheetCount"),
]

TPL = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"/><title>roundtrip</title></head>
<body><pre id="out">running…</pre>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script>
__PARSER__
</script>
<script>
var EXPECT = __EXPECT__;
var CHECKS = __CHECKS__;
var B64 = "__B64__";
function dig(o, path){
  var parts = path.split('.'), cur = o;
  for (var i=0;i<parts.length;i++){
    if (cur === null || cur === undefined) return undefined;
    var k = parts[i];
    if (/^\\d+$/.test(k)) k = parseInt(k,10);
    cur = cur[k];
  }
  return cur;
}
function run(){
  var bin = atob(B64);
  var arr = new Uint8Array(bin.length);
  for (var i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
  var wb = XLSX.read(arr, {type:'array', cellDates:false});
  var got = CuParser.build(wb, '铜期货源数据_20260915.xlsx');
  var lines = [], pass = 0, fail = 0;
  ["sheets=" + wb.SheetNames.length, "parsed_sheets=" + got.__sheetCount, ""].forEach(function(l){ lines.push(l); });
  CHECKS.forEach(function(c){
    var e = dig(EXPECT, c[1]), g = dig(got, c[1]);
    var ok = String(e) === String(g);
    if (ok) pass++; else fail++;
    lines.push((ok ? "PASS  " : "FAIL  ") + c[0] + "  expect=" + JSON.stringify(e) + "  got=" + JSON.stringify(g));
  });
  lines.push("");
  lines.push("RESULT pass=" + pass + " fail=" + fail);
  document.getElementById('out').textContent = lines.join("\\n");
}
try { run(); } catch(e){ document.getElementById('out').textContent = "ERROR " + (e && e.message ? e.message : e); }
</script>
</body></html>
"""

out = (TPL.replace("__PARSER__", parser)
          .replace("__EXPECT__", json.dumps(expect, ensure_ascii=False))
          .replace("__CHECKS__", json.dumps(CHECKS, ensure_ascii=False))
          .replace("__B64__", b64))
dest = os.path.join(BUILD, "roundtrip.html")
with open(dest, "w", encoding="utf-8") as f:
    f.write(out)
print("saved:", dest, len(out), "bytes")
