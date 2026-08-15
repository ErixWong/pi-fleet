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
"%PI_CMD%" -p -a "Call whoami to identify yourself. Then check task(list,scope=pool) for public tasks and task(list,scope=due) for due tasks. IMPORTANT: a due task whose status is 'claimed' means your previous submission was REJECTED by review and needs rework — call task(detail) to read the rejection reasons, fix them, then resubmit (you are allowed to submit again while the task is claimed). For each task you work on: right after claiming, call task(reply) with a brief note like 'received, starting work'; complete it (use task(detail) for full context); BEFORE calling task(submit), call task(reply) once more introducing your deliverable (short summary + honest thoughts/journey: what you tried, obstacles, what you learned); then call task(submit). If there is nothing to do, reply 'none' and exit."

exit /b %ERRORLEVEL%
