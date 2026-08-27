// ============================================================
// 积分榜计算：由已结束比赛的赛果统计 胜/负/胜率/净胜/连胜/近况
// ============================================================
"use strict";

function computeStandings(matches) {
  const teams = new Map(); // key: teamName

  const getTeam = (t) => {
    if (!teams.has(t.name)) {
      teams.set(t.name, {
        name: t.name,
        display: t.display || t.name,
        id: t.id,
        short: t.short || t.name,
        logo: t.logo || "",
        color: t.color || "",
        wins: 0,
        losses: 0,
        net: 0,
        results: [], // 最近在前："W"/"L"
      });
    }
    return teams.get(t.name);
  };

  for (const m of matches) {
    if (m.status !== 3 || m.scoreA === undefined || m.scoreB === undefined) continue;
    const ta = getTeam(m.teamA);
    const tb = getTeam(m.teamB);
    if (m.scoreA > m.scoreB) {
      ta.wins++; tb.losses++;
      ta.net += m.scoreA - m.scoreB;
      tb.net += m.scoreB - m.scoreA;
      ta.results.unshift("W"); tb.results.unshift("L");
    } else if (m.scoreB > m.scoreA) {
      tb.wins++; ta.losses++;
      tb.net += m.scoreB - m.scoreA;
      ta.net += m.scoreA - m.scoreB;
      tb.results.unshift("W"); ta.results.unshift("L");
    }
  }

  const rows = [...teams.values()].map((t) => {
    const total = t.wins + t.losses;
    const winrate = total ? (t.wins / total) : 0;
    // 积分：系列赛胜场 × 3（Bo3 常规赛通用规则）
    const points = t.wins * 3;
    // 连胜/连败
    let streak = 0;
    if (t.results.length) {
      const first = t.results[0];
      for (const r of t.results) {
        if (r === first) streak++;
        else break;
      }
      streak = first === "W" ? streak : -streak;
    }
    return {
      ...t,
      played: total,
      winrate,
      points,
      streak,
      last5: t.results.slice(0, 5),
    };
  });

  // 按积分排序（积分相同再按胜率/胜场/净胜场）
  rows.sort((a, b) => b.points - a.points || b.winrate - a.winrate || b.wins - a.wins || b.net - a.net || a.name.localeCompare(b.name, "zh-CN"));
  rows.forEach((r, i) => (r.rank = i + 1));
  return rows;
}

module.exports = { computeStandings };
