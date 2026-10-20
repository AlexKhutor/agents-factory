@echo off
REM PROTOTYPE. Opens Agents Factory Atlas on the local Paperclip server named in
REM config\paperclip.json. It does not start Paperclip: if the server is not
REM running, the window says so. Start it with ..\paperclip-runtime\start-paperclip.bat
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Dependencies are missing. Run: npm install
  pause
  exit /b 1
)
if not exist "config\paperclip.json" (
  echo config\paperclip.json is missing: it names the Paperclip API address and the company.
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" . --paperclip
