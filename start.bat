@echo off
REM ============================================================
REM  Run the app locally on http://localhost:3000
REM  ASCII only in this file.
REM
REM  NOTE: the page talks to the REAL cloud service (the endpoint is
REM  hardcoded in build/app.js). Edits you make locally WILL be
REM  written to the live database. See docs/API.md section 7.
REM ============================================================
setlocal
cd /d "%~dp0"

set PY=python
where python >nul 2>nul
if errorlevel 1 (
  echo [ERROR] python not found in PATH.
  exit /b 1
)

if not exist "dist\index.html" (
  echo [ERROR] dist\index.html is missing. Run build.bat first.
  exit /b 1
)

echo Serving dist\ on http://localhost:3000  (Ctrl+C to stop)
echo.
%PY% dist\server.py
