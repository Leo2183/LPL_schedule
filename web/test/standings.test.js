// ============================================================
// 积分榜计算单测（node:test，零依赖）
// 运行：node --test web/test/
// ============================================================
"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { computeStandings } = require("../lib/standings");

// 构造一场已结束的系列赛（status=3）
function m(aName, bName, sa, sb, status = 3, time = "2026-03-01T11:00:00.000Z") {
  return {
    status,
    scoreA: sa,
    scoreB: sb,
    time,
    teamA: { id: "1", name: aName, logo: "" },
    teamB: { id: "2", name: bName, logo: "" },
  };
}
const byName = (rows) => Object.fromEntries(rows.map((r) => [r.name, r]));

test("胜负 / 场次 / 净胜场 / 积分 / 胜率统计", () => {
  const rows = computeStandings([
    m("AL", "BLG", 2, 1),
    m("AL", "TES", 2, 0),
    m("BLG", "TES", 1, 2),
  ]);
  const by = byName(rows);
  assert.equal(by.AL.wins, 2);
  assert.equal(by.AL.losses, 0);
  assert.equal(by.AL.played, 2);
  assert.equal(by.AL.net, 3);        // (2-1) + (2-0)
  assert.equal(by.AL.points, 6);     // 胜场 × 3
  assert.equal(by.AL.winrate, 1);
  assert.equal(by.TES.wins, 1);
  assert.equal(by.TES.losses, 1);
  assert.equal(by.TES.net, -1);      // (2-1) + (0-2)
  assert.equal(by.TES.points, 3);    // 胜 BLG 一场
  assert.equal(by.BLG.points, 0);    // 仅赛一场且负于 AL
});

test("未结束的比赛不计入（未开始/进行中）", () => {
  const rows = computeStandings([
    m("AL", "BLG", 2, 1, 1),          // 未开始
    m("AL", "TES", 1, 0, 2),          // 进行中
  ]);
  assert.equal(rows.length, 0);
});

test("连胜连败与近5场（最新在前）", () => {
  // AL：胜胜负 → 1 连败（最新在前：L W W）
  // BLG：负负胜 → 1 连胜（W L L）
  const rows = computeStandings([
    m("AL", "BLG", 2, 0),
    m("AL", "BLG", 2, 1),
    m("AL", "BLG", 0, 2),
  ]);
  const by = byName(rows);
  assert.equal(by.AL.wins, 2);
  assert.equal(by.AL.losses, 1);
  assert.equal(by.AL.streak, -1);
  assert.deepEqual(by.AL.last5, ["L", "W", "W"]);
  assert.equal(by.BLG.streak, 1);
  assert.deepEqual(by.BLG.last5, ["W", "L", "L"]);
});

test("排序：积分 > 胜率 > 胜场 > 净胜场", () => {
  const rows = computeStandings([
    m("A", "B", 2, 1),
    m("C", "D", 2, 0),
    m("B", "C", 2, 1),   // B、C 各 1 胜 1 负；B 净胜 0，C 净胜 +1 → C 靠前
    m("A", "D", 2, 1),
  ]);
  // A：2 胜 6 分第一；B/C 同分同胜率，按净胜场 C > B；D 0 胜垫底
  assert.deepEqual(rows.map((r) => r.name), ["A", "C", "B", "D"]);
  assert.deepEqual(rows.map((r) => r.rank), [1, 2, 3, 4]);
});

test("空比赛列表返回空榜", () => {
  assert.deepEqual(computeStandings([]), []);
});
