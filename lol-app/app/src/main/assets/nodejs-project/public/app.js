/* ============================================================
   LPL 赛事中心 —— 前端逻辑（原生 JS，无依赖）
   ============================================================ */
"use strict";

const state = {
  view: "schedule",     // schedule | bracket | standings | match(二级页面)
  date: new Date(),     // 当前选中日期（本地时间）
  filter: "all",        // all | 1(未开始) | 2(进行中) | 3(已结束)
  teamFilter: "all",    // all | 战队显示名（按战队筛选，跨全部日期）
  lpl: { matches: [], loaded: false, error: null, seasonId: null },
  season: null,
  bracketSplit: "第三赛段", // 对阵图当前显示的赛段
  standings: null,
  standingsStage: "第三赛段", // 全部 | 第一赛段 | 第二赛段 | 第三赛段
  matchId: null,        // 二级页面当前比赛 id
  matchDetail: null,    // 二级页面详情数据
  prevView: "schedule", // 返回时的上一视图
  refreshTimer: null,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

// ---------------- 工具 ----------------
function fmtDay(d) {
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, "0"), day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function parseDay(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function sameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}
function fmtTime(iso) {
  if (!iso) return "--:--";
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function fmtDateCN(d) {
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}
function fmtDateTimeCN(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
const DOW_CN = ["日", "一", "二", "三", "四", "五", "六"];
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

const STATUS_TEXT = { 1: "未开始", 2: "进行中", 3: "已结束" };
const ROLE_CN = {
  TOP: "上单", top: "上单",
  JUN: "打野", JUNGLE: "打野", jungle: "打野",
  MID: "中单", mid: "中单",
  ADC: "ADC", BOT: "下路", bot: "下路", adc: "ADC",
  SUP: "辅助", SUPPORT: "辅助", support: "辅助",
};
function roleCn(r) {
  return ROLE_CN[r] || r || "";
}

// 队伍标识（徽标/队徽）
function teamLogoHtml(team, cls) {
  const c = team.color || "#5a5f6a";
  const short = escapeHtml(team.short || "?");
  if (team.logo) {
    return `<span class="logo ${cls || ""}"><img src="${escapeHtml(team.logo)}" alt="${short}" loading="lazy"
      data-short="${short}" data-color="${c}" onerror="window.__teamLogoFallback(this)"></span>`;
  }
  return `<span class="logo ${cls || ""}"><span class="logo-initial" style="background:${c}">${short}</span></span>`;
}

// 队徽加载失败 -> 回退为文字徽标
window.__teamLogoFallback = function (img) {
  try {
    const short = img.getAttribute("data-short") || "?";
    const color = img.getAttribute("data-color") || "#5a5f6a";
    img.outerHTML = `<span class="logo-initial" style="background:${color}">${short}</span>`;
  } catch (e) { /* ignore */ }
};

// 装备图标加载失败 -> 回退为首字文字
window.__itemIconFallback = function (img) {
  try {
    const name = img.getAttribute("data-name") || "?";
    img.outerHTML = `<span class="item-icon item-icon-text">${escapeHtml(name.slice(0, 1))}</span>`;
  } catch (e) { /* ignore */ }
};

// 英雄图标加载失败 -> 回退为英雄名文字
window.__heroIconFallback = function (img) {
  try {
    const name = img.getAttribute("data-name") || "";
    img.outerHTML = `<span class="hero-name-text">${escapeHtml(name)}</span>`;
  } catch (e) { /* ignore */ }
};

const ITEM_ICON = (id) => `https://game.gtimg.cn/images/lol/act/img/item/${id}.png`;

// ---------------- 数据加载 ----------------
async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) {
    let msg = `HTTP ${r.status}`;
    try { const j = await r.json(); if (j.error) msg = j.error; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }
  return r.json();
}

async function loadLpl({ force } = {}) {
  const q = force ? "?force=1" : "";
  const j = await fetchJSON(`/api/lpl/schedule${q}`);
  state.lpl.matches = j.matches || [];
  state.lpl.seasonId = j.seasonId;
  state.lpl.loaded = true;
  state.lpl.error = null;
}

async function loadStandings(stage) {
  const st = stage || state.standingsStage;
  const j = await fetchJSON(`/api/standings?league=lpl&stage=${encodeURIComponent(st)}`);
  state.standings = j.groups || [];
  state.standingsStage = st;
}

async function loadSeason() {
  const j = await fetchJSON(`/api/lpl/season`);
  state.season = j;
}

async function loadAll({ force } = {}) {
  setStatus("loading", "加载中…");
  try {
    await loadLpl({ force });
  } catch (e) {
    console.error(e);
    state.lpl.error = e.message;
  }
  render();
  updateStatus();
  autoJumpToNearestMatchDay();
  warmBackground(force);
  scheduleAutoRefresh();
}

// 今天没有比赛时，自动跳到最近的有比赛日期（仅首次加载）
let didAutoJump = false;
function autoJumpToNearestMatchDay() {
  if (didAutoJump) return;
  const matches = currentMatches();
  if (!matches.length) return;
  const todayKey = fmtDay(new Date());
  if (matches.some((m) => m.time && fmtDay(new Date(m.time)) === todayKey)) {
    didAutoJump = true;
    return;
  }
  const days = [...new Set(matches.filter((m) => m.time).map((m) => fmtDay(new Date(m.time))))].sort();
  if (!days.length) return;
  // 找离今天最近的
  const today = new Date(todayKey).getTime();
  let best = days[0];
  for (const d of days) {
    if (Math.abs(new Date(d).getTime() - today) < Math.abs(new Date(best).getTime() - today)) best = d;
  }
  state.date = parseDay(best);
  didAutoJump = true;
  render();
  toast(`今天暂无比赛，已显示最近比赛日（${best}）`);
}

// 后台补全：对阵图结构 + 积分榜
function warmBackground(force) {
  loadSeason().then(render).catch(() => {});
  loadStandings().then(render).catch(() => {});
}

function scheduleAutoRefresh() {
  if (state.refreshTimer) clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    if (document.hidden) return;
    // 有直播/临近比赛时更频繁
    const now = Date.now();
    const hasLive = currentMatches().some((m) => m.status === 2);
    const hasSoon = currentMatches().some((m) => m.status === 1 && m.time && new Date(m.time).getTime() - now < 2 * 3600 * 1000);
    if (hasLive || hasSoon) autoRefreshLight();
  }, 60 * 1000);
}

function autoRefreshLight() {
  // 静默刷新赛程（不打扰 UI）
  loadLpl().then(render).catch(() => {});
}

// ---------------- 渲染 ----------------
function render() {
  const data = state.lpl;
  const main = $("#main");

  if (!data.loaded && !data.error) {
    main.innerHTML = `<div class="loading"><div class="spinner"></div><p>正在加载赛程数据…</p></div>`;
    return;
  }

  let html = "";
  if (data.error) {
    html += `<div class="error-box">⚠️ 数据加载异常：${escapeHtml(data.error)}
      <button class="btn retry" onclick="window.App.refresh(true)">重试</button></div>`;
  }

  if (state.view === "standings") {
    html += renderStandings();
  } else if (state.view === "bracket") {
    html += renderBracket();
  } else if (state.view === "match") {
    html += renderMatchPage();
  } else {
    html += renderSchedule();
  }
  main.innerHTML = html;
  renderDayStrip();
  updateStatus();
}

function renderSchedule() {
  const matches = currentMatches();
  const teamSel = state.teamFilter && state.teamFilter !== "all" ? state.teamFilter : "all";
  const teamFilterOn = teamSel !== "all";
  const teams = teamOptions();

  // 筛选数据集：选中战队时跨全部日期；否则按选中日期
  let dayMatches;   // 用于计数/展示的比赛
  let filtered;     // 实际展示（叠加状态筛选）
  if (teamFilterOn) {
    const base = matches.filter((m) => (m.teamA.display === teamSel || m.teamB.display === teamSel));
    dayMatches = base;
    filtered = base.filter((m) => state.filter === "all" || m.status === Number(state.filter));
  } else {
    const sel = fmtDay(state.date);
    dayMatches = matches.filter((m) => m.time && fmtDay(new Date(m.time)) === sel);
    filtered = dayMatches.filter((m) => state.filter === "all" || m.status === Number(state.filter));
  }

  const chips = [
    { k: "all", t: "全部" },
    { k: "1", t: "未开始" },
    { k: "2", t: "进行中" },
    { k: "3", t: "已结束" },
  ].map((c) => {
    const cnt = c.k === "all" ? dayMatches.length : dayMatches.filter((m) => m.status === Number(c.k)).length;
    return `<button class="chip ${state.filter === c.k ? "active" : ""}" data-filter="${c.k}">
      ${c.t}<span class="cnt">${cnt}</span></button>`;
  }).join("");

  const teamSelect = `
    <select id="teamSelect" class="team-select" title="按战队筛选">
      <option value="all" ${teamSel === "all" ? "selected" : ""}>全部战队</option>
      ${teams.map((t) => `<option value="${escapeHtml(t.display || t.name)}" ${teamSel === (t.display || t.name) ? "selected" : ""}>${escapeHtml(t.display || t.name)}</option>`).join("")}
    </select>`;

  // 选中战队时隐藏日期导航（不再按日期浏览）
  const dateNav = teamFilterOn ? "" : `
    <div class="date-nav">
      <button class="btn" data-nav="-1">‹</button>
      <input type="date" class="date-input" id="dateInput" value="${fmtDay(state.date)}">
      <button class="btn" data-nav="1">›</button>
      <button class="btn" id="btnToday">今天</button>
    </div>`;

  const listHtml = filtered.length
    ? `<div class="match-list">${filtered.map(matchCardHtml).join("")}</div>`
    : `<div class="empty"><div class="big">📅</div>${teamFilterOn ? "该战队暂无比赛" : (dayMatches.length ? "当前筛选条件下没有比赛" : "这一天没有比赛")}</div>`;

  const metaText = state.lpl.seasonId
    ? (teamFilterOn
        ? `LPL ${escapeHtml(state.lpl.seasonId)} · 「${escapeHtml(teamSel)}」全部 ${dayMatches.length} 场比赛`
        : `LPL ${escapeHtml(state.lpl.seasonId)} · ${fmtDateCN(state.date)} 当天 ${dayMatches.length} 场`)
    : "";

  return `
    <div class="view-tabs">
      <button class="view-tab ${state.view === "schedule" ? "active" : ""}" data-view="schedule">赛程</button>
      <button class="view-tab ${state.view === "bracket" ? "active" : ""}" data-view="bracket">对阵图</button>
      <button class="view-tab ${state.view === "standings" ? "active" : ""}" data-view="standings">积分榜</button>
    </div>
    <div class="toolbar">
      ${dateNav}
      <div class="toolbar-right">
        ${teamSelect}
        <div class="filters">${chips}</div>
      </div>
    </div>
    ${teamFilterOn ? "" : `<div class="day-strip" id="dayStrip"></div>`}
    ${metaText ? `<div class="match-meta" style="margin-bottom:12px;font-size:11.5px;">${metaText}</div>` : ""}
    ${listHtml}
  `;
}

function renderDayStrip() {
  const strip = $("#dayStrip");
  if (!strip) return;
  const matches = currentMatches();
  const cells = [];
  for (let i = -3; i <= 3; i++) {
    const d = addDays(state.date, i);
    const key = fmtDay(d);
    const cnt = matches.filter((m) => m.time && fmtDay(new Date(m.time)) === key).length;
    cells.push(`
      <div class="day-cell ${sameDay(d, state.date) ? "active" : ""} ${sameDay(d, new Date()) ? "today" : ""}" data-day="${key}">
        <div class="dow">${sameDay(d, new Date()) ? "今天" : "周" + DOW_CN[d.getDay()]}</div>
        <div class="dnum">${d.getDate()}</div>
        <div class="dcnt ${cnt ? "has" : ""}">${cnt ? cnt + "场" : "无"}</div>
      </div>`);
  }
  strip.innerHTML = cells.join("");
}

function matchCardHtml(m) {
  const statusCls = `s${m.status}`;
  const winner = m.winner; // "A" | "B" | null
  const scoreStrong = (side) => (m.status === 3 && winner ? (winner === side ? "strong" : "dim") : "");
  const liveCls = m.status === 2 ? " live" : "";
  const time = new Date(m.time);
  return `
    <div class="match-card${liveCls}" data-match="${escapeHtml(m.id)}" data-source-id="${escapeHtml(m.sourceId || "")}">
      <div class="match-time">
        <div class="t">${fmtTime(m.time)}</div>
        <div class="d">${time.getMonth() + 1}/${time.getDate()}</div>
        <span class="status-badge ${statusCls}">${STATUS_TEXT[m.status] || ""}</span>
      </div>
      <div class="match-main">
        <div class="match-meta">
          <span class="stage">${escapeHtml(m.stage || "")}</span>
          ${m.week ? `<span class="week">${escapeHtml(m.week)}</span>` : ""}
          <span class="bo">${escapeHtml(m.bo || "Bo3")}</span>
        </div>
        <div class="teams">
          <div class="team a ${m.status === 3 && winner ? (winner === "A" ? "win" : "lose") : ""}">
            ${teamLogoHtml(m.teamA)}
            <span class="team-name">${escapeHtml(m.teamA.display)}</span>
          </div>
          <div class="vs">VS</div>
          <div class="score-box">
            <span class="score ${scoreStrong("A")}">${m.status === 3 || m.status === 2 ? m.scoreA : "-"}</span>
            <span class="score-hyphen">:</span>
            <span class="score ${scoreStrong("B")}">${m.status === 3 || m.status === 2 ? m.scoreB : "-"}</span>
          </div>
          <div class="vs">VS</div>
          <div class="team b ${m.status === 3 && winner ? (winner === "B" ? "win" : "lose") : ""}">
            <span class="team-name">${escapeHtml(m.teamB.display)}</span>
            ${teamLogoHtml(m.teamB)}
          </div>
        </div>
      </div>
    </div>`;
}

// ---------------- 对阵图 ----------------
function renderBracket() {
  const season = state.season;
  const head = `<div class="view-tabs">
      <button class="view-tab ${state.view === "schedule" ? "active" : ""}" data-view="schedule">赛程</button>
      <button class="view-tab ${state.view === "bracket" ? "active" : ""}" data-view="bracket">对阵图</button>
      <button class="view-tab ${state.view === "standings" ? "active" : ""}" data-view="standings">积分榜</button>
    </div>`;
  if (!season) {
    loadSeason().then(render).catch((e) => {
      const main = $("#main");
      main.innerHTML = `${head}<div class="error-box">对阵图加载失败：${escapeHtml(e.message)}</div>`;
    });
    return `${head}<div class="loading"><div class="spinner"></div><p>正在加载赛段结构…</p></div>`;
  }
  const split = season.splits.find((s) => s.key === state.bracketSplit) || season.splits[season.splits.length - 1];
  return `${head}
    <div class="season-strip">
      ${season.splits.map((s) => `
        <button class="season-chip ${s.key === split.key ? "active" : ""} ${s.status === "current" ? "current" : ""}" data-split="${escapeHtml(s.key)}">
          <span class="sc-name">${escapeHtml(s.name)}</span>
          <span class="sc-status">${s.status === "current" ? "● 进行中" : "已结束"}</span>
          ${s.champion ? `<span class="sc-champ">🏆 ${escapeHtml(s.champion)}</span>` : ""}
        </button>`).join("")}
    </div>
    ${renderSplitCard(split)}`;
}

function renderSplitCard(split) {
  const isCurrent = split.status === "current";
  const allTeams = (split.groups || []).flatMap((g) => g.teams);
  const champTeam = split.champion
    ? allTeams.find((t) => t.name === split.champion) || { name: split.champion, display: split.champion }
    : null;
  return `
    <div class="split-card ${isCurrent ? "current" : ""}">
      <div class="split-head">
        <h3>${escapeHtml(split.name)} ${isCurrent ? '<span class="badge-current">进行中</span>' : '<span class="badge-done">已结束</span>'}</h3>
        ${split.champion ? `<span class="split-champ">${teamLogoHtml(champTeam, "logo-sm")} 冠军：<b>${escapeHtml(split.champion)}</b></span>` : ""}
      </div>
      <div class="groups-row">
        ${split.groups.map((g) => `
          <div class="group-box">
            <div class="group-name">${escapeHtml(g.name)}</div>
            ${g.desc ? `<div class="group-desc">${escapeHtml(g.desc)}</div>` : ""}
            <div class="group-teams">${g.teams.map((t) => `
              <span class="team-chip">${teamLogoHtml(t, "logo-xs")}<span>${escapeHtml(t.display)}</span></span>`).join("")}</div>
          </div>`).join("")}
      </div>
      ${split.knightRoad.length ? `
        <div class="bracket-title">骑士之路</div>
        ${bracketTreeHtml(split.knightRoad)}` : ""}
      ${split.playoffs.length ? `
        <div class="bracket-title">淘汰赛</div>
        ${bracketTreeHtml(split.playoffs)}` : ""}
      ${!split.knightRoad.length && !split.playoffs.length && isCurrent ? `
        <div class="upcoming-hint">🔜 骑士之路与淘汰赛将在组内赛结束后进行</div>` : ""}
      ${isCurrent && split.standings && split.standings.length ? `
        <div class="bracket-title">当前赛段积分榜（${escapeHtml(split.name)}）</div>
        ${miniStandingsTable(split.standings)}` : ""}
    </div>`;
}

// 树状对阵：轮次列 + SVG 连线
function bracketTreeHtml(rounds) {
  if (!rounds.length) return "";
  const COL_W = 208, BOX_W = 184, BOX_H = 56, GAP = 16;
  const byId = new Map();
  const nodes = [];
  rounds.forEach((r, ri) => r.matches.forEach((m) => {
    const node = { id: m.id, round: ri, match: m, y: 0 };
    byId.set(m.id, node);
    nodes.push(node);
  }));
  // 第一轮均匀分布
  const r0 = nodes.filter((n) => n.round === 0);
  r0.forEach((n, i) => { n.y = i * (BOX_H + GAP); });
  // 后续轮 = 父节点中点
  for (let ri = 1; ri < rounds.length; ri++) {
    rounds[ri].matches.forEach((m) => {
      const node = byId.get(m.id);
      const ys = (m.parents || []).filter(Boolean).map((pid) => byId.get(pid)).filter(Boolean).map((p) => p.y);
      node.y = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : 0;
    });
  }
  const height = Math.max(0, ...nodes.map((n) => n.y)) + BOX_H + 8;
  const width = rounds.length * COL_W;
  // 连线（方块 left = round*COL_W+4, top = y+30，线需对齐方块边缘中点）
  const HEADER_H = 30;
  const lines = [];
  for (const n of nodes) {
    if (n.round === 0) continue;
    const x1 = n.round * COL_W + 4; // 子节点 box 左侧边缘
    const y1c = n.y + HEADER_H + BOX_H / 2; // 子节点 box 垂直中点
    for (const pid of (n.match.parents || [])) {
      const p = byId.get(pid);
      if (!p) continue;
      const px = p.round * COL_W + BOX_W + 4; // 父 box 右侧边缘
      const py = p.y + HEADER_H + BOX_H / 2; // 父 box 垂直中点
      const mx = (px + x1) / 2;
      lines.push(`<polyline points="${px},${py} ${mx},${py} ${mx},${y1c} ${x1},${y1c}" fill="none" stroke="rgba(154,164,184,0.38)" stroke-width="1.5"/>`);
    }
  }
  return `
    <div class="bracket-tree-wrap">
      <div class="bracket-tree" style="width:${width}px;height:${height + 30}px;">
        <svg class="tree-svg" width="${width}" height="${height + 30}">${lines.join("")}</svg>
        ${rounds.map((r, ri) => `<div class="tree-round" style="left:${ri * COL_W}px;width:${COL_W}px">${escapeHtml(r.name)}</div>`).join("")}
        ${nodes.map((n) => {
          const m = n.match;
          const winA = m.status === 3 && m.winner === "A";
          const winB = m.status === 3 && m.winner === "B";
          const showScore = m.status === 3 || m.status === 2;
          return `
          <div class="tree-match" style="left:${n.round * COL_W + 4}px;top:${n.y + 30}px;width:${BOX_W}px;"
            data-match="${escapeHtml(m.id)}" onclick="window.App.openMatchById('${escapeHtml(m.id)}')">
            <div class="bm-row ${winA ? "bm-win" : ""}">${teamLogoHtml(m.teamA, "logo-xs")}<span class="bm-name">${escapeHtml(m.teamA.display)}</span><span class="bm-score ${winA ? "on" : ""}">${showScore ? m.scoreA : ""}</span></div>
            <div class="bm-row ${winB ? "bm-win" : ""}">${teamLogoHtml(m.teamB, "logo-xs")}<span class="bm-name">${escapeHtml(m.teamB.display)}</span><span class="bm-score ${winB ? "on" : ""}">${showScore ? m.scoreB : ""}</span></div>
          </div>`;
        }).join("")}
      </div>
    </div>`;
}

// 积分榜表格（含积分列；mini 为简版）
function standingsTableHtml(rows, mini) {
  return `
    <table class="standings">
      <thead><tr>
        <th>排名</th><th>战队</th><th>场次</th><th>积分</th><th>胜</th><th>负</th><th>胜率</th><th>净胜场</th>${mini ? "" : "<th>近5场</th><th>状态</th>"}
      </tr></thead>
      <tbody>${rows.map((r) => `
        <tr>
          <td class="rank">${r.rank}</td>
          <td><div class="team-cell">${teamLogoHtml({ name: r.display || r.name, short: r.short, logo: r.logo, color: r.color }, mini ? "logo-xs" : "")}<b>${escapeHtml(r.display || r.name)}</b></div></td>
          <td class="wl-cell">${r.played}</td>
          <td class="wl-cell pts">${r.points ?? "-"}</td>
          <td class="wl-cell" style="color:var(--green)">${r.wins}</td>
          <td class="wl-cell" style="color:var(--red)">${r.losses}</td>
          <td class="wl-cell">${mini ? `${(r.winrate * 100).toFixed(0)}%` : `<span class="winrate-bar"><i style="width:${(r.winrate * 100).toFixed(0)}%"></i></span>${(r.winrate * 100).toFixed(1)}%`}</td>
          <td class="wl-cell">${r.net > 0 ? "+" : ""}${r.net}</td>
          ${mini ? "" : `<td><span class="last5">${r.last5.map((x) => `<span class="${x}">${x}</span>`).join("")}</span></td>
          <td class="wl-cell">${r.streak > 0 ? `<span class="streak-win">${r.streak}连胜</span>` : r.streak < 0 ? `<span class="streak-loss">${-r.streak}连败</span>` : "—"}</td>`}
        </tr>`).join("")}</tbody>
    </table>`;
}

// 按组别渲染多张积分榜
function groupStandingsHtml(groups, mini) {
  return groups.map((g) => `
    <div class="standings-group">
      ${g.name && g.name !== "整个赛季" ? `<div class="sg-name">${escapeHtml(g.name)}</div>` : ""}
      ${standingsTableHtml(g.rows, mini)}
    </div>`).join("");
}

function miniStandingsTable(groups) {
  return `<div class="standings-wrap mini">${groupStandingsHtml(groups, true)}</div>`;
}

// ---------------- 积分榜 ----------------
function renderStandings() {
  const groups = state.standings;
  const head = `<div class="view-tabs">
      <button class="view-tab ${state.view === "schedule" ? "active" : ""}" data-view="schedule">赛程</button>
      <button class="view-tab ${state.view === "bracket" ? "active" : ""}" data-view="bracket">对阵图</button>
      <button class="view-tab ${state.view === "standings" ? "active" : ""}" data-view="standings">积分榜</button>
    </div>
    <div class="toolbar" style="margin-bottom:14px;">
      <div class="filters" id="stageFilters">
        ${["第三赛段", "第二赛段", "第一赛段", "全部"].map((s) =>
          `<button class="chip ${state.standingsStage === s ? "active" : ""}" data-stage="${s}">${s === "全部" ? "整个赛季" : s}</button>`).join("")}
      </div>
    </div>`;
  const stageNote = state.standingsStage === "全部"
    ? "整个 2026 赛季积分榜"
    : `${state.standingsStage}积分榜`;
  if (!groups) {
    loadStandings().then(render).catch((e) => {
      const main = $("#main");
      main.innerHTML = `${head}<div class="error-box">积分榜加载失败：${escapeHtml(e.message)}</div>`;
    });
    return `${head}<div class="loading"><div class="spinner"></div><p>正在计算积分榜…</p></div>`;
  }
  const hasGroups = groups.some((g) => g.rows && g.rows.length);
  if (!groups.length || !hasGroups) {
    return `${head}<div class="standings-wrap"><div class="standings-note">${stageNote} · 积分 = 系列赛胜场 × 3</div>
      <div class="empty"><div class="big">🏆</div>暂无已结束的比赛</div></div>`;
  }
  return `${head}
    <div class="standings-wrap">
      <div class="standings-note">${stageNote} · 积分 = 系列赛胜场 × 3 · 按组别分别排名（只统计组内对战）</div>
      ${groupStandingsHtml(groups, false)}
    </div>`;
}

// ---------------- 二级页面：比赛详情 ----------------
function openMatchPage(m) {
  if (state.view !== "match") state.prevView = state.view;
  state.matchId = m.sourceId || m.id;
  state.matchDetail = null;
  state.view = "match";
  try { location.hash = `#/match/${state.matchId}`; } catch (e) { /* ignore */ }
  render();
}

async function loadMatchDetail() {
  if (!state.matchId) return;
  const j = await fetchJSON(`/api/lpl/match/${state.matchId}`);
  state.matchDetail = j.detail;
}

// 按 sourceId 或 id 在当前赛程里查找比赛（详情页用；未开赛的比赛也会有完整 entry）
function findMatchById(id) {
  const s = String(id);
  return currentMatches().find((x) => String(x.sourceId) === s || String(x.id) === s) || null;
}

// 未来比赛占位页：不请求详情接口（避免错误码），直接展示赛程信息 + 友好提示
function matchUpcomingHtml(m) {
  const timeTxt = m.time ? fmtDateTimeCN(m.time) : "";
  return `
    <div class="detail-head">
      <div class="detail-meta">
        ${m.stage ? `<span>${escapeHtml(m.stage)}</span>` : ""}
        ${m.week ? `<span>${escapeHtml(m.week)}</span>` : ""}
        <span>${escapeHtml(m.bo || "Bo3")}</span>
      </div>
      <div class="detail-score">
        <div class="detail-team">
          ${teamLogoHtml(m.teamA)}
          <div class="nm">${escapeHtml(m.teamA.display)}</div>
        </div>
        <div class="detail-vs-score">
          <span class="detail-vs">VS</span>
        </div>
        <div class="detail-team">
          ${teamLogoHtml(m.teamB)}
          <div class="nm">${escapeHtml(m.teamB.display)}</div>
        </div>
      </div>
      ${timeTxt ? `<div class="detail-bo">🕐 ${escapeHtml(timeTxt)}</div>` : ""}
    </div>
    <div class="empty upcoming-note">
      <div class="big">🔜</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:6px;">比赛尚未开始</div>
      <div>开赛后约 30 分钟即可查看完整对局数据<br>（选手 KDA / 伤害 / 装备 / 英雄选择等）</div>
      <div style="margin-top:14px;"><button class="btn" onclick="window.App.refresh(true)">↻ 刷新看看</button></div>
    </div>`;
}

// 详情加载失败（非未来比赛/数据暂未生成）占位页：不暴露错误码给用户
function matchUnavailableHtml(m) {
  const name = m ? `${m.teamA.display} vs ${m.teamB.display}` : "本场比赛";
  return `
    <div class="empty" style="padding:40px 18px;">
      <div class="big">🤖</div>
      <div style="font-size:16px;font-weight:700;margin-bottom:8px;">${escapeHtml(name)}</div>
      <div style="color:var(--text-dim);margin-bottom:16px;">对局数据暂不可用，请稍后刷新重试</div>
      <button class="btn" onclick="window.App.refresh(true)">↻ 刷新重试</button>
    </div>`;
}

function renderMatchPage() {
  const head = `
    <div class="match-page-toolbar">
      <button class="btn" onclick="window.App.goBack()">← 返回</button>
      <span class="mp-title">比赛详情</span>
    </div>`;
  if (!state.matchId) {
    state.view = state.prevView;
    return head + `<div class="empty">没有比赛信息</div>`;
  }
  // 未来比赛：直接渲染“未开始”占位页，不请求详情接口（避免用户看到错误码）
  const m = findMatchById(state.matchId);
  if (m && Number(m.status) === 1) {
    return head + matchUpcomingHtml(m);
  }
  if (!state.matchDetail) {
    loadMatchDetail().then(render).catch(() => {
      const main = $("#main");
      // 不把 e.message/错误码展示给用户，渲染友好占位页
      main.innerHTML = head + matchUnavailableHtml(m);
    });
    return head + `<div class="loading"><div class="spinner"></div><p>正在加载比赛详情…</p></div>`;
  }
  const d = state.matchDetail;
  if (!d.games || !d.games.length) {
    return head + detailHeaderHtml(d) + `<div class="empty"><div class="big">🎮</div>暂无该场比赛的详细数据</div>`;
  }
  return head + detailHeaderHtml(d) + d.games.map((g) => matchGameHtml(d, g)).join("") + `<div class="detail-foot">时间均为本地时区 · 数据来源：腾讯官方赛事接口</div>`;
}

function fmtNum(n) {
  if (n == null) return "-";
  if (n >= 10000) return (n / 1000).toFixed(1) + "k";
  return String(Math.round(n));
}

function matchGameHtml(d, g) {
  const winnerName = g.winnerSide === "left" ? d.teamA.display : g.winnerSide === "right" ? d.teamB.display : (g.winnerTeamId ? (String(g.winnerTeamId) === String(d.teamA.id) ? d.teamA.display : d.teamB.display) : null);
  const durText = g.durationSec ? fmtDur(g.durationSec) : g.duration || "";
  const winA = g.winnerSide === "left" || (g.winnerTeamId && String(g.winnerTeamId) === String(d.teamA.id));
  const winB = g.winnerSide === "right" || (g.winnerTeamId && String(g.winnerTeamId) === String(d.teamB.id));
  return `
    <div class="game-block mp-block">
      <div class="game-head">
        <span>第 ${g.game} 局</span>
        <span class="gmeta">${durText ? `⏱ ${durText}` : ""}${winnerName ? `<span class="gwinner">胜者：${escapeHtml(winnerName)}</span>` : ""}</span>
      </div>
      ${matchTeamPanel(g.teamA, d.teamA, winA)}
      ${matchTeamPanel(g.teamB, d.teamB, winB)}
    </div>`;
}

function matchTeamPanel(g, team, isWin) {
  const stats = g.stats || {};
  const players = g.players || [];
  const maxDmg = Math.max(1, ...players.map((p) => p.damage?.hero || 0));
  const bansHtml = g.bans && g.bans.length ? `
    <div class="bans-row"><span class="bans-label">BAN</span>${g.bans.map((b) => `
      <span class="ban-tip">${b.heroIcon ? `
        <span class="ban-icon-wrap"><img class="hero-icon ban-icon" src="${escapeHtml(b.heroIcon)}" alt="${escapeHtml(b.name || "")}" loading="lazy"
          data-name="${escapeHtml(b.name || "")}" onerror="window.__heroIconFallback(this)">
        <span class="item-name-tip">${escapeHtml(b.name || "")}</span></span>` : `<span class="ban-chip">${escapeHtml(b.name || b.heroId)}</span>`}
      </span>`).join("")}</div>` : "";
  return `
    <div class="mp-team ${isWin ? "win" : ""}">
      <div class="mp-team-head">
        ${teamLogoHtml(team, "logo-sm")}
        <span class="mp-team-name">${escapeHtml(team.display)}${isWin ? " ✔" : ""}</span>
        <span class="mp-team-kda">KDA <b>${stats.kills}/${stats.deaths}/${stats.assists}</b> <em>${(stats.kda ?? 0).toFixed(2)}</em></span>
      </div>
      <div class="mp-team-stats">
        <span>伤害 <b>${fmtNum(stats.damage)}</b></span>
        <span>金币 <b>${(stats.golds / 1000).toFixed(1)}k</b></span>
        <span>推塔 <b>${stats.towers}</b></span>
        <span>小龙 <b>${stats.dragons}</b></span>
        <span>大龙 <b>${stats.barons}</b></span>
      </div>
      ${bansHtml}
      <div class="mp-table-wrap">
      <table class="mp-table">
        <thead><tr>
          <th>英雄</th><th>选手</th><th>KDA</th><th>参团率</th><th>伤害</th><th>伤害占比</th><th>分均</th><th>经济</th><th>补刀</th><th>视野分</th><th>等级</th><th>装备</th>
        </tr></thead>
        <tbody>${players.map((p) => {
          const dmg = p.damage?.hero;
          const itemSlots = [];
          const items = p.items || [];
          for (let i = 0; i < 6; i++) {
            const it = items[i];
            if (it) {
              itemSlots.push(`<span class="item-tip">
                <img class="item-icon item-icon-sm" src="${ITEM_ICON(it.id)}" alt="${escapeHtml(it.name || "")}" loading="lazy"
                  data-name="${escapeHtml(it.name || "未知装备")}" onerror="window.__itemIconFallback(this)">
                <span class="item-name-tip">${escapeHtml(it.name || "未知装备")}</span>
              </span>`);
            } else {
              itemSlots.push(`<span class="item-tip"><span class="item-icon item-icon-sm item-empty"></span></span>`);
            }
          }
          return `
          <tr>
            <td class="mp-hero">${p.heroIcon ? `<img class="hero-icon mp-hero-icon" src="${escapeHtml(p.heroIcon)}" alt="${escapeHtml(p.heroName || "")}" title="${escapeHtml(p.heroName || "")}" loading="lazy" data-name="${escapeHtml(p.heroName || "")}" onerror="window.__heroIconFallback(this)">` : ""}</td>
            <td class="mp-player">${escapeHtml(p.name)}</td>
            <td class="mp-kda">${p.kda ? `${p.kda.kills}/${p.kda.deaths}/${p.kda.assists}` : "-"}</td>
            <td class="mp-num">${p.kda?.attend != null ? (p.kda.attend * 100).toFixed(1) + "%" : "-"}</td>
            <td class="mp-dmg">
              <div class="dmg-bar-bg"><div class="dmg-bar" style="width:${dmg ? (dmg / maxDmg * 100).toFixed(1) : 0}%"></div></div>
              <span>${fmtNum(dmg)}</span>
            </td>
            <td class="mp-num">${p.damage?.rate != null ? (p.damage.rate * 100).toFixed(1) + "%" : "-"}</td>
            <td class="mp-num">${p.damage?.perMin != null ? p.damage.perMin.toFixed(0) : "-"}</td>
            <td class="mp-num">${p.golds != null ? (p.golds / 1000).toFixed(1) + "k" : "-"}${p.goldPercent != null ? `<em>${(p.goldPercent * 100).toFixed(0)}%</em>` : ""}</td>
            <td class="mp-num">${p.cs ?? "-"}</td>
            <td class="mp-num">${p.vision?.score != null ? p.vision.score.toFixed(0) : "-"}</td>
            <td class="mp-num">${p.level ?? "-"}</td>
            <td class="mp-items">${itemSlots.join("")}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>
      </div>
    </div>`;
}

function detailHeaderHtml(d) {
  const winner = d.winner;
  return `
    <div class="detail-head">
      <div class="detail-meta">
        <span>${escapeHtml(d.stage || "")}</span>
        ${d.week ? `<span>${escapeHtml(d.week)}</span>` : ""}
        <span>${escapeHtml(d.bo || "Bo3")}</span>
        <span>🕐 ${fmtDateTimeCN(d.time)}</span>
      </div>
      <div class="detail-score">
        <div class="detail-team ${winner === "A" ? "winner" : ""}">
          ${teamLogoHtml(d.teamA)}
          <div class="nm">${escapeHtml(d.teamA.display || d.teamA.name)}</div>
        </div>
        <div class="detail-vs-score">
          <span class="detail-score-num ${winner === "A" ? "winner" : winner ? "loser" : ""}">${d.scoreA}</span>
          <span class="detail-vs">:</span>
          <span class="detail-score-num ${winner === "B" ? "winner" : winner ? "loser" : ""}">${d.scoreB}</span>
        </div>
        <div class="detail-team ${winner === "B" ? "winner" : ""}">
          ${teamLogoHtml(d.teamB)}
          <div class="nm">${escapeHtml(d.teamB.display || d.teamB.name)}</div>
        </div>
      </div>
      <div class="detail-bo">${winner ? `获胜：${escapeHtml((winner === "A" ? d.teamA : d.teamB).display)}` : "比赛未结束"}</div>
    </div>`;
}

function fmtDur(sec) {
  if (sec == null) return "";
  const m = Math.floor(sec / 60), s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

// ---------------- 状态栏 / Toast ----------------
function setStatus(cls, text) {
  const el = $("#dataStatus");
  el.className = `data-status ${cls}`;
  el.textContent = text;
}
function updateStatus() {
  const el = $("#dataStatus");
  const data = state.lpl;
  if (data.error) {
    el.className = "data-status err";
    el.textContent = "部分数据源异常，显示可用数据";
  } else {
    el.className = "data-status ok";
    el.textContent = `数据已更新 · LPL ${state.lpl.matches.length} 场比赛`;
  }
}

let toastTimer = null;
function toast(msg) {
  const el = $("#toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 2600);
}

// ---------------- 事件 ----------------
function currentMatches() {
  return state.lpl.matches;
}

// 收集全部赛程中出现过的战队（去重、按显示名排序），供战队筛选下拉使用。
// 仅保留"真实战队"：LPL 队名都以末尾英文缩写结尾（BLG / 北京JDG / 深圳NIP…），
// 过滤"骑士之路1 / 败者组决赛"等未被战队表解析出的占位名。
function teamOptions() {
  const seen = new Map();
  for (const m of currentMatches()) {
    for (const t of [m.teamA, m.teamB]) {
      const key = t.display || t.name || "";
      if (!key || !/[A-Za-z]{2,}$/.test(key)) continue;
      if (!seen.has(key)) seen.set(key, t);
    }
  }
  return [...seen.values()].sort((a, b) => (a.display || a.name).localeCompare(b.display || b.name, "zh-CN"));
}

function bindEvents() {
  // 全局事件委托
  const mainEl = $("#main");
  mainEl && mainEl.addEventListener("click", async (e) => {
    const chip = e.target.closest(".chip[data-filter]");
    if (chip) {
      state.filter = chip.dataset.filter;
      render();
      return;
    }
    const stageChip = e.target.closest("[data-stage]");
    if (stageChip) {
      state.standingsStage = stageChip.dataset.stage;
      state.standings = null;
      loadStandings().then(render).catch(() => {});
      render();
      return;
    }
    const splitChip = e.target.closest("[data-split]");
    if (splitChip) {
      state.bracketSplit = splitChip.dataset.split;
      render();
      return;
    }
    const viewTab = e.target.closest(".view-tab");
    if (viewTab) {
      state.view = viewTab.dataset.view;
      render();
      return;
    }
    const navBtn = e.target.closest("[data-nav]");
    if (navBtn) {
      state.date = addDays(state.date, Number(navBtn.dataset.nav));
      didAutoJump = true;
      render();
      return;
    }
    const todayBtn = e.target.closest("#btnToday");
    if (todayBtn) {
      state.date = new Date();
      didAutoJump = true;
      render();
      return;
    }
    const dayCell = e.target.closest(".day-cell");
    if (dayCell) {
      state.date = parseDay(dayCell.dataset.day);
      didAutoJump = true;
      render();
      return;
    }
    const card = e.target.closest(".match-card");
    if (card) {
      const id = card.dataset.match;
      const m = currentMatches().find((x) => x.id === id);
      if (m) openMatchPage(m);
    }
  });

  // 日期选择 / 战队筛选（输入框在数据加载后才渲染，用委托）
  mainEl && mainEl.addEventListener("change", (e) => {
    if (e.target && e.target.id === "dateInput" && e.target.value) {
      state.date = parseDay(e.target.value);
      didAutoJump = true;
      render();
    }
    if (e.target && e.target.id === "teamSelect") {
      state.teamFilter = e.target.value || "all";
      render();
    }
  });

  const refreshBtn = $("#btnRefresh");
  refreshBtn && refreshBtn.addEventListener("click", () => refreshData(true));

  // 浏览器前进/后退（二级页面 hash 路由）
  window.addEventListener("hashchange", () => {
    const m = parseHashMatch();
    if (m) openMatchPage(m);
    else if (state.view === "match") {
      state.view = state.prevView;
      state.matchDetail = null;
      render();
    }
  });
}

function parseHashMatch() {
  const m = (location.hash || "").match(/^#\/match\/(\d+)/);
  if (!m) return null;
  return currentMatches().find((x) => x.sourceId === m[1]) || { sourceId: m[1] };
}

async function refreshData(force) {
  toast(force ? "正在强制刷新…" : "正在刷新…");
  await loadAll({ force: !!force });
  render();
  toast(force ? "已刷新" : "已更新");
}

// 时钟
setInterval(() => {
  const el = $("#clock");
  if (el) el.textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
}, 1000);

// ---------------- 启动 ----------------
async function init() {
  bindEvents();
  $("#clock").textContent = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  await loadAll({});
  // 刷新/直达：hash 指向具体比赛时直接打开二级页面
  const m = parseHashMatch();
  if (m && m.sourceId) {
    state.prevView = "schedule";
    state.matchId = m.sourceId;
    state.matchDetail = null;
    state.view = "match";
  }
  render();
}

window.App = {
  refresh: refreshData,
  gotoDay: (dayStr) => { state.date = parseDay(dayStr); didAutoJump = true; render(); },
  gotoView: (view) => { state.view = view; render(); },
  goBack: () => {
    state.view = state.prevView || "schedule";
    state.matchDetail = null;
    state.matchId = null;
    try { history.pushState(null, "", "#"); } catch (e) { location.hash = ""; }
    render();
  },
  openMatchById: (id) => {
    const m = currentMatches().find((x) => x.id === id);
    if (m) openMatchPage(m);
  },
};
document.addEventListener("DOMContentLoaded", init);
