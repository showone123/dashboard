@echo off
REM ============================================================
REM  Build + verify. ASCII only in this file (Chinese text in a
REM  .bat gets mangled before chcp takes effect).
REM
REM  This simply runs verify.py, which does:
REM    env check -> deps check -> rebuild -> artifact check
REM    -> static checks -> CONTRACT checks -> dist sync check
REM
REM  Exit code 0 = safe to deploy. 1 = do NOT deploy.
REM ============================================================
setlocal
cd /d "%~dp0"

set PY=python
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  echo         Install Python 3.8+ and make sure "python" is on PATH.
  exit /b 1
)

echo Running verify.py ...
echo.
%PY% verify.py
set RC=%ERRORLEVEL%
echo.
if %RC% NEQ 0 (
  echo [FAILED] verify.py returned %RC%. Do NOT deploy.
  echo          Fix the failures above, then run this script again.
  exit /b %RC%
)

echo [OK] All checks passed. dist\index.html is in sync.
echo      Next: ask WorkBuddy to "cover deploy" the dist\ directory.
exit /b 0
