# Exercise only native uninstall UI and cancellation. Never confirm real data deletion.
[CmdletBinding()]
param([string]$ReleaseDirectory, [string]$EvidenceDirectory, [switch]$UiOnly, [switch]$InPlace)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ($UiOnly -and $InPlace) { throw 'Choose -UiOnly or -InPlace, not both' }
if (-not $ReleaseDirectory) { $ReleaseDirectory=Join-Path $PSScriptRoot '../../release' }
if (-not $EvidenceDirectory) { $EvidenceDirectory=Join-Path $PSScriptRoot '../test-artifacts/uninstaller-wizard' }
# Reuse only shared native-control definitions, never execute the install test.
$shared=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'test-installer-wizard.ps1') -Raw
$begin=$shared.IndexOf('Add-Type -AssemblyName System.Drawing')
$end=$shared.IndexOf('$release=[IO.Path]::GetFullPath($ReleaseDirectory)')
if ($begin -lt 0 -or $end -le $begin) { throw 'Wizard helpers were not found' }
Invoke-Expression $shared.Substring($begin,$end-$begin)
$release=[IO.Path]::GetFullPath($ReleaseDirectory)
$evidence=[IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$manifestPath=Join-Path $release 'advanced/release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { $manifestPath=Join-Path $release 'advanced/bundle-manifest.json' }
if (-not (Test-Path -LiteralPath $manifestPath)) { $manifestPath=Join-Path $release 'release-manifest.json' }
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$setup=Join-Path $release $manifest.installer.file
Assert-That ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.installer.sha256) 'Setup hash differs from release manifest'
if (-not $UiOnly -and -not $InPlace) {
foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    $existing=@(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*' })
    Assert-That ($existing.Count -eq 0) 'Existing installation: use a clean Windows account'
}
foreach ($path in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Copilotix.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'Copilotix.lnk'))) { Assert-That (-not (Test-Path -LiteralPath $path)) "Existing shortcut: $path" }
}
Assert-That (@(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -eq 0) 'Exit Copilotix before acceptance'
$userData=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Copilotix-Translation-v2'
function Get-DataSnapshot {
    if (-not (Test-Path -LiteralPath $userData)) { return 'absent' }
    # Hash persistent library/settings metadata; browser cache files can be
    # large and are unrelated to a cancelled cleanup preview. The read-only
    # preview may create SQLite's rebuildable -shm index and an empty -wal; both
    # hold no data, while any WAL content is still hashed.
    return (@(Get-ChildItem -LiteralPath $userData -File | Where-Object Name -Match '^(copilotix-|usage-analytics)' | Where-Object { $_.Name -notmatch '-shm$' -and -not ($_.Name -match '-wal$' -and $_.Length -eq 0) } | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" }) -join "`n")
}
function Get-RegistrySnapshot {
    # Values only: serializing the PSDrive/PSProvider members never finishes.
    return (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\14328922-5660-531d-8d5f-b169b5a958e0','HKCU:\Software\14328922-5660-531d-8d5f-b169b5a958e0' -ErrorAction SilentlyContinue | Select-Object * -ExcludeProperty PS* | ConvertTo-Json)
}
$before=Get-DataSnapshot
# The native dialog draws its text in a DirectUI control, readable only through
# UI Automation; window messages reach its buttons alone.
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
function Get-DialogText([IntPtr]$Window) {
    $elements=[System.Windows.Automation.AutomationElement]::FromHandle($Window).FindAll([System.Windows.Automation.TreeScope]::Descendants,[System.Windows.Automation.Condition]::TrueCondition)
    return (@($elements) | ForEach-Object { $_.Current.Name }) -join ' '
}
# The helper scans the real library before it asks, so its prompt can take a while.
$previewSeconds=180
function Test-ConfirmationButton($Controls) {
    return @($Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&','') -match '^(Permanently remove|永久移除)$' }).Count -eq 1
}
function Assert-ConfirmationText($Page) {
    $text=Get-DialogText $Page.Window
    Set-Content -LiteralPath (Join-Path $evidence '03-data-confirmation.txt') -Value $text -Encoding UTF8
    Assert-That ($text -match 'Permanently remove the following|永久移除以下') "Dialog is not the data confirmation: $text"
    Assert-That ($text.Contains($userData)) "Confirmation omits actual user data path: $text"
}
function Expand-Uninstaller([string]$Directory) {
    $extractor=Join-Path $env:ProgramFiles '7-Zip/7z.exe'
    Assert-That (Test-Path -LiteralPath $extractor) 'UI-only and in-place acceptance require full NSIS-capable 7-Zip'
    New-Item -ItemType Directory -Path $Directory -Force | Out-Null
    # The uninstaller sits under $R0; 7-Zip exits 0 when a pattern matches nothing.
    & $extractor e -tNsis $setup '*uninstall.exe' -r "-o$Directory" -y | Out-Null
    Assert-That (($LASTEXITCODE -eq 0) -and (Test-Path -LiteralPath (Join-Path $Directory 'uninstall.exe'))) 'Could not extract final uninstaller'
}
function Get-Runtime {
    $runtimeBase=if ($manifest.schemaVersion -ge 5) { Split-Path -Parent (Join-Path $release $manifest.runtimeArtifactDirectory) } elseif ($manifest.schemaVersion -ge 4) { $release } else { Join-Path $release $manifest.artifactDirectory }
    $runtime=[IO.Path]::GetFullPath((Join-Path $runtimeBase $manifest.runtime.entryPoint))
    Assert-That ((Get-FileHash -LiteralPath $runtime -Algorithm SHA256).Hash -eq $manifest.runtime.sha256) 'Developer runtime hash mismatch'
    return $runtime
}
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('copilotix-uninstall-wizard-'+[Guid]::NewGuid().ToString('N'))
$destination=Join-Path $testRoot '解除安裝 path\Copilotix'
$process=$null
$installed=$false
try {
    if ($UiOnly) {
        $registryBefore=Get-RegistrySnapshot
        Expand-Uninstaller $testRoot
        # Interactive UI is never started hidden: its windows would stay invisible to Wait-Page.
        $process=Start-Process -FilePath (Join-Path $testRoot 'uninstall.exe') -ArgumentList @("_?=$testRoot") -PassThru
        $welcome=Wait-Page { param($c) @($c | Where-Object { $_.Id -eq 1 -and $_.Class -eq 'Button' }).Count -eq 1 } 'extracted uninstall welcome' 20
        Click-Control $welcome 1
        $options=Wait-Page { param($c) @($c | Where-Object { $_.Class -eq 'Button' -and $_.Text -match 'Also remove|同时移除|同時移除' }).Count -eq 1 } 'extracted library/data option' 20
        $checkbox=($options.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text -match 'Also remove|同时移除|同時移除' }).Handle
        Assert-That ([WizardNative]::SendMessage($checkbox,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0) 'Data removal must default unchecked'
        Save-Page $options '02-options-default-unchecked'
        # Cancel before the uninstall section is ever entered. Existing install
        # registration may influence INSTDIR; do not click the uninstall button.
        Click-Control $options 2
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            foreach ($window in [WizardNative]::Windows($process.Id)) {
                foreach ($yes in @(Get-Controls $window | Where-Object { $_.Id -eq 6 -and $_.Class -eq 'Button' })) { [WizardNative]::PostMessage($yes.Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
            }
            Start-Sleep -Milliseconds 200; $process.Refresh()
        }
        Assert-That ($process.HasExited) 'Cancelled extracted UI did not exit'
        $process=Start-Process -FilePath (Get-Runtime) -ArgumentList @('--copilotix-uninstall-cleanup','--lang=1033') -PassThru
        $confirmation=Wait-Page { param($c) Test-ConfirmationButton $c } 'read-only helper confirmation' $previewSeconds
        Save-Page $confirmation '03-data-confirmation'
        Assert-ConfirmationText $confirmation
        $cancel=@($confirmation.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&','') -match '^Cancel$' })
        Assert-That ($cancel.Count -eq 1) 'Expected explicit cancel button'
        [WizardNative]::PostMessage($cancel[0].Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
        Assert-That ($process.WaitForExit(20000) -and $process.ExitCode -eq 2) 'Helper cancellation must exit 2'
        $registryAfter=Get-RegistrySnapshot
        Assert-That ($registryBefore -eq $registryAfter) 'UI-only acceptance changed existing installation registry'
        Assert-That ((Get-DataSnapshot) -eq $before) 'Read-only cancelled preview changed user data'
        Write-Host 'PASS: extracted final uninstall.exe option unchecked; direct packaged helper shows actual paths and Cancel exits2; existing installation registry and data unchanged'
        return
    }
    if ($InPlace) {
        # An unregistered copy beside the final uninstaller: the uninstall section
        # runs the helper before it touches files, shortcuts or registration, and
        # quits when the helper reports cancellation.
        $registryBefore=Get-RegistrySnapshot
        New-Item -ItemType Directory -Path $destination -Force | Out-Null
        Copy-Item -Path (Join-Path (Split-Path -Parent (Get-Runtime)) '*') -Destination $destination -Recurse
        Expand-Uninstaller $destination
    } else {
        $installer=Start-Process -FilePath $setup -ArgumentList @('/S','/currentuser',"/D=$destination") -WindowStyle Hidden -PassThru
        Assert-That ($installer.WaitForExit(120000)) 'Test installation timed out'
        Assert-That ($installer.ExitCode -eq 0) 'Test installation failed'
        $installed=$true
    }
    $app=Join-Path $destination 'Copilotix.exe'
    $uninstaller=Join-Path $destination 'uninstall.exe'
    Assert-That ((Test-Path -LiteralPath $app) -and (Test-Path -LiteralPath $uninstaller)) 'Installed executable or uninstall.exe missing'
    $process=Start-Process -FilePath $uninstaller -ArgumentList @("_?=$destination") -PassThru
    $welcome=Wait-Page { param($c) @($c | Where-Object { $_.Id -eq 1 -and $_.Class -eq 'Button' }).Count -eq 1 } 'uninstall welcome' 20
    Save-Page $welcome '01-welcome'
    Click-Control $welcome 1
    $options=Wait-Page { param($c) @($c | Where-Object { $_.Class -eq 'Button' -and $_.Text -match 'Also remove|同时移除|同時移除' }).Count -eq 1 } 'library/data option' 20
    $checkbox=($options.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text -match 'Also remove|同时移除|同時移除' }).Handle
    Assert-That ([WizardNative]::SendMessage($checkbox,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0) 'Data cleanup must default unchecked'
    Save-Page $options '02-options-default-unchecked'
    [WizardNative]::SendMessage($checkbox,0x00F1,[IntPtr]1,[IntPtr]::Zero) | Out-Null
    Click-Control $options 1
    $confirmation=$null
    $deadline=[DateTime]::UtcNow.AddSeconds($previewSeconds)
    do {
        foreach ($helper in @(Get-Process -Name Copilotix -ErrorAction SilentlyContinue)) {
            foreach ($window in [WizardNative]::Windows($helper.Id)) {
                $controls=@(Get-Controls $window)
                if (Test-ConfirmationButton $controls) { $confirmation=[pscustomobject]@{ Window=$window; Controls=$controls }; break }
                $ok=@($controls | Where-Object { $_.Class -eq 'Button' -and $_.Text -match 'OK|確定|确定' })
                if ($ok.Count -and (Get-DialogText $window) -match '無法完成資料清理') {
                    [WizardNative]::PostMessage($ok[0].Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
                    throw 'Cleanup preview refused existing user data; no deletion was performed'
                }
            }
        }
        if (-not $confirmation) { Start-Sleep -Milliseconds 200 }
    } while (-not $confirmation -and [DateTime]::UtcNow -lt $deadline)
    Assert-That ($null -ne $confirmation) 'Second data deletion confirmation was not shown'
    Save-Page $confirmation '03-data-confirmation'
    Assert-ConfirmationText $confirmation
    $cancel=@($confirmation.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&','') -match 'Cancel|取消' })
    Assert-That ($cancel.Count -eq 1) 'Expected one cancellation button'
    [WizardNative]::PostMessage($cancel[0].Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
    Assert-That ($process.WaitForExit(20000)) 'Cancelled cleanup did not stop uninstall'
    Assert-That ($process.ExitCode -eq 2) 'Cancelled cleanup exit code must be 2'
    Assert-That (Test-Path -LiteralPath $app) 'Cancellation removed program binaries'
    if ($InPlace) {
        Assert-That ((Get-RegistrySnapshot) -eq $registryBefore) 'In-place acceptance changed existing installation registry'
    } else {
        $registrations=@(Get-ChildItem 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*' })
        Assert-That ($registrations.Count -eq 1) 'Cancellation removed uninstall registration'
    }
    Assert-That ((Get-DataSnapshot) -eq $before) 'Cancelled cleanup changed user data'
    Write-Host "PASS: $(if ($InPlace) { 'unregistered copy, ' })uninstall.exe, default keep-data checkbox, real-path second confirmation, cancellation preserves binaries, registration and data"
} finally {
    # Any surviving helper belongs to our isolated install; cancel its native
    # prompt without selecting removal, then let ExecWait return naturally.
    foreach ($helper in @(Get-Process -Name Copilotix -ErrorAction SilentlyContinue)) {
        if ($helper.Path -eq (Join-Path $destination 'Copilotix.exe')) {
            foreach ($window in [WizardNative]::Windows($helper.Id)) {
                foreach ($cancel in @(Get-Controls $window | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&','') -match 'Cancel|取消' })) {
                    [WizardNative]::PostMessage($cancel.Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
                }
            }
            $helper.WaitForExit(10000) | Out-Null
            if (-not $helper.HasExited) { Stop-Process -Id $helper.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    if ($process) {
        $process.Refresh()
        if (-not $process.HasExited) {
            foreach ($window in [WizardNative]::Windows($process.Id)) { [WizardNative]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
            $process.WaitForExit(10000) | Out-Null
            # A helper still scanning would raise its prompt with nobody left to cancel
            # it. Nothing was confirmed, so ending the process deletes nothing.
            if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
        }
    }
    if ($installed) {
        $cleanup=Start-Process -FilePath (Join-Path $destination 'uninstall.exe') -ArgumentList @('/S',"_?=$destination") -WindowStyle Hidden -PassThru
        Assert-That ($cleanup.WaitForExit(120000) -and $cleanup.ExitCode -eq 0) 'Silent cleanup of owned test install failed'
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $destination 'Copilotix.exe'))) 'Owned runtime survived cleanup'
        Assert-That ((Get-DataSnapshot) -eq $before) 'Silent cleanup changed user data'
        $resolved=[IO.Path]::GetFullPath($testRoot)
        Assert-That ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('copilotix-uninstall-wizard-')) 'Unsafe test cleanup path'
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    if (($UiOnly -or $InPlace) -and (Test-Path -LiteralPath $testRoot)) {
        $resolved=[IO.Path]::GetFullPath($testRoot)
        Assert-That ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('copilotix-uninstall-wizard-')) 'Unsafe extracted UI cleanup path'
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
}
