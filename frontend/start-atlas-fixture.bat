@echo off
REM Opens Agents Factory Atlas on the local development fixture.
REM No controller, no provider, no account: every identity in that window is
REM synthetic, and the window says so in its title and its banner.
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo Dependencies are missing. Run: npm install
  pause
  exit /b 1
)
call npm run dev
