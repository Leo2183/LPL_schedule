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
