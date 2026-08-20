// ============================================================
// 战队显示名 & 配色配置（LPL）
// LPL 使用腾讯官方中文名（北京JDG / 苏州LNG …）
// ============================================================

// 每队配色（用于文字徽标兜底；key 用队伍展示名）
const TEAM_COLORS = {
  "EDG": "#d6a45c", "IG": "#b98b28", "LGD": "#7a8b2f", "OMG": "#2f6f8f",
  "苏州LNG": "#3a8f5f", "西安WE": "#c2552e", "北京JDG": "#8f3a5f", "WBG": "#5c5cd6",
  "TES": "#d66a3a", "BLG": "#3a6ad6", "AL": "#7a2fd6", "TT": "#2fa8a8",
  "深圳NIP": "#c2b03a", "UP": "#d64040",
  "default": "#5a5f6a",
};

// 展示名（LPL 直接用官方名）
function displayName(name) {
  return name || "TBD";
}

// 短名（徽标用）：中文队名取末尾英文部分（北京JDG -> JDG）；纯中文取前2字
function shortName(name) {
  if (!name) return "?";
  name = String(name).trim();
  const m = name.match(/[A-Za-z0-9]+$/);
  return m ? m[0] : name.slice(0, 2).toUpperCase();
}

// 队伍颜色
function teamColor(name) {
  return TEAM_COLORS[name] || TEAM_COLORS["default"];
}

module.exports = { TEAM_COLORS, displayName, shortName, teamColor };
