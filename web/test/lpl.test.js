// ============================================================
// LPL 数据源纯函数单测（node:test，零依赖、不联网）
// 运行：node --test web/test/
// ============================================================
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  stripJsonp, isExcludedStage, splitOrder, stageRole, boLabel, normalizeMatch, deriveGroups, buildBracketRounds, LEAGUES,
} = require("../lib/lpl");

// ---------------- stripJsonp ----------------
test("stripJsonp：var retObj={...}; 尾部噪声", () => {
  assert.deepEqual(
    stripJsonp('var retObj={"total":2,"result":[{"id":1},{"id":2}]};if(window.GM)window.GM();'),
    { total: 2, result: [{ id: 1 }, { id: 2 }] },
  );
});

test("stripJsonp：嵌套花括号取首个配平对象", () => {
  assert.deepEqual(stripJsonp('retObj={"a":{"b":{"c":[1]}},"d":null};tail'), { a: { b: { c: [1] } }, d: null });
});

test("stripJsonp：无花括号 / 括号不配平时抛错", () => {
  assert.throws(() => stripJsonp("hello world"));
  assert.throws(() => stripJsonp('retObj={"a":1'));
});

// ---------------- stage 过滤与赛段序号 ----------------
test("isExcludedStage：SOLO 选边局被排除", () => {
  assert.equal(isExcludedStage("SOLO选边"), true);
  assert.equal(isExcludedStage("SOLO选边第二天"), true);
  assert.equal(isExcludedStage("第一赛段组内赛"), false);
  assert.equal(isExcludedStage(""), false);
});

test("splitOrder：中文数字赛段排序（含组合数字）", () => {
  assert.equal(splitOrder("第一赛段"), 1);
  assert.equal(splitOrder("第九赛段"), 9);
  assert.equal(splitOrder("第十赛段"), 10);
  assert.equal(splitOrder("第十三赛段"), 13);
  assert.equal(splitOrder("第二十赛段"), 20);
  assert.equal(splitOrder("第二十三赛段"), 23);
  assert.ok(splitOrder("常规赛") > 20, "未匹配的名称应排到最后");
});

// ---------------- 通用阶段角色（多赛事） ----------------
test("stageRole：循环赛 / 淘汰 / 其他 三类角色", () => {
  assert.equal(stageRole("瑞士轮"), "group");            // 世界赛
  assert.equal(stageRole("小组赛"), "group");            // 德杯 / MSI
  assert.equal(stageRole("第一赛段组内赛"), "group");    // LPL（带前缀不影响）
  assert.equal(stageRole("淘汰赛"), "final");
  assert.equal(stageRole("2026赛季季后赛"), "final");    // LPL 赛季级
  assert.equal(stageRole("决赛组"), "final");            // 德杯
  assert.equal(stageRole("资格赛"), "other");            // 不评冠军
  assert.equal(stageRole("入围赛"), "other");            // 世界赛 / MSI
  assert.equal(stageRole("骑士之路"), "other");
});

test("LEAGUES：四项赛事配置齐全", () => {
  for (const k of ["lpl", "worlds", "msi", "demacia"]) {
    assert.ok(LEAGUES[k] && LEAGUES[k].bGame && LEAGUES[k].label, `缺少 ${k} 配置`);
  }
});

// ---------------- normalizeMatch ----------------
const teamMap = new Map([
  ["1", { id: "1", name: "AL", logo: "https://x/al.png" }],
  ["2", { id: "2", name: "BLG", logo: "https://x/blg.png" }],
]);

function raw(over = {}) {
  return {
    bMatchId: 12345,
    TeamA: "1", TeamB: "2",
    ScoreA: "3", ScoreB: "1",
    MatchStatus: "3",
    GameMode: "4",                       // 腾讯用 4 表示季后赛 Bo5
    MatchDate: "2026-08-23 19:00:00",    // 北京时间
    GameTypeName: "第一赛段淘汰赛",
    GameProcName: "第一天",
    bMatchName: "AL vs BLG",
    ...over,
  };
}

test("normalizeMatch：字段归一化 / Bo 映射 / 北京时间转 ISO", () => {
  const m = normalizeMatch(raw(), teamMap);
  assert.equal(m.id, "lpl-12345");
  assert.equal(m.sourceId, "12345");
  assert.equal(m.stage, "第一赛段淘汰赛");
  assert.equal(m.week, "第一天");
  assert.equal(m.bo, "Bo5");                          // GameMode 4 → Bo5
  assert.equal(m.winner, "A");
  assert.equal(m.teamA.name, "AL");
  assert.equal(m.teamA.logo, "https://x/al.png");
  assert.equal(m.time, "2026-08-23T11:00:00.000Z");   // 19:00 +08:00 → 11:00Z
});

test("normalizeMatch：GameMode 1/3/5 与未知值", () => {
  assert.equal(normalizeMatch(raw({ GameMode: "1" }), teamMap).bo, "Bo1");
  assert.equal(normalizeMatch(raw({ GameMode: "3" }), teamMap).bo, "Bo3");
  assert.equal(normalizeMatch(raw({ GameMode: "5" }), teamMap).bo, "Bo5");
  assert.equal(normalizeMatch(raw({ GameMode: "2" }), teamMap).bo, "Bo2");
});

// ---------------- boLabel（gameMode 双格式兼容） ----------------
test("boLabel：赛程接口数字与详情接口字符串（BO5）两种格式", () => {
  // 赛程接口：数字
  assert.equal(boLabel("1"), "Bo1");
  assert.equal(boLabel("3"), "Bo3");
  assert.equal(boLabel("4"), "Bo5");   // 腾讯用 4 表示季后赛 Bo5
  assert.equal(boLabel("5"), "Bo5");
  assert.equal(boLabel("2"), "Bo2");
  // 详情接口（tjstats）：字符串 “BO5”/“BO3”（曾导致世界赛详情误标 Bo3）
  assert.equal(boLabel("BO5"), "Bo5");
  assert.equal(boLabel("BO3"), "Bo3");
  assert.equal(boLabel("bo1"), "Bo1");
  // 缺省 / 未知
  assert.equal(boLabel(undefined), "Bo3");
  assert.equal(boLabel(""), "Bo3");
});

test("normalizeMatch：league 参数决定 id 前缀与赛事名", () => {
  const m = normalizeMatch(raw(), teamMap, "worlds");
  assert.equal(m.id, "worlds-12345");
  assert.equal(m.league, "worlds");
  assert.equal(m.leagueName, "全球总决赛");
});

test("normalizeMatch：未结束无 winner；平局比分不产生 winner", () => {
  assert.equal(normalizeMatch(raw({ MatchStatus: "2" }), teamMap).winner, null);
  assert.equal(normalizeMatch(raw({ ScoreA: "1", ScoreB: "1" }), teamMap).winner, null);
});

test("normalizeMatch：战队表缺失时从 bMatchName 兜底（TBD）", () => {
  const m = normalizeMatch(raw({ TeamA: "9", TeamB: "8", bMatchName: "TES vs IG" }), teamMap);
  assert.equal(m.teamA.name, "TES");
  assert.equal(m.teamB.name, "IG");
  // 无 “ vs ” 分隔时：A 侧取整串（占位队名，如线上 “资格赛D3”），B 侧 TBD
  const tbd = normalizeMatch(raw({ TeamA: "9", TeamB: "8", bMatchName: "资格赛D3" }), teamMap);
  assert.equal(tbd.teamA.name, "资格赛D3");
  assert.equal(tbd.teamB.name, "TBD");
});

// ---------------- deriveGroups（连通分量分组） ----------------
function gm(a, b) {
  return { teamA: { name: a }, teamB: { name: b } };
}

test("deriveGroups：组内互打的队伍归为同组，组间分离", () => {
  const groups = deriveGroups([
    gm("A", "B"), gm("B", "C"), gm("C", "A"),   // 第一组
    gm("D", "E"), gm("E", "D"),                 // 第二组
  ]);
  assert.equal(groups.length, 2);
  assert.deepEqual([...groups[0].teams].sort(), ["A", "B", "C"]);
  assert.deepEqual([...groups[1].teams].sort(), ["D", "E"]);
});

test("deriveGroups：空列表返回空", () => {
  assert.deepEqual(deriveGroups([]), []);
});

// ---------------- buildBracketRounds（对阵树） ----------------
function bm(id, a, b, time) {
  return { id, time, teamA: { name: a }, teamB: { name: b } };
}

test("buildBracketRounds：轮次推导 / 父节点连线 / 决赛命名", () => {
  const rounds = buildBracketRounds([
    bm("q1", "A", "B", "2026-01-01T10:00:00.000Z"),
    bm("q2", "C", "D", "2026-01-01T12:00:00.000Z"),
    bm("f", "A", "C", "2026-01-02T10:00:00.000Z"),
  ]);
  assert.equal(rounds.length, 2);
  assert.equal(rounds[0].name, "第一轮");
  assert.equal(rounds[1].name, "决赛");                       // finalIsFinal 默认 true
  assert.deepEqual(rounds[1].matches[0].parents, ["q1", "q2"]); // 决赛双方来自两场半决赛
  const r1Ids = rounds[0].matches.map((x) => x.id).sort();
  assert.deepEqual(r1Ids, ["q1", "q2"]);
});

test("buildBracketRounds：finalIsFinal=false 时末轮不叫决赛", () => {
  const rounds = buildBracketRounds([
    bm("q1", "A", "B", "2026-01-01T10:00:00.000Z"),
    bm("f", "A", "B", "2026-01-02T10:00:00.000Z"),
  ], { finalIsFinal: false });
  assert.equal(rounds.length, 2);
  assert.equal(rounds[1].name, "第二轮");
});

// ---------------- TBD 占位场次（如 2026 世界赛淘汰赛未开赛） ----------------
function pm(id, week, time) {
  return { id, time, week, teamA: { name: "TBD" }, teamB: { name: "TBD" } };
}

test("buildBracketRounds：全 TBD 占位按官方轮次标注成轮（时间序）", () => {
  const rounds = buildBracketRounds([
    pm("f", "决赛", "2026-11-08T00:00:00.000Z"),
    pm("qf1", "四分之一决赛", "2026-10-25T00:00:00.000Z"),
    pm("qf2", "四分之一决赛", "2026-10-26T00:00:00.000Z"),
    pm("sf", "半决赛", "2026-11-01T00:00:00.000Z"),
  ]);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map((r) => r.matches.length), [2, 1, 1]); // QF2 SF1 F1
  assert.equal(rounds[2].name, "决赛");
  assert.deepEqual(rounds[2].matches[0].parents, [null, null]);     // 占位无连线
});

test("buildBracketRounds：占位轮堆叠在真实晋级链之后", () => {
  const rounds = buildBracketRounds([
    bm("r1", "A", "B", "2026-01-01T00:00:00.000Z"),
    bm("r2", "A", "B", "2026-01-02T00:00:00.000Z"),                 // 链上 2 轮
    pm("p1", "资格赛", "2026-01-05T00:00:00.000Z"),                 // 占位 → 第 3 轮
  ]);
  assert.equal(rounds.length, 3);
  assert.deepEqual(rounds.map((r) => r.matches.map((m) => m.id)), [["r1"], ["r2"], ["p1"]]);
});

test("deriveGroups：TBD 占位队不参与分组推导", () => {
  const groups = deriveGroups([
    gm("A", "B"), gm("B", "A"),
    gm("TBD", "TBD"),                       // 纯占位，忽略
    gm("C", "TBD"),                         // 一侧占位，忽略
  ]);
  assert.equal(groups.length, 1);
  assert.deepEqual([...groups[0].teams].sort(), ["A", "B"]);
});
