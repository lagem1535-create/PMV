@echo off
setlocal
cd /d "%~dp0"
title PALmonitor Remote

echo ================================================
echo   PALmonitor Remote - turning on
echo ================================================
echo.

where python >/dev/null 2>&1
if %errorlevel%==0 (set PY=python) else (set PY=py)
%PY% --version >/dev/null 2>&1
if %errorlevel% NEQ 0 (
  echo [ERROR] Python is not installed.
  echo   Install from https://www.python.org/downloads/ and
  echo   CHECK "Add Python to PATH" during install, then double-click again.
  echo.
  pause
  exit /b
)

echo Updating relay from GitHub (latest)...
where curl >/dev/null 2>&1 && curl -L -s -o relay_agent.py https://raw.githubusercontent.com/lagem1535-create/PMV/main/PALmonitor_web/relay_agent.py

echo Preparing connection module (first time only)...
%PY% -m pip install --quiet --disable-pip-version-check websockets >/dev/null 2>&1

echo Registering auto-start and connecting...
%PY% relay_agent.py --install

echo.
echo ================================================
echo   DONE! On your phone app, just log in.
echo   This PC will auto-connect every time it boots.
echo   (You can close this window.)
echo ================================================
echo.
pause
