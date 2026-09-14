@echo off
rem Start sandbox Paper via paper-start.sh (locate Git Bash explicitly; plain "bash"
rem in PowerShell resolves to WSL, which lacks mise and MSYS semantics)
set "BASH_EXE=C:\Program Files\Git\bin\bash.exe"
if not exist "%BASH_EXE%" set "BASH_EXE=C:\Program Files\Git\usr\bin\bash.exe"
if not exist "%BASH_EXE%" (
    echo Git Bash not found; run manually: bash scripts/paper-start.sh
    exit /b 1
)
"%BASH_EXE%" "%~dp0paper-start.sh"
