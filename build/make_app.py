# -*- coding: utf-8 -*-
"""组装单文件应用 index.html：CDN SDK + theme.css + app.css + render.js + seed + app.js"""
import json, os

BUILD = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BUILD)


def rd(n):
    with open(os.path.join(BUILD, n), encoding="utf-8") as f:
        return f.read()


theme = rd("theme.css")
appcss = rd("app.css")
render = rd("render.js")
parser = rd("parser.js")
risk_parser = rd("risk_parser.js")
exporter = rd("exporter.js")
appjs = rd("app.js")
seed_raw = rd("copper_data.json")
# 内嵌 JSON 里不能出现 </script>
seed_raw = seed_raw.replace("<", "\\u003c")

TPL = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>铜数据看板 · 订阅版</title>
<meta name="description" content="数据看板订阅服务：客户上传数据，云端渲染成专业看板。"/>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%23f0b429'/%3E%3Ctext x='32' y='44' font-family='Arial,Helvetica,sans-serif' font-size='34' font-weight='700' fill='%23151a22' text-anchor='middle'%3ECu%3C/text%3E%3C/svg%3E"/>
<style id="wbTheme">
__THEME__
</style>
<style id="wbAppCss">
__APPCSS__
</style>
</head>
<body class="app-body">

<!-- ==================== 认证 ==================== -->
<div class="auth-wrap" id="viewAuth">
  <div class="auth-card">
    <div class="auth-head">
      <div class="logo-dot">Cu</div>
      <div>
        <div class="ttl">数据看板订阅服务</div>
        <div class="sub">DATA DASHBOARD · SUBSCRIPTION</div>
      </div>
    </div>
    <div class="auth-desc">
      上传你的数据文件，云端自动渲染成专业看板。<br/>
      首次使用请先注册；注册后由管理员开通访问权限。
    </div>
    <div class="seg">
      <button id="segLogin" class="on" type="button">登录</button>
      <button id="segSignup" type="button">注册</button>
    </div>
    <div id="authForm"></div>
    <div class="msg" id="authMsg"></div>
  </div>
</div>

<!-- ==================== 权限拦截 ==================== -->
<div class="gate-wrap hidden" id="viewGate">
  <div class="gate-card" id="gateCard">
    <div class="gate-title red" id="gateTitle">您暂时没有访问权限</div>
    <div class="gate-sub" id="gateSub"></div>
    <div class="gate-kv" id="gateKv"></div>
    <div class="gov">
      <button class="btn primary" id="btnGateRetry" type="button">重新检查权限</button>
      <button class="btn" id="btnCopyUidGate" type="button">复制我的用户 ID</button>
      <button class="btn" id="btnGateSignOut" type="button">退出登录</button>
    </div>
  </div>
</div>

<!-- ==================== 应用主体 ==================== -->
<div class="hidden" id="viewApp">
  <header class="appbar">
    <div class="brand">
      <div class="logo-dot">Cu</div>
      <div>
        <div class="t">数据看板<span class="sep">|</span>订阅版</div>
        <div class="sub" id="dataSource">示例数据（铜）</div>
      </div>
    </div>
    <nav class="app-tabs">
      <button class="app-tab active" data-tab="dash" type="button">数据看板</button>
      <button class="app-tab" data-tab="upload" type="button">上传数据</button>
      <button class="app-tab" data-tab="history" type="button">历史数据</button>
      <button class="app-tab" data-tab="risk" type="button">实控人风险日志</button>
      <button class="app-tab hidden" data-tab="admin" id="tabAdmin" type="button">运营台<span class="dotbadge hidden" id="adminBadge">0</span></button>
    </nav>
    <div class="me">
      <button class="bell" id="btnBell" type="button" aria-label="消息通知" title="通知">
        <span class="bell-ic">🔔</span><span class="bell-dot hidden" id="bellDot"></span>
      </button>
      <span class="chip good" id="mePlan">已开通</span>
      <span class="who" id="meWho">—</span>
      <button class="btn sm" id="btnSetPwd" type="button" title="给当前账号设置或重设登录密码">设置密码</button>
      <button class="btn sm" id="btnSignOut" type="button">退出</button>
    </div>
  </header>

  <!-- 通知浮窗（首页右上角 🔔 点开） -->
  <div class="notif hidden" id="notifPanel" role="dialog" aria-label="消息通知">
    <div class="notif-head">
      <div class="notif-ttl">消息通知 <span class="notif-cnt" id="notifCnt"></span></div>
      <button class="btn sm" id="notifRefresh" type="button">刷新</button>
    </div>
    <div class="notif-list" id="notifList"></div>
    <div class="notif-foot" id="notifFoot"></div>
  </div>

  <!-- 看板 -->
  <section class="panel active" id="panelDash">
    <div id="cuRoot"></div>
    <button class="export-fab" id="btnExport" type="button" title="把当前看板导出为文件">
      <span class="ef-ic">⤓</span><span>导出成果</span>
    </button>
  </section>

  <!-- 上传 -->
  <section class="panel" id="panelUpload">
    <div class="panel-pad">
      <div class="section">
        <h3>上传数据文件</h3>
        <div class="hint">
          支持 <b>.xlsx / .xls / .csv</b>，单文件不超过 <b>8 MB</b>。<br/>
          使用我们导出的模板填写即可：保留 <b>sheet 名称与表头行</b>，直接替换数值。数据越完整，看板页面越全。
        </div>
        <div class="mt14 row-flex">
          <button class="btn sm" id="btnTemplate" type="button">下载精简模板</button>
          <button class="btn sm" id="btnSample" type="button">切回示例数据</button>
        </div>
      </div>

      <div class="section">
        <div class="drop" id="drop">
          <div class="big">📄</div>
          <div class="t1">点击选择文件，或把 Excel 拖到这里</div>
          <div class="t2">解析在浏览器本地完成，确认后才会上传到云端</div>
        </div>
        <input type="file" id="fileInput" accept=".xlsx,.xls,.csv" class="hidden"/>

        <div class="preview" id="preview">
          <div class="kv-grid" id="previewGrid"></div>
          <div class="msg show info mt14" id="previewWarn" style="display:block"></div>
          <div class="actions">
            <button class="btn primary" id="btnUpload" type="button">确认上传并渲染</button>
            <button class="btn" id="btnCancelUpload" type="button">取消</button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 历史 -->
  <section class="panel" id="panelHistory">
    <div class="panel-pad">
      <div class="section">
        <div class="row-flex" style="justify-content:space-between">
          <h3 style="margin:0">历史数据 <span class="mono-small" id="histCount"></span></h3>
          <div class="row-flex">
            <button class="btn sm" id="btnRefreshHist" type="button">刷新</button>
            <button class="btn sm primary" id="btnDownAll" type="button">下载全部</button>
          </div>
        </div>
        <div class="hint mt8">所有上传过的文件都保存在你的专属云端目录里，只有你自己能读取。<b>下载全部</b>会打包成一个 ZIP 一次取走。</div>
        <div class="tbl-wrap mt14">
          <table class="tbl">
            <thead><tr>
              <th class="l">文件名</th><th class="l">数据日期</th><th>大小</th><th>数据表</th>
              <th class="l">上传时间</th><th class="l">操作</th>
            </tr></thead>
            <tbody id="histBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>

  <!-- 实控人风险日志 -->
  <section class="panel" id="panelRisk">
    <div class="panel-pad risk-workbench">
      <div class="section">
        <div class="risk-title-row">
          <div>
            <h3>期货账户实控人风险日志</h3>
            <div class="hint">上传风险日志后，系统按 MAC 汇总资金账号和客户姓名。最新上传自动成为当前版本，历史版本继续保留。</div>
          </div>
          <div class="row-flex">
            <button class="btn sm" id="btnRiskRefresh" type="button">刷新历史</button>
            <button class="btn sm" id="btnRiskPick" type="button">选择 Excel</button>
          </div>
        </div>
        <input type="file" id="riskFileInput" accept=".xlsx,.xls,.csv" class="hidden"/>
        <div class="risk-drop" id="riskDrop">
          <div class="big">MAC</div>
          <div><b>点击或拖入风险日志</b></div>
          <div class="hint">支持 .xlsx / .xls / .csv，单文件不超过 20 MB。文件先在浏览器本地解析，确认后才上传。</div>
        </div>
        <div class="preview" id="riskPreview">
          <div class="kv-grid" id="riskPreviewGrid"></div>
          <div class="msg show info mt14" id="riskPreviewMsg" style="display:block"></div>
          <div class="actions">
            <button class="btn primary" id="btnRiskUpload" type="button">保存为当前版本</button>
            <button class="btn" id="btnRiskCancel" type="button">取消</button>
          </div>
        </div>
      </div>

      <div class="section" id="riskResultsSection">
        <div class="risk-title-row">
          <div>
            <h3 id="riskCurrentTitle">筛选结果</h3>
            <div class="hint" id="riskCurrentMeta">请先上传或载入一份风险日志。</div>
          </div>
          <button class="btn sm" id="btnRiskExport" type="button" disabled>导出筛选结果</button>
        </div>
        <div class="risk-filters mt14">
          <div class="field">
            <label>资金账号号段（前四位，可输入多个）</label>
            <input id="riskPrefixes" type="text" inputmode="numeric" placeholder="例如：3501 3502，留空表示全部"/>
          </div>
          <div class="field">
            <label>MAC / 资金账号 / 客户姓名</label>
            <input id="riskQuery" type="text" placeholder="输入关键字快速查找"/>
          </div>
          <div class="field risk-threshold">
            <label>异常门槛</label>
            <select id="riskMinAccounts">
              <option value="2">2 个及以上账号</option>
              <option value="3">3 个及以上账号</option>
              <option value="4">4 个及以上账号</option>
            </select>
          </div>
          <button class="btn primary" id="btnRiskFilter" type="button">筛选</button>
          <button class="btn" id="btnRiskClear" type="button">清空</button>
        </div>
        <div class="kv-grid risk-summary" id="riskSummary"></div>
        <div class="tbl-wrap mt14">
          <table class="tbl risk-table">
            <thead><tr><th class="l">MAC 地址</th><th class="l">关联资金账号与客户</th><th>账号数</th><th>登录记录</th><th class="l">最近事件</th></tr></thead>
            <tbody id="riskBody"><tr><td colspan="5"><div class="empty-state">暂无数据</div></td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="section">
        <div class="risk-title-row">
          <div><h3>历史版本 <span class="mono-small" id="riskHistCount"></span></h3><div class="hint">载入任一旧版本即可按相同条件重新筛选。</div></div>
        </div>
        <div class="tbl-wrap mt14"><table class="tbl"><thead><tr><th class="l">文件名</th><th>大小</th><th class="l">上传时间</th><th class="l">操作</th></tr></thead><tbody id="riskHistBody"></tbody></table></div>
      </div>
    </div>
  </section>

  <!-- 运营台 -->
  <section class="panel" id="panelAdmin">
    <div class="panel-pad">
      <div class="section">
        <div class="row-flex" style="justify-content:space-between">
          <h3 style="margin:0">通知发布 <span class="chip warn" id="notifAdminCnt">—</span></h3>
          <div class="row-flex">
            <button class="btn sm" id="btnNewNotif" type="button">新建</button>
            <button class="btn sm" id="btnRefreshNotif" type="button">刷新</button>
          </div>
        </div>
        <div class="hint mt8">
          这里写的内容会出现在<strong>所有已开通客户</strong>首页右上角的 🔔 里。<br/>
          不勾「立即发布」就是<b>草稿</b>：客户看不到，只有运营方能预览。
        </div>

        <div class="nform mt14" id="notifForm">
          <div class="nform-row">
            <div class="field" style="margin:0;flex:1">
              <label>标题</label>
              <input id="nTitleIn" type="text" maxlength="80" placeholder="例如：9 月 20 日 17:00-19:00 系统维护通知"/>
            </div>
            <div class="field" style="margin:0;width:150px">
              <label>级别</label>
              <select id="nLevelIn">
                <option value="info">通知（灰）</option>
                <option value="warn">提醒（金）</option>
                <option value="important">重要（红）</option>
              </select>
            </div>
          </div>
          <div class="field" style="margin:12px 0 0">
            <label>内容<span class="fl-note">（支持换行，客户点开可见全文）</span></label>
            <textarea id="nBodyIn" rows="5" maxlength="4000" placeholder="例如：本次维护期间看板与文件上传会短暂不可用，维护完成后刷新页面即可恢复。如遇异常请联系管理员。"></textarea>
          </div>
          <div class="nform-foot">
            <label class="nck"><input type="checkbox" id="nPubIn" checked/> 立即发布（不勾选＝仅保存草稿）</label>
            <div class="row-flex">
              <span class="fl-note" id="notifFormTip"></span>
              <button class="btn sm" id="btnNotifReset" type="button">清空</button>
              <button class="btn primary sm" id="btnNotifSave" type="button">发布通知</button>
            </div>
          </div>
        </div>

        <div class="tbl-wrap mt14">
          <table class="tbl">
            <thead><tr>
              <th class="l">标题</th><th class="l">级别</th><th class="l">状态</th>
              <th class="l">最近更新</th><th class="l">操作</th>
            </tr></thead>
            <tbody id="notifAdminBody"></tbody>
          </table>
        </div>
      </div>

      <div class="section">
        <div class="row-flex" style="justify-content:space-between">
          <h3 style="margin:0">订阅授权管理 <span class="chip warn" id="adminPending">—</span></h3>
          <button class="btn sm" id="btnRefreshAdmin" type="button">刷新</button>
        </div>
        <div class="hint mt8">
          「开通」默认给 365 天；也可点「自定义天数」。开通后对方刷新页面即可进入看板。<br/>
          <b>只有运营方名单里的账号能看到这一页</b>，普通客户看不到任何其他人的订阅信息。
        </div>
        <div class="tbl-wrap mt14">
          <table class="tbl">
            <thead><tr>
              <th class="l">申请邮箱</th><th class="l">用户 ID</th><th class="l">状态</th>
              <th class="l">套餐</th><th class="l">到期时间</th><th class="l">申请时间</th><th class="l">操作</th>
            </tr></thead>
            <tbody id="adminBody"></tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</div>

<div class="toast" id="toast"></div>
<div class="busy" id="busy"><div class="spin"></div><div class="txt" id="busyTxt">处理中…</div></div>

<!-- ==================== 成果导出（二级界面） ==================== -->
<div class="exmodal hidden" id="exModal">
  <div class="exmask" id="exMask"></div>
  <div class="excard" role="dialog" aria-modal="true" aria-labelledby="exTitle">
    <div class="exhead">
      <div>
        <div class="exttl" id="exTitle">导出成果</div>
        <div class="exsub">用当前看板的数据直接生成文件，不需要重新上传。导出在本地完成，数据不出你的浏览器。</div>
      </div>
      <button class="exclose" id="exClose" type="button" aria-label="关闭">✕</button>
    </div>

    <div class="exbody">
      <div class="exopts" id="exOpts">
        <button class="exopt on" id="exOptHtml" type="button" data-kind="html">
          <div class="exic">&lt;/&gt;</div>
          <div class="ext">
            <div class="exname">HTML 单文件</div>
            <div class="exdesc">一个自包含的 .html，样式、渲染脚本、数据全部内嵌。双击用任意浏览器打开，断网也能看，保留全部 8 个页面与交互。</div>
            <div class="exmeta" id="exHtmlMeta">适合存档／转发／离线查看</div>
          </div>
          <div class="excheck"></div>
        </button>

        <button class="exopt" id="exOptPng" type="button" data-kind="png">
          <div class="exic">▤</div>
          <div class="ext">
            <div class="exname">PNG 长图</div>
            <div class="exdesc">一张竖版长图，把核心指标、K 线、期限结构、持仓库存、期权、外盘、舆情、成本一屏铺开。</div>
            <div class="exmeta" id="exPngMeta">适合直接发微信／钉钉</div>
          </div>
          <div class="excheck"></div>
        </button>
      </div>

      <!-- PNG 选项 -->
      <div class="expane hidden" id="exPanePng">
        <div class="exrow">
          <span class="exlabel">清晰度</span>
          <div class="exseg" id="exScaleSeg">
            <button type="button" data-scale="1">标准 1×</button>
            <button type="button" data-scale="2" class="on">高清 2×</button>
            <button type="button" data-scale="3">超清 3×</button>
          </div>
          <span class="exlabel" id="exScaleNote"></span>
        </div>
        <div class="expreview" id="exPreview"><div class="exph">选择 PNG 长图后，这里会显示预览…</div></div>
      </div>

      <!-- HTML 选项 -->
      <div class="expane hidden" id="exPaneHtml">
        <div class="exnote" id="exHtmlNote"></div>
      </div>
    </div>

    <div class="exfoot">
      <div class="exhint" id="exHint"></div>
      <div class="exacts">
        <button class="btn" id="exCancel" type="button">取消</button>
        <button class="btn primary" id="exGo" type="button">导出</button>
      </div>
    </div>
  </div>
</div>

<!-- ==================== 通知详情 ==================== -->
<div class="nmodal hidden" id="nModal">
  <div class="nmask" id="nMask"></div>
  <div class="ncard" role="dialog" aria-modal="true" aria-labelledby="nTitle">
    <div class="nhead">
      <div>
        <div class="nttl" id="nTitle">—</div>
        <div class="nmeta" id="nMeta"></div>
      </div>
      <button class="exclose" id="nClose" type="button" aria-label="关闭">✕</button>
    </div>
    <div class="nbody" id="nBody"></div>
    <div class="nfoot">
      <button class="btn hidden" id="nMore" type="button">查看全部新通知</button>
      <button class="btn primary" id="nOk" type="button">知道了</button>
    </div>
  </div>
</div>

<script src="https://cdn.jsdelivr.net/npm/@tencent-ai/workbuddy-cloud-sdk@0.1.1-dev.111acaf.202609102031/lib/index.global.js"></script>
<script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js"></script>
<script id="wbRenderJs">
__RENDER__
</script>
<script>
__PARSER__
</script>
<script id="wbRiskParserJs">
__RISK_PARSER__
</script>
<script id="wbExporterJs">
__EXPORTER__
</script>
<script id="cuSeed" type="application/json">__SEED__</script>
<script>
window.SEED = JSON.parse(document.getElementById('cuSeed').textContent);
</script>
<script>
__APPJS__
</script>
</body>
</html>
"""

out = (TPL.replace("__THEME__", theme)
          .replace("__APPCSS__", appcss)
          .replace("__RENDER__", render)
          .replace("__PARSER__", parser)
          .replace("__RISK_PARSER__", risk_parser)
          .replace("__EXPORTER__", exporter)
          .replace("__SEED__", seed_raw)
          .replace("__APPJS__", appjs))

# 顶部「登录/注册」分段控件已由 app.js 接管（bind 里绑定 #segLogin/#segSignup，
# 状态经 window.CuAuth.setMode 切换）。这里以前注入过一段"去找表单内 data-go 链接点一下"
# 的脚本 —— 登录面板里根本没有 [data-go="signup"]，于是点顶部「注册」只亮按钮不换表单，
# 用户便在登录表单上填邮箱+密码注册，拿到后端的 user password not set。已删除。

dest = os.path.join(ROOT, "index.html")
with open(dest, "w", encoding="utf-8") as f:
    f.write(out)
dist_dest = os.path.join(ROOT, "dist", "index.html")
os.makedirs(os.path.dirname(dist_dest), exist_ok=True)
with open(dist_dest, "w", encoding="utf-8") as f:
    f.write(out)
print("saved:", dest, "and", dist_dest, len(out), "chars")
