param([string]$Config = (Join-Path $env:LOCALAPPDATA 'DingTalkCodexBridge\bridge-config.json'))
$ErrorActionPreference = 'Stop'
$bridge = Join-Path (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path 'bridge.cjs'
if (-not (Test-Path -LiteralPath $Config -PathType Leaf)) { throw 'Bridge configuration not found; run setup.ps1 first.' }
& node $bridge $Config
exit $LASTEXITCODE
