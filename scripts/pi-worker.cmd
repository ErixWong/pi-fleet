@echo off
REM ============================================================
REM Pi Agent Worker (Mode A: pure MCP, no alarm script / no env key)
REM Scheduled by Windows Task Scheduler; agent key lives in
REM ~/.pi/agent/mcp.json (bearerToken). Each run costs one LLM call.
REM ============================================================

REM Make sure pi finds the user config (%USERPROFILE% -> ~/.pi)
set HOME=%USERPROFILE%
set USERPROFILE=%USERPROFILE%

REM Task Scheduler PATH has no npm global dir; call pi by full path
set PI_CMD=%APPDATA%\npm\pi.cmd
if not exist "%PI_CMD%" set PI_CMD=pi

REM Guidance: identify -> browse pool/due -> claim & reply -> work -> reply intro -> submit
"%PI_CMD%" -p -a "Call whoami to identify yourself. Then check task(list,scope=pool) for public tasks and task(list,scope=due) for due tasks. For each suitable task you claim: right after claiming, call task(reply) with a brief note like 'received, starting work'. Then complete the task (use task(detail) for full context). BEFORE calling task(submit), call task(reply) once more to introduce your deliverable: a short summary of what you produced, plus your honest thoughts and journey (what you tried, obstacles hit, what you learned). Then call task(submit) to hand it in. If there is nothing to do, reply 'none' and exit."

exit /b %ERRORLEVEL%
