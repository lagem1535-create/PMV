@echo off
setlocal
cd /d "%~dp0"
title PALmonitor Remote
echo ================================================
echo   PALmonitor Remote - turning on
echo ================================================
echo.

set "PY="
python --version >nul 2>&1 && set "PY=python"
if not defined PY (
  py --version >nul 2>&1 && set "PY=py"
)
if not defined PY (
  echo [ERROR] Python not found.
  echo Install Python from https://www.python.org/downloads/
  echo and CHECK "Add python.exe to PATH" during setup, then run this again.
  echo.
  pause
  exit /b
)
echo Python OK: %PY%
echo.

echo [1/3] Updating relay from GitHub...
curl -L -s -o relay_agent.py https://raw.githubusercontent.com/lagem1535-create/PMV/main/PALmonitor_web/relay_agent.py
if errorlevel 1 echo    (could not update - using local copy)
echo.

echo [2/3] Installing websockets (first time can take ~30 seconds)...
%PY% -m pip install --user --disable-pip-version-check websockets pynput
if errorlevel 1 (
  echo    retry without --user ...
  %PY% -m pip install --disable-pip-version-check websockets pynput
)
echo.

echo [3/3] Registering auto-start and connecting...
%PY% relay_agent.py --install
echo.
echo ================================================
echo   DONE! Open the phone app and just log in.
echo   This PC will auto-connect every time it boots.
echo ================================================
echo.
pause
