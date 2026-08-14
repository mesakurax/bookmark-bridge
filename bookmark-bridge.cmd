@echo off
setlocal
node --no-warnings "%~dp0bookmark-bridge.js" %*
exit /b %errorlevel%
