@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

rem ---- Locate node.exe ----
rem Double-click starts a clean cmd whose PATH usually lacks WorkBuddy's Node,
rem so probe known locations before falling back to PATH.
set "NODE_EXE="
if exist "%USERPROFILE%\.workbuddy\binaries\node\versions" (
  for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
  )
)
if not defined NODE_EXE (
  for /f "delims=" %%N in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%N"
)
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE (
  for /d %%D in ("%APPDATA%\nvm\v*") do if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
)

if not defined NODE_EXE (
  echo.
  echo [ERROR] node.exe not found.
  echo Please install Node.js 18 or newer from https://nodejs.org/
  echo Then double-click this file again. If Node is already installed in a
  echo custom folder, add: set "NODE_EXE=D:\path\to\node.exe"  below "cd /d".
  echo.
  pause
  exit /b 1
)

echo Using Node: %NODE_EXE%
"%NODE_EXE%" --version
echo Starting local Luogu paper console...
echo Working dir: %CD%
where curl >nul 2>&1
if errorlevel 1 echo [WARN] curl.exe not found - all problems come from Luogu online, generation will fail.
echo.

rem Double-click = open browser; passing arguments = use them as-is (e.g. --port 9000 --open)
set "ARGS=--open"
if not "%~1"=="" set "ARGS=%*"
"%NODE_EXE%" server.js %ARGS%

echo.
echo Server stopped.
pause
