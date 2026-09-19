# 一键扫码：发送 kurobridge qr → 回显状态（含"距今 N 秒前"可判断是否过期）→ 自动用
# 系统看图器打开二维码图片，手机 QQ 直接扫。用法：toolings\paper\paper.cmd qr
$ErrorActionPreference = "Stop"

$output = & "$PSScriptRoot\paper-cmd.ps1" kurobridge qr
$output | Write-Output

$png = Join-Path $PSScriptRoot "..\..\sandbox\server\plugins\kurobridge\qr.png"
if (Test-Path $png) {
    # 服务器重启后 / napuketto 未到扫码阶段时，磁盘上可能是上一轮的过期残留图——拒开防误导
    $ageMinutes = ((Get-Date) - (Get-Item $png).LastWriteTime).TotalMinutes
    if ($ageMinutes -gt 3) {
        Write-Output "（qr.png 是 $([int]$ageMinutes) 分钟前的残留图，未打开：napuketto 还没生成新码，等 30~60 秒重跑本命令）"
    } else {
        Start-Process (Resolve-Path $png).Path | Out-Null
        Write-Output "（已用系统默认看图器打开二维码图片；服务器约 2 分钟自动换码，提示过期就重跑本命令）"
    }
} else {
    Write-Output "（qr.png 尚未生成：napuketto 还没到扫码阶段？以日志为准）"
}
