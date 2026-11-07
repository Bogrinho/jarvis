@echo off
rem Sends one test notification from Jarvis (double-click this file).
node "%~dp0test-notify.js"
echo Sent a test notification. Look at the bottom right of the screen.
timeout /t 5 >nul
