@echo off
setlocal
"%SystemRoot%\System32\schtasks.exe" /query /tn "\CodexDingTalkBridge" >nul
if errorlevel 1 (
  echo Failed to query bridge scheduled task. See Windows error above.
  exit /b 1
)
"%SystemRoot%\System32\schtasks.exe" /end /tn "\CodexDingTalkBridge"
"%SystemRoot%\System32\schtasks.exe" /run /tn "\CodexDingTalkBridge"
exit /b %errorlevel%
