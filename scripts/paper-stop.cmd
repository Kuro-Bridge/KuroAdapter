@echo off
rem Stop sandbox Paper via paper-stop.sh (locate Git Bash explicitly; plain "bash"
rem in PowerShell resolves to WSL, which breaks MSYS-only syntax like taskkill //F)
set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH_EXE%" set "BASH_EXE=C:\Program Files\Git\usr\bin\bash.exe"
if not exist "%BASH_EXE%" (
    echo Git Bash not found; run manually: bash scripts/paper-stop.sh
    exit /b 1
)
"%BASH_EXE%" "%~dp0paper-stop.sh"
