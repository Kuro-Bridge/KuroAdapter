@echo off
rem One-shot QR login: send "kurobot qr" + open qr.png in the default image viewer
rem (impl: paper-qr.ps1)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0paper-qr.ps1" %*
