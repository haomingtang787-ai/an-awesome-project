# 桌面「诗窗」启动脚本：优先打开打包好的 exe，其次 Electron 开发窗口。

$ErrorActionPreference = "Stop"
$project = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $project

function Show-ShichuangError([string]$message) {
  Add-Type -AssemblyName System.Windows.Forms
  [System.Windows.Forms.MessageBox]::Show($message, [string]([char]0x8BD7) + [char]0x7A97) | Out-Null
}

$exeCandidates = @(
  (Join-Path $project "dist\诗窗.exe"),
  (Join-Path $project "dist\诗窗 1.0.0.exe")
)
foreach ($exe in $exeCandidates) {
  if (Test-Path -LiteralPath $exe) {
    Start-Process -FilePath $exe
    exit 0
  }
}

$npm = Get-Command npm -ErrorAction SilentlyContinue
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $npm -or -not $node) {
  Show-ShichuangError "未找到打包好的 诗窗.exe，也未找到 Node.js。请先运行 npm run build:exe，或安装 Node.js 18+。"
  exit 1
}

if (-not (Test-Path -LiteralPath (Join-Path $project "node_modules\electron"))) {
  Show-ShichuangError "尚未安装桌面依赖。请在项目目录运行：npm install"
  exit 1
}

Start-Process -FilePath $npm.Source -ArgumentList @("run", "desktop") -WorkingDirectory $project -WindowStyle Hidden
exit 0
