// ============================================================
// LPL 数据源：腾讯官方接口
//   1) 赛程列表  apps.game.qq.com/lol/match/apis/searchBMatchInfo_bak.php (JSONP)
//   2) 战队列表  apps.game.qq.com/lol/match/apis/searchTeamList.php
//   3) 赛季列表  apps.game.qq.com/lol/match/apis/searchMatchGameInfo.php
//   4) 比赛详情  open.tjstats.com/match-auth-app/open/v1/compound/matchDetail
// ============================================================
"use strict";

const BASE_SCHEDULE = "https://apps.game.qq.com/lol/match/apis/searchBMatchInfo_bak.php";
const BASE_TEAMLIST = "https://apps.game.qq.com/lol/match/apis/searchTeamList.php";
const BASE_GAMELIST = "https://apps.game.qq.com/lol/match/apis/searchMatchGameInfo.php";
const TJSTATS_DETAIL = "https://open.tjstats.com/match-auth-app/open/v1/compound/matchDetail";

const LPL_BGAME = "5"; // bGameId: 职业联赛 = LPL
// open.tjstats 详情接口鉴权头。以 Base64 混淆存储，避免明文一眼可见；
// 注意：仅作"遮掩"，并非真正的加密；本项目开源，此值可被轻易逆推还原。
const TJSTATS_AUTH = { "Authorization": Buffer.from("NzkzNWJlNGM0MWQ4NzYwYTI4YzA1NTgxYTdiMWY1NzA=", "base64").toString("utf8") };

const UA = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36",
};

// ---- 工具 ----
function stripJsonp(text) {
  // "var retObj={...};<tail>" 形式：找到首 { 并做花括号配平
  const start = text.indexOf("{");
  if (start < 0) throw new Error("不是有效的 JSONP 响应");
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
  }
  throw new Error("JSONP 括号不匹配");
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  const text = await res.text();
  return stripJsonp(text);
}

function toISO(dateStr) {
  // "2026-08-23 19:00:00" (北京时间 +08:00) -> ISO
  if (!dateStr) return null;
  const d = dateStr.replace(" ", "T");
  const iso = /[+-]\d{2}:\d{2}$/.test(d) ? d : d + "+08:00";
  return new Date(iso).toISOString();
}

const BO_MAP = { "1": "Bo1", "3": "Bo3", "5": "Bo5" };

// ---- 赛季发现：返回当前/最新赛季 ----
async function listSeasons() {
  const j = await getJSON(`${BASE_GAMELIST}?r1=gamelist&p1=${LPL_BGAME}`);
  const list = (j.msg || []).filter((s) => s && s.GameId);
  // 按 GameId 数字降序，最新在前
  list.sort((a, b) => Number(b.GameId) - Number(a.GameId));
  return list.map((s) => ({ id: String(s.GameId), name: s.GameName }));
}

async function latestSeason() {
  const seasons = await listSeasons();
  if (!seasons.length) throw new Error("未找到 LPL 赛季");
  return seasons[0];
}

// ---- 战队表（id -> 队伍信息）+ 官方队徽 ----
let teamCache = null;

// 官方队徽源：lpl.qq.com 战队列表数据文件（含 TeamLogo 字段）
const TEAM_LIST_URL = "https://lpl.qq.com/web201612/data/LOL_MATCH2_TEAM_LIST.js";
let teamLogoMap = null;
let teamLogoMapTime = 0;
const TEAM_LIST_TTL = 24 * 3600 * 1000;

async function loadTeamLogos() {
  const now = Date.now();
  if (teamLogoMap && now - teamLogoMapTime < TEAM_LIST_TTL) return teamLogoMap;
  try {
    const res = await fetch(TEAM_LIST_URL, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const j = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    const map = new Map();
    for (const [id, entry] of Object.entries(j.msg || {})) {
      if (entry && entry.TeamLogo) map.set(String(id), "https:" + entry.TeamLogo);
    }
    teamLogoMap = map;
    teamLogoMapTime = now;
  } catch (e) {
    teamLogoMap = teamLogoMap || new Map();
    teamLogoMapTime = now; // 失败也冷却，避免反复请求
  }
  return teamLogoMap;
}

async function getTeams(seasonId) {
  if (teamCache) return teamCache;
  const j = await getJSON(`${BASE_TEAMLIST}?r1=theTeamlist&p1=${seasonId}`);
  const arr = Array.isArray(j.msg) ? j.msg : [];
  const map = new Map();
  for (const t of arr) {
    if (t && t.TeamId && !map.has(String(t.TeamId))) {
      map.set(String(t.TeamId), { id: String(t.TeamId), name: t.TeamName, logo: t.TeamLogo || "" });
    }
  }
  // 合并官方队徽
  const logos = await loadTeamLogos();
  for (const [id, team] of map) {
    const logo = logos.get(id);
    if (logo) team.logo = logo;
  }
  teamCache = map;
  return map;
}

function resetTeamCache() {
  teamCache = null;
}

// ---- 赛程 ----
// 拉取某一时间段（或整赛季）的赛程
async function fetchScheduleRaw({ seasonId, from, to, status = "", pagesize = 500, maxPages = 5 }) {
  const all = [];
  let page = 1;
  let total = Infinity;
  while (page <= maxPages && all.length < total) {
    const p = new URLSearchParams({
      p8: LPL_BGAME,
      p1: seasonId,
      p4: status,
      p2: "",
      p6: "2", // 时间正序
      p11: "", p12: "",
      page: String(page),
      pagesize: String(pagesize),
      r1: "retObj",
    });
    if (from) p.set("p9", `${from} 00:00:00`);
    if (to) p.set("p10", `${to} 23:59:59`);
    const j = await getJSON(`${BASE_SCHEDULE}?${p.toString()}`);
    const msg = j.msg || {};
    total = Number(msg.total) || 0;
    const result = msg.result || [];
    all.push(...result);
    if (result.length < pagesize) break;
    page++;
  }
  return all;
}

// 归一化为通用比赛对象
function normalizeMatch(m, teamMap) {
  const ta = teamMap.get(String(m.TeamA));
  const tb = teamMap.get(String(m.TeamB));
  const scoreA = parseInt(m.ScoreA, 10) || 0;
  const scoreB = parseInt(m.ScoreB, 10) || 0;
  const status = parseInt(m.MatchStatus, 10); // 1未开始 2进行中 3已结束
  let winner = null;
  if (status === 3 && scoreA !== scoreB) {
    winner = scoreA > scoreB ? "A" : "B";
  }
  return {
    id: `lpl-${m.bMatchId}`,
    sourceId: String(m.bMatchId),
    league: "lpl",
    leagueName: "LPL",
    stage: m.GameTypeName || m.GameName || "",
    week: m.GameProcName || "",
    round: null,
    bo: BO_MAP[String(m.GameMode)] || `Bo${m.GameMode}`,
    teamA: { id: String(m.TeamA), name: ta ? ta.name : m.bMatchName.split(" vs ")[0] || "TBD", logo: ta ? ta.logo : "" },
    teamB: { id: String(m.TeamB), name: tb ? tb.name : (m.bMatchName.split(" vs ")[1] || "TBD"), logo: tb ? tb.logo : "" },
    scoreA, scoreB, winner,
    status, // 1 未开始 / 2 进行中 / 3 已结束
    time: toISO(m.MatchDate),
    rawTime: m.MatchDate,
  };
}

// 获取整季赛程（默认最新赛季）
async function getSchedule({ seasonId, from, to } = {}) {
  const season = seasonId || (await latestSeason()).id;
  const teams = await getTeams(season);
  const raw = await fetchScheduleRaw({ seasonId: season, from, to });
  const list = raw.map((m) => normalizeMatch(m, teams));
  list.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  return { league: "lpl", seasonId: season, matches: list };
}

// ---- 比赛详情（已结束才有数据）----
async function getMatchDetail(sourceId) {
  const url = `${TJSTATS_DETAIL}?matchId=${encodeURIComponent(sourceId)}`;
  const res = await fetch(url, { headers: { ...UA, ...TJSTATS_AUTH } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for matchDetail`);
  const j = await res.json();
  if (!j.success || !j.data) {
    const err = new Error(j.errMsg || "暂无该场比赛的详情数据（未开赛或数据未生成）");
    err.code = "NO_DETAIL";
    throw err;
  }
  const detail = normalizeDetail(j.data);
  await enrichHeroNames(detail);
  await enrichHeroIcons(detail);
  return detail;
}

// ---- 英雄名映射（Ban 位显示用）----
const HERO_LIST_URL = "https://game.gtimg.cn/images/lol/act/img/js/heroList/hero_list.js";
let heroMap = null;
let heroMapTime = 0;
const HERO_TTL = 24 * 3600 * 1000;

async function getHeroMap() {
  const now = Date.now();
  if (heroMap && now - heroMapTime < HERO_TTL) return heroMap;
  try {
    const res = await fetch(HERO_LIST_URL, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const j = await res.json();
    const map = new Map();
    for (const h of j.hero || []) map.set(String(h.heroId), h.name || h.alias || "");
    heroMap = map;
    heroMapTime = now;
  } catch (e) {
    heroMap = heroMap || new Map();
    heroMapTime = now; // 失败也冷却一段时间
  }
  return heroMap;
}

async function enrichHeroNames(detail) {
  const map = await getHeroMap();
  for (const g of detail.games || []) {
    for (const side of [g.teamA, g.teamB]) {
      side.bans = (side.bans || []).map((b) => ({ ...b, name: map.get(String(b.heroId)) || `#${b.heroId}` }));
    }
  }
}

// ---- 英雄图标（Data Dragon，按 champion.js 的 heroId->英文名 映射拼 URL）----
const HERO_KEYS_URL = "https://lol.qq.com/biz/hero/champion.js";
const DD_VERSION_URL = "https://ddragon.leagueoflegends.com/api/versions.json";
const DD_FALLBACK_VERSION = "16.16.1";

let heroKeys = null;      // Map: heroId -> DDragon 文件名
let heroKeysTime = 0;
let ddVersion = null;
let ddVersionTime = 0;
const KEYS_TTL = 24 * 3600 * 1000;
const DD_TTL = 24 * 3600 * 1000;

async function getHeroKeys() {
  const now = Date.now();
  if (heroKeys && now - heroKeysTime < KEYS_TTL) return heroKeys;
  const map = new Map();
  // 主源：lol.qq.com champion.js（heroId -> 英文名，快，但只覆盖旧版本）
  try {
    const res = await fetch(HERO_KEYS_URL, { headers: UA });
    if (res.ok) {
      const text = await res.text();
      const j = JSON.parse(text.slice(text.indexOf("{", text.indexOf("champion")), text.lastIndexOf("}") + 1));
      for (const [id, name] of Object.entries(j.keys || {})) map.set(String(id), String(name));
    }
  } catch (e) { /* ignore */ }
  // 补充源：Data Dragon champion.json（全量、最新，含新英雄）
  const ver = await getDdragonVersion();
  try {
    const res = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ver}/data/zh_CN/champion.json`, { headers: UA });
    if (res.ok) {
      const j = await res.json();
      for (const c of Object.values(j.data || {})) map.set(String(c.key), String(c.id));
    }
  } catch (e) { /* ignore */ }
  heroKeys = map;
  heroKeysTime = now;
  return heroKeys;
}

async function getDdragonVersion() {
  const now = Date.now();
  if (ddVersion && now - ddVersionTime < DD_TTL) return ddVersion;
  try {
    const res = await fetch(DD_VERSION_URL, { headers: UA });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const versions = await res.json();
    ddVersion = (versions && versions[0]) || DD_FALLBACK_VERSION;
    ddVersionTime = now;
  } catch (e) {
    ddVersion = ddVersion || DD_FALLBACK_VERSION;
    ddVersionTime = now;
  }
  return ddVersion;
}

async function enrichHeroIcons(detail) {
  const keys = await getHeroKeys();
  const ver = await getDdragonVersion();
  for (const g of detail.games || []) {
    for (const side of [g.teamA, g.teamB]) {
      for (const p of side.players || []) {
        const ddName = keys.get(String(p.heroId));
        p.heroIcon = ddName ? `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${encodeURIComponent(ddName)}.png` : "";
      }
      for (const b of side.bans || []) {
        const ddName = keys.get(String(b.heroId));
        b.heroIcon = ddName ? `https://ddragon.leagueoflegends.com/cdn/${ver}/img/champion/${encodeURIComponent(ddName)}.png` : "";
      }
    }
  }
}

function normalizeDetail(d) {
  const games = (d.matchInfos || []).map((g, i) => {
    const infos = g.teamInfos || [];
    const byTeam = new Map(infos.map((t) => [String(t.teamId), t]));
    const make = (teamId, fallbackSide) => {
      const t = byTeam.get(String(teamId)) || {};
      const side = String(g.blueTeam) === String(teamId) ? "blue" : "red";
      const players = (t.playerInfos || []).map((p) => {
        const b = p.battleDetail || {};
        const dmg = p.damageDetail || {};
        const v = p.visionDetail || {};
        const o = p.otherDetail || {};
        const kills = b.kills ?? 0, deaths = b.death ?? 0, assists = b.assist ?? 0;
        return {
          name: p.playerName || "",
          role: p.playerLocation || "",
          heroId: p.heroId || 0,
          heroName: p.heroName || "",
          heroNameEn: p.heroNameEn || "",
          cs: p.minionKilled ?? null,
          items: (p.items || []).filter((it) => it && it.itemId).map((it) => ({ id: it.itemId, name: it.itemName })),
          kda: { kills, deaths, assists, ratio: b.kda ?? null, attend: b.attendWarRate ?? null, mvp: !!o.mvp, highestKDA: !!b.highestKDA },
          damage: {
            hero: dmg.heroDamage ?? null,
            physical: dmg.heroPhysicalDamage ?? null,
            magical: dmg.heroMagicalDamage ?? null,
            true: dmg.heroTrueDamage ?? null,
            rate: dmg.damageRate ?? null,
            perMin: dmg.damagePerMinute ?? null,
          },
          vision: {
            wards: v.wardPlaced ?? null,
            wardKills: v.wardKilled ?? null,
            score: v.visionScore ?? null,
            controlWards: v.controlWardPurchased ?? null,
          },
          golds: o.golds ?? null,
          goldPercent: o.goldPercent ?? null,
          level: o.level ?? null,
          creeps: o.creepsKilled ?? p.minionKilled ?? null,
          firstBlood: !!o.firstBlood,
          firstTurret: !!o.firstTurret,
        };
      });
      // 团队 KDA 汇总
      const tot = players.reduce((acc, p) => ({
        kills: acc.kills + p.kda.kills,
        deaths: acc.deaths + p.kda.deaths,
        assists: acc.assists + p.kda.assists,
      }), { kills: 0, deaths: 0, assists: 0 });
      const kdaRatio = tot.deaths ? (tot.kills + tot.assists) / tot.deaths : (tot.kills + tot.assists);
      const totDamage = players.reduce((acc, p) => acc + (p.damage.hero || 0), 0);
      const totGold = players.reduce((acc, p) => acc + (p.golds || 0), 0);
      return {
        teamId: String(teamId),
        side: byTeam.get(String(teamId)) ? side : fallbackSide,
        stats: {
          kills: t.kills ?? tot.kills,
          deaths: tot.deaths,
          assists: tot.assists,
          kda: kdaRatio,
          towers: t.turretAmount ?? 0,
          dragons: t.dragonAmount ?? 0,
          barons: t.baronAmount ?? 0,
          golds: t.golds ?? totGold,
          damage: totDamage,
        },
        bans: (t.banHeroList || []).map((id) => ({ heroId: id })),
        players,
      };
    };
    const winnerId = g.matchWin ? String(g.matchWin) : null;
    // 按 match 级 teamA/teamB 映射（蓝/红方≠赛事双方）
    const teamA = make(String(d.teamAId), "blue");
    const teamB = make(String(d.teamBId), "red");
    const winSide = winnerId === teamA.teamId ? "left" : winnerId === teamB.teamId ? "right" : null;
    const durSec = g.matchEndTime && g.matchStartTime
      ? Math.max(0, (new Date(g.matchEndTime) - new Date(g.matchStartTime)) / 1000)
      : null;
    return {
      game: i + 1,
      winnerSide: winSide,
      winnerTeamId: winnerId,
      startTime: g.matchStartTime ? new Date(g.matchStartTime).toISOString() : null,
      durationSec: durSec,
      teamA, teamB,
    };
  });
  return {
    id: `lpl-${d.matchId}`,
    sourceId: String(d.matchId),
    league: "lpl",
    matchName: d.matchName || "",
    bo: BO_MAP[String(d.gameMode)] || "Bo3",
    time: d.matchTime ? new Date(d.matchTime).toISOString() : null,
    teamA: { id: String(d.teamAId), name: d.teamAName },
    teamB: { id: String(d.teamBId), name: d.teamBName },
    scoreA: d.teamAScore ?? 0,
    scoreB: d.teamBScore ?? 0,
    winner: d.teamAScore > d.teamBScore ? "A" : d.teamBScore > d.teamAScore ? "B" : null,
    games,
  };
}

// 按队伍 id 查队徽 URL
async function getLogo(teamId) {
  const logos = await loadTeamLogos();
  return logos.get(String(teamId)) || "";
}

// ---------------- 赛季结构（对阵图用）----------------
const SPLIT1_GROUPS = [
  { name: "登峰组", desc: "前4直进淘汰赛；第5/6名进骑士之路第一轮", teams: ["AL", "BLG", "WBG", "北京JDG", "TES", "IG"] },
  { name: "坚韧组", desc: "第1/2名进骑士之路第一轮；第3/4名进第二轮", teams: ["深圳NIP", "西安WE", "EDG", "TT"] },
  { name: "涅槃组", desc: "第1/2名进骑士之路第二轮；第3/4名本赛段淘汰", teams: ["苏州LNG", "OMG", "LGD", "UP"] },
];

// 由组内赛对战关系推导分组（连通分量）
function deriveGroups(matches, teams) {
  const adj = new Map();
  for (const m of matches) {
    for (const t of [m.teamA.name, m.teamB.name]) if (!adj.has(t)) adj.set(t, new Set());
    adj.get(m.teamA.name).add(m.teamB.name);
    adj.get(m.teamB.name).add(m.teamA.name);
  }
  const seen = new Set();
  const comps = [];
  for (const t of adj.keys()) {
    if (seen.has(t)) continue;
    const comp = [];
    const q = [t];
    seen.add(t);
    while (q.length) {
      const x = q.pop();
      comp.push(x);
      for (const n of adj.get(x)) if (!seen.has(n)) { seen.add(n); q.push(n); }
    }
    comps.push(comp);
  }
  comps.sort((a, b) => b.length - a.length);
  return comps.map((c, i) => ({
    name: `第${["一", "二", "三", "四"][i] || i + 1}组`,
    desc: "组内双循环",
    teams: c,
  }));
}

function findTeam(teamList, name) {
  return teamList.find((t) => t.name === name) || { id: "", name, logo: "" };
}

async function getSeasonStructure() {
  const { matches } = await getSchedule();
  const seasonId = (await latestSeason()).id;
  const teams = [...(await getTeams(seasonId)).values()];

  const splitMatches = (name) => matches.filter((m) => m.stage.startsWith(name));

  // 把一列比赛重建为树状对阵：按时间排序，每场的轮次 = 双方上一场比赛轮次+1，
  // 并记录父节点（双方各自上一场的比赛 id），前端据此画树状连线
  function buildBracketRounds(list, { finalIsFinal = true } = {}) {
    const sorted = [...list].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const teamLast = new Map(); // 队名 -> 最近一场 node
    const nodes = [];
    for (const m of sorted) {
      const pA = teamLast.get(m.teamA.name) || null;
      const pB = teamLast.get(m.teamB.name) || null;
      const round = 1 + Math.max(pA ? pA.round : 0, pB ? pB.round : 0);
      const node = { match: m, round, parents: [pA ? pA.match.id : null, pB ? pB.match.id : null] };
      nodes.push(node);
      teamLast.set(m.teamA.name, node);
      teamLast.set(m.teamB.name, node);
    }
    const maxRound = Math.max(0, ...nodes.map((n) => n.round));
    const CN = ["", "一", "二", "三", "四", "五", "六", "七", "八"];
    const rounds = [];
    for (let r = 1; r <= maxRound; r++) {
      rounds.push({
        name: r === maxRound && finalIsFinal ? "决赛" : `第${CN[r] || r}轮`,
        matches: nodes.filter((n) => n.round === r).map((n) => ({ ...n.match, parents: n.parents })),
      });
    }
    return rounds;
  }
  const groupTeams = (names) => names.map((n) => findTeam(teams, n));
  const splitStandings = (ms) => {
    const { computeStandings } = require("./standings");
    return computeStandings(ms);
  };
  // 每个分组单独统计积分榜（只统计该组内部的比赛）
  const groupStandings = (groupMatches, groupNameLists) => groupNameLists.map((g) => ({
    name: g.name,
    rows: splitStandings(groupMatches.filter((m) => g.teams.includes(m.teamA.name) && g.teams.includes(m.teamB.name))),
  }));
  const championOf = (playoffMatches) => {
    const sorted = [...playoffMatches].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
    const last = sorted[sorted.length - 1];
    if (!last || last.status !== 3) return null;
    return last.winner === "A" ? last.teamA.name : last.winner === "B" ? last.teamB.name : null;
  };

  const s1 = splitMatches("第一赛段");
  const s2 = splitMatches("第二赛段");
  const s3 = splitMatches("第三赛段");

  const split1GroupMatches = s1.filter((m) => m.stage === "第一赛段组内赛");
  const split2GroupMatches = s2.filter((m) => m.stage === "第二赛段组内赛");
  const split3GroupMatches = s3.filter((m) => m.stage === "第三赛段组内赛");

  const playoff1 = s1.filter((m) => m.stage === "第一赛段淘汰赛");
  const playoff2 = s2.filter((m) => m.stage === "第二赛段淘汰赛");

  const s2Groups = deriveGroups(split2GroupMatches, teams);
  const s3Teams = [...new Set(split3GroupMatches.flatMap((m) => [m.teamA.name, m.teamB.name]))];
  const s3Groups = [{ name: "组内赛 · 12队单循环", desc: "骑士之路与淘汰赛将于组内赛后进行", teams: s3Teams }];

  // 各赛段按组别的积分榜（只统计组内对战）
  const s1Standings = groupStandings(split1GroupMatches, SPLIT1_GROUPS);
  const s2Standings = groupStandings(split2GroupMatches, s2Groups);
  const s3Standings = groupStandings(split3GroupMatches, s3Groups);

  return {
    seasonId,
    splits: [
      {
        key: "第一赛段",
        name: "第一赛段",
        status: "finished",
        champion: championOf(playoff1),
        groups: SPLIT1_GROUPS.map((g) => ({ ...g, teams: groupTeams(g.teams) })),
        knightRoad: buildBracketRounds(s1.filter((m) => m.stage === "第一赛段骑士之路"), { finalIsFinal: false }),
        playoffs: buildBracketRounds(playoff1),
        standings: s1Standings,
      },
      {
        key: "第二赛段",
        name: "第二赛段",
        status: "finished",
        champion: championOf(playoff2),
        groups: s2Groups.map((g) => ({ ...g, teams: groupTeams(g.teams) })),
        knightRoad: buildBracketRounds(s2.filter((m) => m.stage === "第二赛段骑士之路"), { finalIsFinal: false }),
        playoffs: buildBracketRounds(playoff2),
        standings: s2Standings,
      },
      {
        key: "第三赛段",
        name: "第三赛段",
        status: "current",
        champion: null,
        groups: s3Groups.map((g) => ({ ...g, teams: groupTeams(g.teams) })),
        knightRoad: buildBracketRounds(s3.filter((m) => m.stage.includes("骑士之路"))),
        playoffs: buildBracketRounds(s3.filter((m) => m.stage.includes("淘汰赛"))),
        standings: s3Standings,
      },
    ],
  };
}

// 按赛段返回分组的积分榜
async function getStandingsGroups(stage) {
  const { matches } = await getSchedule();
  const { computeStandings } = require("./standings");
  if (!stage || stage === "全部") {
    return [{ name: "整个赛季", rows: computeStandings(matches) }];
  }
  const structure = await getSeasonStructure();
  const split = structure.splits.find((s) => s.key === stage);
  if (!split) return [];
  return split.standings;
}

module.exports = { listSeasons, latestSeason, getTeams, getLogo, getSchedule, getMatchDetail, getSeasonStructure, getStandingsGroups, resetTeamCache };
