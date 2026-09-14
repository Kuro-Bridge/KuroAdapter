@echo off
rem Forward a server-console command and echo the response (impl: paper-cmd.ps1;
rem .cmd wrapper sidesteps PowerShell execution policy)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paper-cmd.ps1" %*
