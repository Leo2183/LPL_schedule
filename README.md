# LOL 赛事中心 · LPL 赛程 Android App

把 **LPL 赛程网页程序**（零依赖 Node.js + 原生 HTML/CSS/JS 前端）打包成 **Android APK** 的套壳方案：**nodejs-mobile（手机本地跑 Node 服务）+ WebView（渲染前端页面）**。

> 数据来源：腾讯官方赛事接口 · 仅供学习交流

---

## ✨ 功能特性

- **LPL 赛程**：三赛段赛程、按日期浏览、比赛状态（未开始/进行中/已结束）筛选
- **对阵图**：赛季结构 / 分路 / 季后赛树状对阵
- **积分榜**：按赛段 + 组别分组，组内按积分排序
- **比赛二级详情页**：选手数据（KDA / 参团率 / 伤害 / 分均 / 经济 / 补刀 / 视野 / 等级 / 装备）
- **英雄图标 / 队徽 / 装备图标**，加载失败自动回退文字徽标
- **磁盘缓存 + 动态刷新**（有比赛时 60s 自动刷新，无比赛 1h）
- **无 LCK、无评分**（功能边界按需求确定）

---

## 🏗️ 技术方案

```
┌─────────────────────────────────────────────┐
│  MainActivity (Android)                     │
│  ├─ 启动 Node 线程 (native-lib.cpp → node)  │
│  │    └─ libnode.so (nodejs-mobile v18)     │
│  └─ WebView 加载 http://127.0.0.1:45231/    │
│       └─ LOL 前端 (HTML/CSS/JS)             │
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
        │   ├── server.js       # LOL 本地 HTTP 服务
        │   └── lib/            # 腾讯数据源封装
        │   └── public/         # 前端 (index.html / app.js / style.css)
        └── libnode/            # nodejs-mobile 预编译二进制 (arm64/x86_64 + include)
```

---

## ✅ 已验证（Xiaomi · Android 16 真机）

- [x] Node 服务启动：赛程 232 场 / 赛季结构 3 赛段 / 积分榜，接口全部 HTTP 200
- [x] WebView 渲染完整：赛程、对阵图、积分榜、详情页（含真实比分）
- [x] 顶部状态栏沉浸式适配
- [x] 详情页表格横向滚动 + 左侧两列固定
- [x] 日期选择器、刷新、自动刷新

---

## 📜 说明

- 服务端数据全部由 device 上 Node 请求腾讯接口（`apps.game.qq.com` / `open.tjstats.com` / Riot DDragon 等），WebView 不跨域
- 缓存写应用私有目录，重启不丢
- 遵循 [nodejs-mobile](https://nodejs-mobile.github.io/) 与 [nodejs/node](https://github.com/nodejs/node) 许可
