// ============================================================
// LPL 数据源纯函数单测（node:test，零依赖、不联网）
// 运行：node --test web/test/
// ============================================================
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const {
  stripJsonp, isExcludedStage, splitOrder, normalizeMatch, deriveGroups, buildBracketRounds,
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
