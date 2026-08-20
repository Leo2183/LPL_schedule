// ============================================================
// LOL 赛事中心 —— LPL 赛程查询
// 零依赖 Node.js HTTP 服务：静态资源 + JSON API + 内存缓存 + 磁盘缓存
// 启动：node server.js  (默认 http://127.0.0.1:45231)
// ============================================================
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const lpl = require("./lib/lpl");
const { displayName, shortName, teamColor } = require("./lib/names");

const PORT = Number(process.env.PORT || 45231);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");

// ---------------- 缓存（内存 + 磁盘持久化）----------------
const cacheStore = new Map(); // key -> { expiry, promise, value }
const CACHE_FILE = path.join(__dirname, "data", "cache.json");
let diskDirty = false;
let diskTimer = null;
const FALLBACK_TTL = 30 * 1000; // 拉取失败用旧值兜底时，30 秒后再尝试

// 启动时从磁盘加载缓存（重启不丢）
function loadDiskCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const j = JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
      let n = 0;
      for (const [key, entry] of Object.entries(j.entries || {})) {
        if (entry && entry.value !== undefined) {
          cacheStore.set(key, { expiry: entry.expiry || 0, promise: Promise.resolve(entry.value), value: entry.value });
          n++;
        }
      }
      console.log(`[cache] 已从磁盘加载 ${n} 项缓存`);
      return n > 0;
    }
  } catch (e) {
    console.warn("[cache] 磁盘缓存加载失败:", e.message);
  }
  return false;
}

// 节流写盘（3 秒合并一次；只写未过期条目，自动清理过期数据）
function scheduleDiskWrite() {
  if (diskDirty) return;
  diskDirty = true;
  clearTimeout(diskTimer);
  diskTimer = setTimeout(() => {
    diskDirty = false;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      const now = Date.now();
      const entries = {};
      for (const [key, entry] of cacheStore.entries()) {
        if (entry.value !== undefined && entry.expiry > now) {
          entries[key] = { value: entry.value, expiry: entry.expiry };
        }
      }
      fs.writeFileSync(CACHE_FILE, JSON.stringify({ savedAt: new Date().toISOString(), entries }));
    } catch (e) { /* 写盘失败不致命 */ }
  }, 3000);
}

function cached(key, ttlMs, fn, force) {
  const now = Date.now();
  const hit = cacheStore.get(key);
  if (!force && hit && hit.expiry > now) return hit.promise;
  const promise = fn()
    .then((v) => {
      cacheStore.set(key, { expiry: now + ttlMs, promise: Promise.resolve(v), value: v });
      scheduleDiskWrite();
      return v;
    })
    .catch((e) => {
      // 拉取失败：用旧值兜底（hit 可能来自磁盘加载或此前成功，注意末尾的 set 会覆盖它，须用开头捕获的 hit）
      if (hit && hit.value !== undefined) {
        console.warn(`[cache] ${key} 拉取失败，使用缓存兜底: ${e.message}`);
        const fallback = hit.value;
        cacheStore.set(key, { expiry: now + FALLBACK_TTL, promise: Promise.resolve(fallback), value: fallback });
        return fallback;
      }
      cacheStore.delete(key);
      throw e;
    });
  cacheStore.set(key, { expiry: now + ttlMs, promise });
  return promise;
}

loadDiskCache();

// ---------------- 数据组装 ----------------
function decorateLpl(matches) {
  return matches.map((m) => decorateMatch(m));
}
function decorateMatch(m) {
  const ta = { ...m.teamA, display: displayName(m.teamA.name), short: shortName(m.teamA.name), color: teamColor(m.teamA.name) };
  const tb = { ...m.teamB, display: displayName(m.teamB.name), short: shortName(m.teamB.name), color: teamColor(m.teamB.name) };
  return { ...m, teamA: ta, teamB: tb };
}

// 动态缓存时长：已结束/无临近比赛的赛程是静态数据（基本不用重拉），
// 只在有比赛进行或即将开赛时缩短 TTL 以便刷新比分/状态
const NEAR_WINDOW_BEFORE = 4 * 3600 * 1000; // 开赛后 4 小时内（最长 Bo5 也打完了）
const NEAR_WINDOW_AFTER = 2 * 3600 * 1000;  // 开赛前 2 小时内（即将开始）
const TTL_LIVE = 60 * 1000;   // 有比赛进行/临近：60 秒刷新
const TTL_STATIC = 60 * 60 * 1000; // 无比赛：1 小时缓存（静态数据不会变）

function scheduleTtl() {
  const hit = cacheStore.get("lpl:schedule");
  const matches = (hit && hit.value && hit.value.matches) || [];
  if (!matches.length) return TTL_STATIC;
  const now = Date.now();
  const hasNear = matches.some((m) => {
    if (!m.time) return false;
    const t = new Date(m.time).getTime();
    return t >= now - NEAR_WINDOW_BEFORE && t <= now + NEAR_WINDOW_AFTER;
  });
  return hasNear ? TTL_LIVE : TTL_STATIC;
}

async function lplSchedule(force) {
  const data = await cached("lpl:schedule", scheduleTtl(), async () => {
    const s = await lpl.getSchedule();
    return { seasonId: s.seasonId, matches: decorateLpl(s.matches) };
  }, force);
  return data;
}

// 装饰积分榜行
function decorateTeamRow(r) {
  return { ...r, display: r.display || r.name, short: shortName(r.name), color: teamColor(r.name) };
}

// 装饰赛季结构（队伍 + 比赛）
function decorateSeasonStructure(structure) {
  const decoTeam = (t) => ({ ...t, display: displayName(t.name), short: shortName(t.name), color: teamColor(t.name) });
  const decoMatch = (m) => ({ ...m, teamA: decoTeam(m.teamA), teamB: decoTeam(m.teamB) });
  for (const split of structure.splits || []) {
    split.groups = (split.groups || []).map((g) => ({ ...g, teams: g.teams.map(decoTeam) }));
    split.knightRoad = (split.knightRoad || []).map((r) => ({ ...r, matches: r.matches.map(decoMatch) }));
    split.playoffs = (split.playoffs || []).map((r) => ({ ...r, matches: r.matches.map(decoMatch) }));
    split.standings = (split.standings || []).map(decorateTeamRow);
  }
  return structure;
}

// ---------------- HTTP ----------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function sendError(res, code, message) {
  sendJson(res, code, { ok: false, error: message });
}

async function handleApi(req, res, url) {
  const pathname = url.pathname;

  // 健康检查
  if (pathname === "/api/health") {
    return sendJson(res, 200, { ok: true, time: new Date().toISOString() });
  }

  // LPL 赛季列表
  if (pathname === "/api/lpl/seasons") {
    try {
      const seasons = await cached("lpl:seasons", 3600 * 1000, () => lpl.listSeasons());
      return sendJson(res, 200, { ok: true, seasons });
    } catch (e) {
      return sendError(res, 502, `获取 LPL 赛季失败: ${e.message}`);
    }
  }

  // LPL 赛程
  if (pathname === "/api/lpl/schedule") {
    try {
      const force = url.searchParams.get("force") === "1";
      const data = await lplSchedule(force);
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendError(res, 502, `获取 LPL 赛程失败: ${e.message}`);
    }
  }

  // LPL 比赛详情 /api/lpl/match/:id
  const lplMatch = pathname.match(/^\/api\/lpl\/match\/(\d+)$/);
  if (lplMatch) {
    const id = lplMatch[1];
    try {
      const detail = await cached(`lpl:detail:${id}`, 15 * 60 * 1000, async () => {
        const d = await lpl.getMatchDetail(id);
        const decorated = decorateMatch(d);
        // 详情数据不带队徽，从官方队徽表补
        decorated.teamA.logo = decorated.teamA.logo || (await lpl.getLogo(decorated.teamA.id));
        decorated.teamB.logo = decorated.teamB.logo || (await lpl.getLogo(decorated.teamB.id));
        return decorated;
      });
      return sendJson(res, 200, { ok: true, detail });
    } catch (e) {
      if (e.code === "NO_DETAIL") return sendError(res, 404, e.message);
      return sendError(res, 502, `获取比赛详情失败: ${e.message}`);
    }
  }

  // LPL 赛季结构（对阵图）
  if (pathname === "/api/lpl/season") {
    try {
      const structure = await cached("lpl:season", scheduleTtl(), async () => {
        const s = await lpl.getSeasonStructure();
        return decorateSeasonStructure(s);
      }, url.searchParams.get("force") === "1");
      return sendJson(res, 200, { ok: true, ...structure });
    } catch (e) {
      return sendError(res, 502, `获取赛季结构失败: ${e.message}`);
    }
  }

  // 积分榜（按赛段 + 组别分组，组内按积分排序）
  if (pathname === "/api/standings") {
    const league = url.searchParams.get("league") || "";
    const stage = url.searchParams.get("stage") || "全部";
    if (league !== "lpl") return sendError(res, 400, "仅支持 LPL 积分榜");
    try {
      const data = await cached(`lpl:standings:${stage}`, scheduleTtl(), async () => {
        const groups = await lpl.getStandingsGroups(stage);
        return {
          league, stage,
          groups: groups.map((g) => ({ name: g.name, rows: g.rows.map(decorateTeamRow) })),
        };
      }, url.searchParams.get("force") === "1");
      return sendJson(res, 200, { ok: true, ...data });
    } catch (e) {
      return sendError(res, 502, `获取积分榜失败: ${e.message}`);
    }
  }

  return sendError(res, 404, "接口不存在");
}

// 静态文件
function serveStatic(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(pathname));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end("Forbidden");
  }
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      return res.end("404 Not Found");
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(buf);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (e) {
    console.error("[server]", e);
    if (!res.headersSent) sendError(res, 500, "服务器内部错误");
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  ⚡ LOL 赛事中心 —— LPL 赛程查询");
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log("");
});
