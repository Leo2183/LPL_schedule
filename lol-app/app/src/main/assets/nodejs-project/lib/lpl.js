// ============================================================
// 赛事数据源：腾讯官方接口（多赛事支持）
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

// 赛事配置：bGameId 为腾讯接口的职业赛事编号（2026-09 实测）
const LEAGUES = {
  lpl: { bGame: "5", label: "LPL" },
  worlds: { bGame: "1", label: "全球总决赛" },
  msi: { bGame: "8", label: "季中冠军赛" },
  demacia: { bGame: "4", label: "德玛西亚杯" },
};
const DEFAULT_LEAGUE = "lpl";
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

// GameMode 值：1=Bo1、3=Bo3、5=Bo5；腾讯对季后赛(Bo5)返回 4，据实映射为 Bo5
const BO_MAP = { "1": "Bo1", "3": "Bo3", "4": "Bo5", "5": "Bo5" };

// Bo 标签：赛程接口给数字（1/3/4/5），详情接口给字符串（“BO5”/“BO3”），两种都兼容
function boLabel(mode) {
  const s = String(mode ?? "").trim().toUpperCase();
  const m = s.match(/^BO(\d+)$/);
  if (m) return "Bo" + m[1];
  if (s === "" || mode == null) return "Bo3";
  return BO_MAP[s] || `Bo${mode}`;
}

// 非正式比赛的 stage（如“SOLO选边”选边局，Bo1 单局不计战绩），不进入赛程/积分/对阵
const EXCLUDED_STAGE_RES = [/^SOLO选边/];
function isExcludedStage(stage) {
  return EXCLUDED_STAGE_RES.some((re) => re.test(String(stage || "")));
}

// ---- 赛季发现：返回全部赛季（最新在前），按赛事缓存 1h ----
const seasonsMemo = new Map(); // league -> { list, time }
const SEASONS_TTL = 3600 * 1000;

async function listSeasons(league = DEFAULT_LEAGUE) {
  const conf = LEAGUES[league];
  if (!conf) throw new Error(`不支持的赛事: ${league}`);
  const now = Date.now();
  const hit = seasonsMemo.get(league);
  if (hit && now - hit.time < SEASONS_TTL) return hit.list;
  const j = await getJSON(`${BASE_GAMELIST}?r1=gamelist&p1=${conf.bGame}`);
  const list = (j.msg || []).filter((s) => s && s.GameId);
  // 按 GameId 数字降序，最新在前
  list.sort((a, b) => Number(b.GameId) - Number(a.GameId));
  const seasons = list.map((s) => ({ id: String(s.GameId), name: s.GameName }));
  seasonsMemo.set(league, { list: seasons, time: now });
  return seasons;
}

async function latestSeason(league = DEFAULT_LEAGUE) {
  const seasons = await listSeasons(league);
  if (!seasons.length) throw new Error("未找到该赛事的赛季");
  return seasons[0];
}

// ---- 战队表（league+seasonId -> 队伍信息）+ 官方队徽 ----
const teamCacheBySeason = new Map(); // `${league}:${seasonId}` -> Map(teamId -> team)

// 官方队徽源：lpl.qq.com 战队列表数据文件（含 TeamLogo 字段）。
// 该文件同时覆盖国际战队（T1/GEN/G2…，世界赛/MSI 队徽同样来自这里）
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

async function getTeams(league, seasonId) {
  const cacheKey = `${league}:${seasonId}`;
  const hit = teamCacheBySeason.get(cacheKey);
  if (hit) return hit;
  const conf = LEAGUES[league];
  if (!conf) throw new Error(`不支持的赛事: ${league}`);
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
  teamCacheBySeason.set(cacheKey, map);
  return map;
}

function resetTeamCache() {
  teamCacheBySeason.clear();
}

// ---- 赛程 ----
// 拉取某一时间段（或整赛季）的赛程
async function fetchScheduleRaw({ league = DEFAULT_LEAGUE, seasonId, from, to, status = "", pagesize = 500, maxPages = 5 }) {
  const conf = LEAGUES[league];
  if (!conf) throw new Error(`不支持的赛事: ${league}`);
  const all = [];
  let page = 1;
  let total = Infinity;
  while (page <= maxPages && all.length < total) {
    const p = new URLSearchParams({
      p8: conf.bGame,
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
function normalizeMatch(m, teamMap, league = DEFAULT_LEAGUE) {
  const conf = LEAGUES[league] || LEAGUES[DEFAULT_LEAGUE];
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
    id: `${league}-${m.bMatchId}`,
    sourceId: String(m.bMatchId),
    league,
    leagueName: conf.label,
    stage: m.GameTypeName || m.GameName || "",
    week: m.GameProcName || "",
    round: null,
    bo: boLabel(m.GameMode),
    teamA: { id: String(m.TeamA), name: ta ? ta.name : m.bMatchName.split(" vs ")[0] || "TBD", logo: ta ? ta.logo : "" },
    teamB: { id: String(m.TeamB), name: tb ? tb.name : (m.bMatchName.split(" vs ")[1] || "TBD"), logo: tb ? tb.logo : "" },
    scoreA, scoreB, winner,
    status, // 1 未开始 / 2 进行中 / 3 已结束
    time: toISO(m.MatchDate),
    rawTime: m.MatchDate,
  };
}

// 获取整季赛程（默认最新赛季；过滤 SOLO 选边等非正式比赛）
async function getSchedule({ league = DEFAULT_LEAGUE, seasonId, from, to } = {}) {
  const season = seasonId || (await latestSeason(league)).id;
  const teams = await getTeams(league, season);
  const raw = (await fetchScheduleRaw({ league, seasonId: season, from, to }))
    .filter((m) => !isExcludedStage(m.GameTypeName || m.GameName));
  const list = raw.map((m) => normalizeMatch(m, teams, league));
  list.sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  return { league, seasonId: season, matches: list };
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
    bo: boLabel(d.gameMode),
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

// ---------------- 赛季结构（对阵图用；赛段/阶段全部由 stage 命名自动推导） ----------------
const { computeStandings } = require("./standings");

// 已知分组的展示名与说明（登峰组/坚韧组/涅槃组无法从对战数据推导）。
// 按组内队伍名单精确匹配后才应用；名单对不上（其他赛季/其他赛段）自动退回“第N组”。
const KNOWN_GROUP_LABELS = [
  { name: "登峰组", desc: "前4直进淘汰赛；第5/6名进骑士之路第一轮", teams: ["AL", "BLG", "WBG", "北京JDG", "TES", "IG"] },
  { name: "坚韧组", desc: "第1/2名进骑士之路第一轮；第3/4名进第二轮", teams: ["深圳NIP", "西安WE", "EDG", "TT"] },
  { name: "涅槃组", desc: "第1/2名进骑士之路第二轮；第3/4名本赛段淘汰", teams: ["苏州LNG", "OMG", "LGD", "UP"] },
];

// stage 分类规则（按 2019-2026 官方命名实测归纳；未命中任何规则的 stage 归入“其他阶段”，不丢数据）
const SPLIT_RE = /^第[一二三四五六七八九十]+赛段/;   // 第一赛段组内赛 / 第三赛段骑士之路 …
const GROUP_PHASE_RE = /组内赛|常规赛|小组赛|瑞士轮/;   // 循环赛阶段（用于推导分组；瑞士轮按整体一组统计）
const KNIGHT_RE = /骑士之路/;
const PLAYOFF_RE = /淘汰赛|季后赛|决赛组/;              // 单败淘汰（最后一轮即决赛）

// 通用阶段（无“第X赛段”前缀）的角色判定：
// group = 循环赛（分组 + 积分榜）/ final = 淘汰（对阵树 + 冠军）/ other = 对阵树（不评冠军）
function stageRole(stage) {
  const s = String(stage || "");
  if (GROUP_PHASE_RE.test(s)) return "group";
  if (PLAYOFF_RE.test(s)) return "final";
  return "other";
}

const CN_NUM = { "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9 };
function splitOrder(name) {
  const m = name.match(/^第([一二三四五六七八九十]+)赛段$/);
  if (!m) return 99;
  const n = m[1].match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
  if (n) return (n[1] ? CN_NUM[n[1]] : 1) * 10 + (n[2] ? CN_NUM[n[2]] : 0); // 十 ~ 九十九
  return CN_NUM[m[1]] || 99;
}

// 占位队名（晋级未定，如 “TBD vs TBD” 的淘汰赛赛程）：
// 不参与晋级链与分组推导，否则会被当作真实队伍串出错误的轮次/分组
function isPlaceholderTeam(name) {
  const n = String(name || "").trim().toUpperCase();
  return !n || n === "TBD";
}

// 由组内赛对战关系推导分组（连通分量）
function deriveGroups(matches) {
  const adj = new Map();
  for (const m of matches) {
    if (isPlaceholderTeam(m.teamA.name) || isPlaceholderTeam(m.teamB.name)) continue;
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
    desc: "",
    teams: c,
  }));
}

// 由队伍数与已排场次推断循环制说明（单循环 n(n-1)/2 场 / 双循环 n(n-1) 场）
function roundRobinDesc(teams, matches) {
  const n = teams.length;
  if (n < 2) return "";
  const inGroup = matches.filter((m) => teams.includes(m.teamA.name) && teams.includes(m.teamB.name));
  if (inGroup.length === n * (n - 1)) return `${n}队双循环`;
  if (inGroup.length === (n * (n - 1)) / 2) return `${n}队单循环`;
  return "";
}

function lastTime(matches) {
  return matches.reduce((acc, m) => {
    const t = new Date(m.time || 0).getTime() || 0;
    return t > acc ? t : acc;
  }, 0);
}

function firstTime(matches) {
  return matches.reduce((acc, m) => {
    const t = new Date(m.time || 0).getTime() || 0;
    return !acc || t < acc ? t : acc;
  }, 0);
}

// 阶段状态：finished=全部打完 / current=进行中 / upcoming=尚未开打
function sectionStatus(matches) {
  if (!matches.length) return "upcoming";
  if (matches.every((m) => m.status === 3)) return "finished";
  if (matches.every((m) => m.status === 1)) return "upcoming";
  return "current";
}

function findTeam(teamList, name) {
  return teamList.find((t) => t.name === name) || { id: "", name, logo: "" };
}

// 把一列比赛重建为树状对阵：按时间排序，每场的轮次 = 双方上一场比赛轮次+1，
// 并记录父节点（双方各自上一场的比赛 id），前端据此画树状连线。
// 双方都为 TBD 的纯占位场次无法进晋级链：按官方轮次标注（week，如 四分之一决赛/
// 半决赛/决赛）各自成轮，按最早开赛时间排序，堆叠在链上轮次之后。
function buildBracketRounds(list, { finalIsFinal = true } = {}) {
  const sorted = [...list].sort((a, b) => (a.time || "").localeCompare(b.time || ""));
  const isPlaceholder = (m) => isPlaceholderTeam(m.teamA.name) && isPlaceholderTeam(m.teamB.name);
  const real = sorted.filter((m) => !isPlaceholder(m));
  const placeholders = sorted.filter(isPlaceholder);

  const teamLast = new Map(); // 队名 -> 最近一场 node
  const nodes = [];
  for (const m of real) {
    const pA = teamLast.get(m.teamA.name) || null;
    const pB = teamLast.get(m.teamB.name) || null;
    const round = 1 + Math.max(pA ? pA.round : 0, pB ? pB.round : 0);
    const node = { match: m, round, parents: [pA ? pA.match.id : null, pB ? pB.match.id : null] };
    nodes.push(node);
    teamLast.set(m.teamA.name, node);
    teamLast.set(m.teamB.name, node);
  }
  const chainMax = nodes.reduce((acc, n) => Math.max(acc, n.round), 0);

  if (placeholders.length) {
    // 按官方轮次标注分组；同一标注为一轮（时间序），无标注则全部并入一轮
    const byWeek = new Map();
    for (const m of placeholders) {
      const key = m.week || "";
      if (!byWeek.has(key)) byWeek.set(key, []);
      byWeek.get(key).push(m);
    }
    const weeks = [...byWeek.entries()].sort((a, b) => firstTime(a[1]) - firstTime(b[1]));
    weeks.forEach(([, ms], wi) => {
      for (const m of ms) nodes.push({ match: m, round: chainMax + 1 + wi, parents: [null, null] });
    });
  }

  const maxRound = Math.max(0, ...nodes.map((n) => n.round));
  const CN = ["", "一", "二", "三", "四", "五", "六", "七", "八"];
  const rounds = [];
  for (let r = 1; r <= maxRound; r++) {
    const ms = nodes.filter((n) => n.round === r).map((n) => ({ ...n.match, parents: n.parents }));
    if (ms.length) rounds.push({ name: r === maxRound && finalIsFinal ? "决赛" : `第${CN[r] || r}轮`, matches: ms });
  }
  return rounds;
}

// 组装一个“赛段/阶段”的全部结构数据（分组 + 对阵树 + 冠军 + 组内积分榜）
function buildSection({ key, name, groupMatches, brackets, teams, isSplit, singleGroupName }) {
  const allMatches = [...groupMatches, ...brackets.flatMap((b) => b.matches)];

  // 分组：由组内赛对战连通性推导；命中已知名单（登峰/坚韧/涅槃）时套用展示名
  let groups = deriveGroups(groupMatches).map((g) => {
    const known = KNOWN_GROUP_LABELS.find((l) => l.teams.length === g.teams.length && l.teams.every((t) => g.teams.includes(t)));
    return known
      ? { name: known.name, desc: known.desc, teams: g.teams }
      : { name: g.name, desc: roundRobinDesc(g.teams, groupMatches), teams: g.teams };
  });
  // 只推导出一个组时（瑞士轮 / 单组赛制），用阶段名作组名
  if (groups.length === 1 && singleGroupName) groups[0].name = singleGroupName;
  if (!groups.length && isSplit && allMatches.length) {
    // 组内赛尚未开打（无法推导分组）：先按该赛段全部队伍给占位分组（TBD 除外）
    const names = [...new Set(allMatches.flatMap((m) => [m.teamA.name, m.teamB.name]))]
      .filter((n) => !isPlaceholderTeam(n));
    if (names.length) groups = [{ name: "组内赛", desc: "开赛后按对战关系自动分组", teams: names }];
  }

  const builtBrackets = brackets
    .map((b) => ({ key: b.key, title: b.title, rounds: buildBracketRounds(b.matches, { finalIsFinal: b.finalIsFinal }) }))
    .filter((b) => b.rounds.length);

  // 冠军：淘汰赛类对阵中时间最后一场已结束比赛的胜者
  let champion = null;
  const finals = brackets.filter((b) => b.finalIsFinal).flatMap((b) => b.matches).filter((m) => m.status === 3);
  if (finals.length) {
    const last = finals.reduce((a, b) => ((new Date(b.time || 0) > new Date(a.time || 0)) ? b : a));
    champion = last.winner === "A" ? last.teamA.name : last.winner === "B" ? last.teamB.name : null;
  }

  // 组内积分榜（每组只统计组内对战）
  const standings = groups.map((g) => ({
    name: g.name,
    rows: computeStandings(groupMatches.filter((m) => g.teams.includes(m.teamA.name) && g.teams.includes(m.teamB.name))),
  }));

  const finished = allMatches.filter((m) => m.status === 3);
  return {
    key,
    name,
    status: sectionStatus(allMatches),
    champion,
    groups: groups.map((g) => ({ name: g.name, desc: g.desc, teams: g.teams.map((n) => findTeam(teams, n)) })),
    brackets: builtBrackets,
    standings,
    lastFinishedAt: finished.length ? new Date(lastTime(finished)).toISOString() : null,
  };
}

async function getSeasonStructure({ league = DEFAULT_LEAGUE, seasonId } = {}) {
  const season = seasonId || (await latestSeason(league)).id;
  const { matches } = await getSchedule({ league, seasonId: season });
  const teams = [...(await getTeams(league, season)).values()];

  // 1) 按 stage 归类：带“第X赛段”前缀的进赛段桶；其余每个 stage 一个独立阶段
  //    （LPL：赛季季后赛/资格赛；世界赛：瑞士轮/淘汰赛/入围赛；德杯：小组赛/淘汰赛/决赛组…）
  const splitStages = new Map(); // 赛段名 -> Map(stage -> matches)
  const stageMap = new Map();    // 其余 stage -> matches
  for (const m of matches) {
    const stage = String(m.stage || "");
    if (isExcludedStage(stage)) continue;
    const splitHit = stage.match(SPLIT_RE);
    if (splitHit) {
      if (!splitStages.has(splitHit[0])) splitStages.set(splitHit[0], new Map());
      const byStage = splitStages.get(splitHit[0]);
      if (!byStage.has(stage)) byStage.set(stage, []);
      byStage.get(stage).push(m);
    } else {
      if (!stageMap.has(stage)) stageMap.set(stage, []);
      stageMap.get(stage).push(m);
    }
  }

  // 2) 赛段卡片（按 一<二<三… 排序）
  const splits = [...splitStages.keys()].sort((a, b) => splitOrder(a) - splitOrder(b)).map((splitName) => {
    const byStage = splitStages.get(splitName);
    // 循环赛阶段可能有多个（如 2025 第二赛段先“小组赛”后“组内赛”）：取结束时间最晚的作主分组阶段，
    // 其余循环赛阶段不进对阵（属预赛性质，赛程/积分照常计入）
    const groupStageNames = [...byStage.keys()].filter((s) => GROUP_PHASE_RE.test(s.slice(splitName.length)));
    let mainGroup = null;
    for (const s of groupStageNames) {
      const t = lastTime(byStage.get(s));
      if (!mainGroup || t > mainGroup.t) mainGroup = { stage: s, t };
    }
    const groupMatches = mainGroup ? byStage.get(mainGroup.stage) : [];
    // 其余 stage 各成一棵对阵树：骑士之路类在前、淘汰赛类在后，其余按时间
    const brackets = [...byStage.entries()]
      .filter(([s]) => s !== (mainGroup && mainGroup.stage) && !GROUP_PHASE_RE.test(s.slice(splitName.length)))
      .map(([s, ms]) => {
        const rest = s.slice(splitName.length);
        return {
          key: s,
          title: rest || splitName,
          finalIsFinal: PLAYOFF_RE.test(rest) && !KNIGHT_RE.test(rest),
          matches: ms,
          sortKind: KNIGHT_RE.test(rest) ? 0 : PLAYOFF_RE.test(rest) ? 2 : 1,
          sortTime: lastTime(ms),
        };
      })
      .sort((a, b) => a.sortKind - b.sortKind || a.sortTime - b.sortTime);
    return buildSection({
      key: splitName, name: splitName, groupMatches, brackets, teams, isSplit: true,
      singleGroupName: mainGroup ? (mainGroup.stage.slice(splitName.length) || splitName) : null,
    });
  });

  // 3) 通用阶段卡片：group 类（瑞士轮/小组赛…）→ 分组 + 积分榜；
  //    final 类（淘汰赛/季后赛/决赛组）→ 对阵树 + 冠军；其余（资格赛/入围赛/骑士之路类）→ 对阵树
  const sections = [...stageMap.entries()]
    .map(([stage, ms]) => {
      const role = stageRole(stage);
      const name = stage.replace(/^\d{4}赛季?/, "") || stage; // “2026赛季季后赛”→“赛季季后赛”
      if (role === "group") {
        return {
          t: firstTime(ms),
          section: buildSection({ key: stage, name, groupMatches: ms, brackets: [], teams, isSplit: false, singleGroupName: name }),
        };
      }
      return {
        t: firstTime(ms),
        section: buildSection({
          key: stage, name, groupMatches: [], teams, isSplit: false,
          brackets: [{ key: stage, title: name, finalIsFinal: role === "final", matches: ms, sortKind: 2, sortTime: lastTime(ms) }],
        }),
      };
    })
    .sort((a, b) => a.t - b.t)
    .map((x) => x.section);

  // 4) 默认展示的赛段：进行中的 → 最近有完赛的 → 最后一个
  const all = [...splits, ...sections];
  let defaultSplit = all.length ? all[all.length - 1].key : null;
  let bestFinished = -1;
  for (const s of all) {
    if (s.status === "current") { defaultSplit = s.key; break; }
    const t = s.lastFinishedAt ? new Date(s.lastFinishedAt).getTime() : 0;
    if (t > bestFinished) { bestFinished = t; defaultSplit = s.key; }
  }

  return { league, seasonId: season, defaultSplit, splits: all };
}

// 按赛段返回分组的积分榜
async function getStandingsGroups(stage, { league = DEFAULT_LEAGUE, seasonId } = {}) {
  if (!stage || stage === "全部") {
    const { matches } = await getSchedule({ league, seasonId });
    return [{ name: "整个赛季", rows: computeStandings(matches) }];
  }
  const structure = await getSeasonStructure({ league, seasonId });
  const split = structure.splits.find((s) => s.key === stage);
  return split ? split.standings : [];
}

module.exports = {
  LEAGUES, DEFAULT_LEAGUE,
  listSeasons, latestSeason, getTeams, getLogo, getSchedule, getMatchDetail, getSeasonStructure, getStandingsGroups, resetTeamCache,
  // 以下为纯函数，导出仅供单测使用（不承担对外 API 职责）
  stripJsonp, isExcludedStage, splitOrder, stageRole, boLabel, normalizeMatch, deriveGroups, buildBracketRounds,
};
