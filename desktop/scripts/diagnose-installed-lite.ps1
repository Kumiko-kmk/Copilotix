$ErrorActionPreference = 'Stop'
if ($env:GITHUB_ACTIONS -ne 'true') { throw 'This diagnostic runs only in a fresh GitHub runner' }
$root = Join-Path $env:RUNNER_TEMP ('lite-renderer-' + [guid]::NewGuid().ToString('N'))
$evidence = Join-Path (Get-Location) 'diagnostic-evidence'
New-Item -ItemType Directory -Path $root,$evidence | Out-Null
$manifest = Get-Content diagnostic-input/advanced/release-manifest.json -Raw | ConvertFrom-Json
if ((Get-FileHash diagnostic-input/setup.exe).Hash -ne $manifest.installer.sha256) { throw 'Downloaded hash mismatch' }
& 7z x diagnostic-input/setup.exe "-o$root/extracted" '-y' '$PLUGINSDIR/app-64.7z' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Setup extraction failed' }
& 7z x "$root/extracted/`$PLUGINSDIR/app-64.7z" "-o$root/runtime" '-y' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Runtime extraction failed' }
$application = Join-Path $root 'runtime/CopilotixLite.exe'
if ((Get-FileHash $application).Hash -ne $manifest.runtime.sha256) { throw 'Runtime hash mismatch' }
Get-Acl (Join-Path $root 'runtime') | Format-List * | Out-File "$evidence/acl-before.txt"
$results = @()
foreach ($case in @('default','zh-CN-language')) {
    $caseRoot = Join-Path $evidence $case
    New-Item -ItemType Directory -Path $caseRoot | Out-Null
    $profile = Join-Path $root "profile-$case"
    $env:NODE_ENV = 'test'
    $env:COPILOTIX_E2E_USER_DATA = $profile
    if ($case -eq 'install-folder-read') {
        & icacls (Join-Path $root 'runtime') /grant '*S-1-15-2-1:(OI)(CI)(RX)' | Out-File "$caseRoot/acl-change.txt"
        if ($LASTEXITCODE -ne 0) { throw 'Diagnostic directory read grant failed' }
    }
    $arguments = @('--remote-debugging-port=0','--remote-debugging-address=127.0.0.1','--enable-logging=stderr','--v=1')
    if ($case -eq 'zh-CN-language') { $arguments += '--lang=zh-CN' }
    if ($case -eq 'gpu-only') { $arguments += '--disable-gpu-sandbox' }
    if ($case -eq 'no-sandbox-diagnostic') { $arguments += '--no-sandbox' }
    $app = Start-Process -FilePath $application -ArgumentList $arguments -WindowStyle Hidden -PassThru -RedirectStandardError "$caseRoot/chromium.log" -RedirectStandardOutput "$caseRoot/stdout.log"
    try {
        & node desktop/scripts/installer-lite-ui.mjs $profile $caseRoot 2>&1 | Out-File "$caseRoot/check.log"
        $results += [pscustomobject]@{ case = $case; exitCode = $LASTEXITCODE }
    } finally {
        $app.Refresh()
        if (-not $app.HasExited) { & taskkill /PID $app.Id /T /F | Out-Null }
    }
}
$results | ConvertTo-Json | Set-Content "$evidence/results.json"
$results | Format-Table
