@echo off
chcp 65001 >nul
cd /d "%~dp0"
title PALmonitor 원격 켜기

echo ================================================
echo   PALmonitor 원격 켜기
echo ================================================
echo.
echo 파이썬/필요한 것 확인 중...

where python >nul 2>&1
if %errorlevel%==0 (set PY=python) else (set PY=py)

%PY% --version >nul 2>&1
if %errorlevel% NEQ 0 (
  echo [오류] 파이썬이 설치되어 있지 않습니다.
  echo   https://www.python.org/downloads/ 에서 설치 후, 설치 중
  echo   "Add Python to PATH" 를 꼭 체크하세요. 그 다음 이 파일을 다시 더블클릭.
  echo.
  pause
  exit /b
)

echo 연결 모듈 준비 중(처음 한 번만 조금 걸립니다)...
%PY% -m pip install --quiet --disable-pip-version-check websockets >nul 2>&1

echo 자동 연결 등록 중...
%PY% relay_agent.py --install

echo.
echo ================================================
echo   완료! 이제 폰 앱에서 "로그인"만 하면 자동 연결됩니다.
echo   이 PC는 앞으로 켤 때마다 자동으로 실행됩니다.
echo   (이 창은 닫아도 됩니다)
echo ================================================
echo.
pause
