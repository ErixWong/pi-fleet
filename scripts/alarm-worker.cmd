@echo off
REM Pi Agent alarm worker (Mode B, scheduled by Task Scheduler)
REM Zero-token probe: heartbeat + poll + pool list; spawns pi only when work exists.
REM Key read from ~/.pi/agent/mcp.json (task-dispatch bearerToken) - no env var needed.
set HOME=%USERPROFILE%
set USERPROFILE=%USERPROFILE%
cd /d D:\projects\temp\pi-agent-install
node scripts\local-alarm.mjs >> work\alarm-worker.log 2>&1
REM node 24 exits with a libuv assertion (src\win\async.c, undici cleanup) on Windows;
REM actual work (heartbeat/poll/result) is already done via API, so force success; errors stay in the log.
exit /b 0
