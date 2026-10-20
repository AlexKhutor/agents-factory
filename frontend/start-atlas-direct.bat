@echo off
REM PROTOTYPE. Opens Agents Factory Atlas working with Claude Code directly: no server
REM to start. By default the data lives in direct-data\ and the Claude agent SDK
REM comes from node_modules (npm ci); config\direct.local.json can name other folders.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run: npm ci
  pause
  exit /b 1
)
if not exist "config\direct.json" (
  echo config\direct.json is missing: it holds how agents are started.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" . --direct
