@echo off
REM Opens Agents Factory Atlas against the controller named in config\local.json.
REM It starts no gateway: if none is ready, the window says so and why.
cd /d "%~dp0"
if not exist "node_modules\electron" (
  echo Dependencies are missing. Run: npm install
  pause
  exit /b 1
)
if not exist "config\local.json" (
  echo config\local.json is missing. Copy config\local.example.json and fill it in
  echo for this machine, or use start-atlas-fixture.bat to run without a controller.
  pause
  exit /b 1
)
call npm start
