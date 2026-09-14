# 向沙盒 Paper 控制台转发命令并回显响应（PowerShell 原生，无 Git Bash / WSL 歧义）。
# 用法：scripts\paper-cmd.cmd kurobot qr
#   或  powershell -NoProfile -File scripts\paper-cmd.ps1 kurobot qr
# 机制与 paper-start.sh 的 stdin 注入形态一致：命令行追加进 cmd.in（tail -f 供给
# java stdin），然后从 console.log 的旧末尾偏移轮询读取增量即命令响应。
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)]
    [string[]]$Command
)
$ErrorActionPreference = "Stop"

$server = Join-Path $PSScriptRoot "..\sandbox\server"
$cmdIn = Join-Path $server "cmd.in"
$log = Join-Path $server "console.log"
if (-not (Test-Path $cmdIn)) { throw "缺少 $cmdIn（服务器未启动？先运行 scripts\paper-start.cmd）" }
if (-not (Test-Path $log)) { throw "缺少 $log" }

$before = (Get-Item $log).Length
# UTF-8 无 BOM（控制台读行；ASCII 命令亦兼容）
[IO.File]::AppendAllText($cmdIn, ($Command -join " ") + "`n", (New-Object System.Text.UTF8Encoding($false)))

# 轮询等待新日志（最多 8s；命令响应是异步落日志的）
$deadline = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if ((Get-Item $log).Length -gt $before) { break }
}
$after = (Get-Item $log).Length
if ($after -le $before) {
    Write-Output "（8 秒内 console.log 无新输出：服务器可能还在启动中，或命令无即时响应）"
    return
}

# java 侧持有写句柄，必须以 ReadWrite 共享打开
$fs = [IO.File]::Open($log, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
$reader = $null
try {
    $fs.Seek($before, [IO.SeekOrigin]::Begin) | Out-Null
    $reader = New-Object IO.StreamReader($fs, [Text.Encoding]::UTF8)
    $reader.ReadToEnd() | Write-Output
} finally {
    if ($reader) { $reader.Dispose() } else { $fs.Dispose() }
}
