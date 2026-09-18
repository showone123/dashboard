# -*- coding: utf-8 -*-
"""组装单文件应用 index.html：CDN SDK + theme.css + app.css + render.js + seed + app.js"""
import json, os, shutil

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
<title>FluxDesk · 数据工作站</title>
<meta name="description" content="FluxDesk 数据工作站：上传业务数据，集中查看专业看板、历史记录与风险日志。"/>
<link rel="icon" type="image/png" href="/assets/fluxdesk-companion.png"/>
<script>document.documentElement.dataset.theme='light';</script>
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
  <canvas class="particle-canvas" id="authParticles" aria-hidden="true"></canvas>
  <div class="auth-brand">
    <img class="brand-companion" src="/assets/fluxdesk-companion.png" alt=""/>
    <div class="brand-wordmark">Flux<span>Desk</span></div>
  </div>
  <button class="theme-toggle auth-theme-toggle" type="button" data-theme-toggle aria-label="切换明暗主题">
    <span class="theme-sun">☼</span><span class="theme-moon">◐</span><span data-theme-label>浅色</span>
  </button>
  <div class="auth-story">
    <div class="auth-eyebrow">INTELLIGENT DATA WORKSPACE</div>
    <h1>让复杂数据，<br/><span>自然汇聚成答案。</span></h1>
    <p>一个专注于行情洞察、账户关系和风险日志的工作站。把分散的数据收拢到同一视野，让每一次判断都有依据。</p>
    <div class="auth-facts"><span><i></i>数据服务运行正常</span><span>21 张数据表已连接</span><span>访问权限校验</span></div>
  </div>
  <div class="auth-zone">
   <div class="auth-card">
    <div class="auth-card-title">欢迎回来</div>
    <div class="auth-card-lead">登录 FluxDesk，继续你的工作。</div>
    <div class="auth-head compact-brand">
      <img class="brand-companion auth-companion" src="/assets/fluxdesk-companion.png" alt=""/>
      <div class="brand-wordmark">Flux<span>Desk</span></div>
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
    <div class="auth-security">◇ 账户与数据访问均受权限控制。</div>
   </div>
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
  <canvas class="particle-canvas app-particle-canvas" id="appParticles" aria-hidden="true"></canvas>
  <aside class="workspace-sidebar">
    <div class="workspace-brand">
      <img class="brand-companion" src="/assets/fluxdesk-companion.png" alt=""/>
      <div class="brand-wordmark">Flux<span>Desk</span></div>
    </div>
    <div class="workspace-switch"><div><b>风险与行情工作站</b><small id="dataSource">示例数据（铜）</small></div><span>⌄</span></div>
    <div class="workspace-nav-label">工作台</div>
    <nav class="workspace-nav">
      <button class="app-tab active" data-tab="dash" type="button"><span class="nav-glyph">▦</span>总览</button>
      <button class="app-tab" data-tab="market" type="button"><span class="nav-glyph">⌁</span>市场看板</button>
      <button class="app-tab" data-tab="upload" type="button"><span class="nav-glyph">⇧</span>数据中心</button>
    </nav>
    <div class="workspace-nav-label">风险管理</div>
    <nav class="workspace-nav">
      <button class="app-tab" data-tab="risk" type="button"><span class="nav-glyph">◇</span>实控人风险日志<span class="nav-badge" id="sideRiskBadge">—</span></button>
      <button class="app-tab" data-tab="history" type="button"><span class="nav-glyph">▤</span>历史记录</button>
    </nav>
    <div class="workspace-nav-label">系统</div>
    <nav class="workspace-nav">
      <button class="app-tab hidden" data-tab="admin" id="tabAdmin" type="button"><span class="nav-glyph">⚙</span>运营台<span class="dotbadge hidden" id="adminBadge">0</span></button>
    </nav>
    <div class="workspace-side-foot">
      <div class="workspace-avatar">FD</div><div><b id="sideUser">FluxDesk 用户</b><span id="sidePlan">已开通</span></div>
    </div>
  </aside>
  <main class="workspace-main">
    <header class="workspace-topbar">
      <div class="workspace-crumb"><span>工作台</span><i>/</i><b id="workspaceCrumb">总览</b></div>
      <button class="workspace-search" id="btnQuickSearch" type="button"><span>⌕</span><span>搜索账户、MAC 或功能…</span><kbd>Ctrl K</kbd></button>
      <div class="me">
      <button class="theme-toggle app-theme-toggle" type="button" data-theme-toggle aria-label="切换明暗主题">
        <span class="theme-sun">☼</span><span class="theme-moon">◐</span><span data-theme-label>浅色</span>
      </button>
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

  <!-- 工作站总览 -->
  <section class="panel active" id="panelDash">
    <div class="overview-content">
      <div class="overview-head"><div><h1>工作站总览</h1><div class="overview-status"><i></i><span>数据已同步</span><span>·</span><span id="overviewUpdated">等待数据</span></div></div><div class="overview-actions"><button class="btn" id="btnOverviewMarket" type="button">查看市场看板</button><button class="btn primary" id="btnOverviewExport" type="button">导出报告</button></div></div>
      <section class="overview-metrics">
        <article><div class="metric-label"><span>最新收盘</span><span id="ovContract">—</span></div><div class="metric-main"><b id="ovClose">—</b><em id="ovChange">—</em></div><svg class="metric-spark" id="ovSparkPrice" viewBox="0 0 180 30" preserveAspectRatio="none"></svg></article>
        <article><div class="metric-label"><span>持仓量</span><span>手</span></div><div class="metric-main"><b id="ovOpenInterest">—</b><em id="ovOiChange">—</em></div><svg class="metric-spark" id="ovSparkOi" viewBox="0 0 180 30" preserveAspectRatio="none"></svg></article>
        <article><div class="metric-label"><span>异常 MAC</span><span>当前版本</span></div><div class="metric-main"><b id="ovRiskMac">—</b><em class="risk" id="ovRiskHigh">未载入</em></div><div class="metric-foot" id="ovRiskSource">风险日志</div></article>
        <article><div class="metric-label"><span>涉及资金账户</span><span>去重</span></div><div class="metric-main"><b id="ovRiskAccounts">—</b><em id="ovRiskSegments">—</em></div><div class="metric-foot">按资金账号前四位归类</div></article>
      </section>
      <section class="overview-grid">
        <article class="overview-card overview-market-card"><div class="overview-card-head"><div><b>价格与持仓联动</b><small id="ovMarketNote">行情数据</small></div><button class="mini-action" id="btnOverviewMarket2" type="button">打开完整看板</button></div><div class="overview-chart"><svg id="ovPriceChart" viewBox="0 0 760 250" preserveAspectRatio="none"></svg></div></article>
        <article class="overview-card"><div class="overview-card-head"><div><b>风险聚合</b><small>按关联账户数排序</small></div><button class="mini-action" id="btnOverviewRisk" type="button">查看全部</button></div><div class="overview-risk-summary"><div><small>异常设备</small><b id="ovRiskDevices">—</b></div><div><small>高风险组</small><b class="hot" id="ovRiskGroups">—</b></div></div><div class="overview-risk-list" id="ovRiskList"><div class="overview-empty">载入风险日志后显示聚合结果</div></div></article>
      </section>
      <section class="overview-lower">
        <article class="overview-card"><div class="overview-card-head"><div><b>重点账户关系</b><small>当前风险日志 · 仅显示摘要</small></div><button class="mini-action" id="btnOverviewFilter" type="button">筛选号段</button></div><div class="overview-table-wrap"><table class="overview-table"><thead><tr><th>资金账号</th><th>客户</th><th>所属号段</th><th>关联设备</th><th>状态</th></tr></thead><tbody id="ovAccountBody"><tr><td colspan="5">载入风险日志后显示账户关系</td></tr></tbody></table></div></article>
        <article class="overview-card"><div class="overview-card-head"><div><b>数据动态</b><small>当前工作区状态</small></div></div><div class="overview-feed" id="ovFeed"></div></article>
      </section>
    </div>
  </section>

  <!-- 完整市场看板 -->
  <section class="panel" id="panelMarket">
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
</main>
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
assets_src = os.path.join(ROOT, "assets")
assets_dest = os.path.join(ROOT, "dist", "assets")
os.makedirs(assets_dest, exist_ok=True)
for asset_name in ("fluxdesk-companion.png",):
    shutil.copy2(os.path.join(assets_src, asset_name), os.path.join(assets_dest, asset_name))
print("saved:", dest, "and", dist_dest, len(out), "chars")
