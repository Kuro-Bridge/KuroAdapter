@echo off
rem Sandbox Paper single entry (subcommands start|stop|cmd|qr; routing lives in
rem paper.ps1). This trampoline only sidesteps PowerShell execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paper.ps1" %*
