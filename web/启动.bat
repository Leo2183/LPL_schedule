@echo off
title LOL 赛事中心 - LPL 赛程查询
cd /d "%~dp0"

set PORT=45231

echo.
echo  ============================================
echo     LOL 赛事中心 - LPL 赛程查询
echo     端口: %PORT%    目录: %~dp0
echo  ============================================
echo.

rem ---- 检查 Node.js ----
where node >nul 2>nul
if errorlevel 1 (
  echo  [错误] 未检测到 Node.js，请先安装 Node.js 18 或更高版本
  echo  下载地址: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem ---- 检查端口是否已被占用（服务可能已在运行）----
rem 注意：findstr 的空格会把正则拆成多个搜索词，必须先过滤 LISTENING 再找端口
netstat -ano | findstr "LISTENING" | findstr "45231" >nul 2>nul
if not errorlevel 1 (
  echo  [提示] 服务已在运行，直接打开浏览器访问 http://127.0.0.1:45231
  start "" http://127.0.0.1:45231
  echo.
  pause
  exit /b 0
)

echo  正在启动服务，稍后自动打开浏览器...
echo  如果浏览器未自动打开，请手动访问 http://127.0.0.1:45231
echo  按 Ctrl+C 可停止服务
echo.

rem ---- 延迟 2 秒后打开浏览器（等服务起来）----
start "" cmd /c "timeout /t 2 /nobreak >nul & start http://127.0.0.1:45231"

rem ---- 启动服务 ----
node server.js

echo.
echo  服务已停止。
pause
