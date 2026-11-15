@echo off
rem Resolve the host-designated Node and run it (Windows).
rem
rem Why not a bare `node`: WorkBuddy does NOT put its managed Node on PATH.
rem It exports the containing directory through WORKBUDDY_EXTRA_PATHS
rem (';'-separated), so `node %*` fails with "not recognized" and the MCP
rem server never starts. Trust the host's answer first, fall back to PATH,
rem else fail loudly. Do NOT guess the host's internal layout.
rem
rem Keep this file ASCII-only: cmd.exe parses it in the system ANSI codepage,
rem so non-ASCII comments turn into garbage commands.
setlocal
set "NODE_BIN="

rem 1. WORKBUDDY_EXTRA_PATHS: ';'-separated dirs that directly contain node.exe
if defined WORKBUDDY_EXTRA_PATHS (
  for %%D in ("%WORKBUDDY_EXTRA_PATHS:;=" "%") do (
    if not defined NODE_BIN if exist "%%~D\node.exe" set "NODE_BIN=%%~D\node.exe"
  )
)

rem 2. PATH fallback
if not defined NODE_BIN (
  for %%N in (node.exe) do if not defined NODE_BIN if not "%%~$PATH:N"=="" set "NODE_BIN=%%~$PATH:N"
)

if not defined NODE_BIN (
  echo [gcwork] FATAL: cannot locate node ^(checked WORKBUDDY_EXTRA_PATHS and PATH^) 1>&2
  exit /b 127
)

"%NODE_BIN%" %*
exit /b %ERRORLEVEL%
