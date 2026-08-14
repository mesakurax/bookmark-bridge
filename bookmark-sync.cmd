@echo off
setlocal
node --no-warnings "%~dp0bookmark-sync.js" %*
exit /b %errorlevel%
