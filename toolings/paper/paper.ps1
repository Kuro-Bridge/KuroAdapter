# 沙盒 Paper 单一入口：start|stop|cmd|qr 四个子命令的路由层（原 paper-start|stop|cmd|qr.cmd
# 四个壳合一，样板只写一次）。
# 用法（仓库任意位置）：toolings\paper\paper.cmd <子命令> [参数...]
#   start            启动沙盒 Paper（实现在 paper-start.sh）
#   stop             优雅停服，120s 超时强杀（实现在 paper-stop.sh）
#   cmd <命令...>    转发控制台命令并回显响应（实现在 paper-cmd.ps1）
#   qr               一键扫码登录（实现在 paper-qr.ps1）
#
# 路由原则（运行时差异，不是历史偶然）：
#   start|stop → Git Bash：stdin 注入（tail -f cmd.in）与 taskkill //F 是 MSYS 语义；
#                PATH 里的裸 "bash" 可能解析到 WSL（缺 mise、无 /proc winpid），故显式
#                定位 Git 安装路径下的 bash.exe。
#   cmd|qr     → PowerShell 同进程调用：日志偏移轮询读增量是 .NET 原生形态。
param(
    [Parameter(Position = 0)]
    [string]$Action,
    [Parameter(Position = 1, ValueFromRemainingArguments = $true)]
    [string[]]$Rest
)
$ErrorActionPreference = "Stop"

$usage = @"
用法：toolings\paper\paper.cmd <start|stop|cmd|qr> [参数...]
  start          启动沙盒 Paper（paper-start.sh，经 Git Bash）
  stop           优雅停服（paper-stop.sh，经 Git Bash）
  cmd <命令...>  转发控制台命令并回显（paper-cmd.ps1）
  qr             一键扫码登录（paper-qr.ps1）
"@

switch ($Action) {
    "start" { $target = "paper-start.sh" }
    "stop" { $target = "paper-stop.sh" }
    "cmd" { $target = "paper-cmd.ps1" }
    "qr" { $target = "paper-qr.ps1" }
    default {
        # 无参数 / help 类 → 用法后干净退出；未知子命令 → 用法 + 非零退出
        $known = ($Action -eq "") -or ($Action -match "^(--?-?h(elp)?|help)$")
        if (-not $known) { Write-Output "[paper] 未知子命令：$Action" }
        Write-Output $usage
        exit $(if ($known) { 0 } else { 1 })
    }
}

if ($target -like "*.ps1") {
    & (Join-Path $PSScriptRoot $target) @Rest
    exit $LASTEXITCODE
}

# start|stop：显式定位 Git Bash（bin/bash.exe 优先，老版安装布局回退 usr/bin/bash.exe）
$bash = @(
    "$env:ProgramFiles\Git\bin\bash.exe",
    "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
    "$env:ProgramFiles\Git\usr\bin\bash.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $bash) {
    Write-Output "[paper] 未找到 Git Bash；请手动运行：bash toolings/paper/$target"
    exit 1
}
# Windows PowerShell 5.1 按控制台代码页（中文系统默认 GBK）解码原生子进程输出再转码，
# bash 的 UTF-8 中文由此乱码——脚本期内切 UTF-8 解码，finally 还原控制台原状。
# 已知边界：输出经管道重定向且无控制台句柄时 setter 失败（catch 放行），此场景下
# bash 子进程的中文会乱码；交互控制台（真实用法）不受影响。
$cp = $null
try { $cp = [Console]::OutputEncoding; [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
try {
    & $bash (Join-Path $PSScriptRoot $target) @Rest
    exit $LASTEXITCODE
} finally {
    if ($cp) { try { [Console]::OutputEncoding = $cp } catch {} }
}