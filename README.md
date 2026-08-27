# LPL 赛事中心 · LPL 赛程 Android App

把 **LPL 赛程网页程序**（零依赖 Node.js + 原生 HTML/CSS/JS 前端）打包成 **Android APK** 的套壳方案：**nodejs-mobile（手机本地跑 Node 服务）+ WebView（渲染前端页面）**。

> 数据来源：腾讯官方赛事接口 · 仅供学习交流

---

## ✨ 功能特性

- **LPL 赛程**：三赛段赛程、按日期浏览、比赛状态（未开始 / 进行中 / 已结束）筛选
- **按战队筛选**：跨全部日期展示所选战队的全部比赛，可与状态筛选叠加
- **对阵图**：赛季结构 / 分组 / 骑士之路 / 季后赛树状对阵
- **积分榜**：按赛段 + 组别分组，组内按积分排序（积分 = 系列赛胜场 × 3），展示胜率、净胜场、近 5 场与连胜/连败
- **比赛二级详情页**：逐局选手数据（KDA / 参团率 / 伤害 / 分均 / 经济 / 补刀 / 视野 / 等级 / 装备）
- **英雄 / 队徽 / 装备图标**：加载失败自动回退文字徽标
- **状态栏沉浸式适配**：顶部导航自动避让状态栏
- **磁盘缓存 + 动态刷新**：有比赛时 60s 自动刷新，无比赛 1h
- **功能边界**：无 LCK、无评分

---

## 🏗️ 技术方案

```
┌─────────────────────────────────────────────┐
│  MainActivity (Android)                     │
│  ├─ 启动 Node 线程 (native-lib.cpp → node)  │
│  │    └─ libnode.so (nodejs-mobile v18)     │
│  └─ WebView 加载 http://127.0.0.1:45231/    │
│       └─ LPL 前端 (HTML/CSS/JS)             │
└─────────────────────────────────────────────┘
        │
        ▼
   server.js (Node 本地 HTTP 服务)
        ├─ 静态资源 (public/)
        ├─ JSON API (赛程/积分榜/对阵图/详情)
        └─ 腾讯官方接口代理（服务端请求，无跨域）
```

- **Node**：nodejs-mobile [v18.20.4](https://github.com/nodejs-mobile/nodejs-mobile/releases/tag/v18.20.4)（Node 18，内置 fetch）
- **Engine 桥**：JNI `node::Start` 启动，`native-lib.cpp` 承担
- **前端**：原生 HTML/CSS/JS 单页应用，深色主题

---

## 📁 目录结构

```
lol-app/
├── build.gradle / settings.gradle / gradle.properties
└── app/
    ├── build.gradle            # AGP 8.7.3 · compileSdk 35 · NDK 21
    └── src/main/
        ├── AndroidManifest.xml
        ├── CMakeLists.txt      # 导入 libnode + 构建 native-lib
        ├── cpp/native-lib.cpp  # emutls 完整实现 + JNI 启动 Node 桥
        ├── java/com/lplsched/app/MainActivity.java
        ├── assets/nodejs-project/
        │   ├── server.js       # LPL 本地 HTTP 服务
        │   └── lib/            # 腾讯数据源封装
        │   └── public/         # 前端 (index.html / app.js / style.css)
        └── libnode/            # nodejs-mobile 预编译二进制 (arm64/x86_64 + include)
```

---

## 📦 APK 产物

应用名为 **LPL赛程**。

| 类型 | 文件 | 说明 |
| --- | --- | --- |
| 正式版 | `lol-app/app/build/outputs/apk/release/LPL赛程-release.apk` | release 签名包，建议直接安装（约 32 MB） |
| 调试版 | `lol-app/app/build/outputs/apk/debug/LPL赛程-debug.apk` | debug 包，含调试符号（约 68 MB） |

> 重新出包：在 `lol-app/` 下执行 `.\gradlew assembleRelease`（正式版）或 `.\gradlew assembleDebug`（调试版），产物输出到 `app/build/outputs/apk/`。

---

## 🌐 Web 版

仓库同时包含独立的 **Web 版**（`web/`），用于在电脑浏览器运行，也可作为 Android 版前端的开发源头。

```bash
cd web
node server.js        # 需 Node ≥ 18，零依赖
# 浏览器访问 http://127.0.0.1:45231
```

- 与 Android 版共用同一套前端（`web/public/`）与数据源封装（`web/lib/`），功能一致（含按战队筛选、对阵图、积分榜、比赛详情等）
- 数据由本地 Node 请求腾讯官方赛事接口
- 发布资产：GitHub Release 中的 `LPL-schedule-web-v1.1.0.zip` 即该 Web 版源码包

---

## 📜 说明

- 数据由设备上 Node 请求腾讯官方赛事接口（`apps.game.qq.com` / `open.tjstats.com` / Riot DDragon 等），WebView 不跨域
- 缓存写应用私有目录，重启不丢
- 本仓库软件以 [MIT](LICENSE) 许可开源；内置的 [nodejs-mobile](https://nodejs-mobile.github.io/) 与 [nodejs/node](https://github.com/nodejs/node) 遵循其各自许可

---

## ⚠️ 免责声明

- **仅限学习交流**：本项目仅供学习、研究与技术交流使用，不用于任何商业用途。
- **数据 / 素材版权**：赛事数据（赛程、比分、积分、选手数据）、队徽、英雄头像/图标、装备图标等均来自腾讯官方赛事接口（`apps.game.qq.com`、`open.tjstats.com`、`lpl.qq.com`）与 Riot Games（Data Dragon 等），其版权与商标归 **腾讯、Riot Games 及相应权利人** 所有，本项目不拥有上述数据/素材的任何权利。
- **非官方**：本项目与腾讯、Riot Games、LPL 及相关赛事组织 **无任何隶属、合作或背书关系**；相关名称与标识为其权利人商标，本项目仅用于技术演示，不暗示任何官方授权。
- **接口风险**：项目通过 HTTP 请求第三方接口获取数据，未获这些接口的正式授权；接口可用性、数据准确性、完整性与及时性均 **不作保证**，且可能随时变更或关闭，请自行评估并承担相应风险。
- **合规使用**：使用本项目（含所获数据）时请遵守当地法律法规及相关平台服务条款，**禁止商用、再分发或用于任何侵权 / 不当用途**。因使用本项目产生的任何直接或间接损失，作者不承担法律责任。
- **侵权处理**：如相关权利方认为本项目存在任何侵权内容，请联系作者，我们将及时核对并移除相关内容。
