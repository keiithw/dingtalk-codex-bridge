param(
    [Parameter(Mandatory=$true)][string]$Workspace,
    [string]$CodexExe = ''
)
$ErrorActionPreference = 'Stop'
$project = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$workspacePath = (Resolve-Path -LiteralPath $Workspace).Path
if (-not (Test-Path -LiteralPath $workspacePath -PathType Container)) { throw 'Workspace must be an existing directory.' }
$node = Get-Command node.exe -ErrorAction Stop
$npm = Get-Command npm.cmd -ErrorAction Stop
if (-not $CodexExe) {
    $found = Get-Command codex.exe -ErrorAction SilentlyContinue
    if ($found) { $CodexExe = $found.Source }
    else {
        $bundles = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
        $candidate = Get-ChildItem -Path $bundles -Filter codex.exe -Recurse -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($candidate) { $CodexExe = $candidate.FullName }
    }
}
if (-not $CodexExe -or -not (Test-Path -LiteralPath $CodexExe -PathType Leaf) -or [IO.Path]::GetExtension($CodexExe) -ne '.exe') { throw 'Codex executable not found. Pass -CodexExe with the full path to codex.exe.' }
& $CodexExe app-server --help | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Codex app-server check failed. Fix Codex configuration/login first.' }
$dataDir = Join-Path $env:LOCALAPPDATA 'DingTalkCodexBridge'
$config = Join-Path $dataDir 'bridge-config.json'
if (Test-Path -LiteralPath $config) { throw 'Existing bridge configuration found. Setup will not overwrite it.' }
if (-not (Test-Path -LiteralPath $dataDir)) {
    New-Item -ItemType Directory -Path $dataDir | Out-Null
    $account = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    & "$env:SystemRoot\System32\icacls.exe" $dataDir /inheritance:r /grant:r "${account}:(OI)(CI)F" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Unable to secure the data directory.' }
}
Push-Location $project
try { & $npm.Source ci; if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' } } finally { Pop-Location }
$bytes = New-Object byte[] 16
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$pairCode = ([BitConverter]::ToString($bytes)).Replace('-','').ToLowerInvariant()
$settings = [ordered]@{clientId='';clientSecret='';pairCode=$pairCode;codexExe=(Resolve-Path -LiteralPath $CodexExe).Path;cwd=$workspacePath;writableRoots=@()}
$json = $settings | ConvertTo-Json -Depth 5
[IO.File]::WriteAllText($config, $json, (New-Object System.Text.UTF8Encoding($false)))
$state = [ordered]@{owner=$null;threads=@{};seen=@();groups=@{}} | ConvertTo-Json -Depth 5
$assistants = [ordered]@{assistants=@()} | ConvertTo-Json -Depth 5
$mentionGroups = @() | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $dataDir 'bridge-state.json'), $state, (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $dataDir 'external-assistants.json'), $assistants, (New-Object System.Text.UTF8Encoding($false)))
[IO.File]::WriteAllText((Join-Path $dataDir 'robot-mentions-groups.json'), $mentionGroups, (New-Object System.Text.UTF8Encoding($false)))
Write-Output 'Setup complete. Open scripts\open-console.cmd and configure your robot in the settings dialog.'
Write-Output ('Private pairing code: ' + $pairCode)
Write-Output 'Pairing code is also stored in your protected local configuration. Do not share it publicly.'
Write-Output 'After saving the robot configuration, start the bridge in the foreground with scripts\start-foreground.ps1.'
