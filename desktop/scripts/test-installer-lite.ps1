# Exercise the real Lite installer next to whatever full edition this Windows account has.
# Everything Lite creates is owned by this test; the full edition is only ever read and compared.
# The data-removal confirmation is accepted only after it names Lite's folder and not the full edition's.
[CmdletBinding()]
param([string]$ReleaseDirectory, [string]$EvidenceDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$desktop = Split-Path -Parent $PSScriptRoot
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $desktop '../release-lite' }
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $desktop 'test-artifacts/lite-installer' }
# Reuse only the native-control helpers, never execute the full edition's install test.
$shared = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'test-installer-wizard.ps1') -Raw -Encoding UTF8
$begin = $shared.IndexOf('Add-Type -AssemblyName System.Drawing')
$end = $shared.IndexOf('$release=[IO.Path]::GetFullPath($ReleaseDirectory)')
if ($begin -lt 0 -or $end -le $begin) { throw 'Wizard helpers were not found' }
Invoke-Expression $shared.Substring($begin, $end - $begin)

$liteGuid = '0bd267d6-26a7-540d-9caf-eeda2860585f'
$fullGuid = '14328922-5660-531d-8d5f-b169b5a958e0'
$uninstallKeys = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
$liteName = 'Copilotix Lite'
$liteProcess = 'CopilotixLite'
$liteData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Copilotix-Lite'
$liteDocuments = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Copilotix Lite'
$liteShortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) "$liteName.lnk"), (Join-Path ([Environment]::GetFolderPath('Programs')) "$liteName.lnk"))
$fullData = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Copilotix-Translation-v2'
$fullLibrary = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Copilotix'
$fullShortcuts = @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Copilotix.lnk'), (Join-Path ([Environment]::GetFolderPath('Programs')) 'Copilotix.lnk'))

function Get-TextHash([string]$Text) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Text)
    return [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
}
function Get-Credentials([string]$Service) {
    # Names only: cmdkey never prints a secret.
    return @(cmdkey /list | Where-Object { $_ -match [regex]::Escape($Service) } | ForEach-Object { $_.Trim() } | Sort-Object)
}
# Read only. Compared at the end: Lite must not have changed a single one of these.
function Get-FullEditionSnapshot {
    # The stored values only: Get-ItemProperty also attaches provider state that changes on its own.
    $registration = @(Get-ItemProperty -LiteralPath "$uninstallKeys\$fullGuid", "HKCU:\Software\$fullGuid" -ErrorAction SilentlyContinue | ForEach-Object {
        $_.PSObject.Properties | Where-Object Name -NotMatch '^PS' | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }
    }) -join "`n"
    $program = 'absent'
    $record = Get-ItemProperty -LiteralPath "HKCU:\Software\$fullGuid" -ErrorAction SilentlyContinue
    if ($record -and $record.PSObject.Properties['InstallLocation'] -and $record.InstallLocation) {
        $program = @('Copilotix.exe', 'resources\app.asar') | ForEach-Object { (Get-FileHash -LiteralPath (Join-Path $record.InstallLocation $_) -Algorithm SHA256).Hash }
    }
    $shortcuts = @($fullShortcuts | Where-Object { Test-Path -LiteralPath $_ } | ForEach-Object { $item = Get-Item -LiteralPath $_; "$($item.FullName)|$($item.Length)|$($item.LastWriteTimeUtc.Ticks)" })
    $data = if (Test-Path -LiteralPath $fullData) {
        @(Get-ChildItem -LiteralPath $fullData -File | Where-Object Name -Match '^(copilotix-|usage-analytics)' | Sort-Object FullName | ForEach-Object { "$($_.Name)|$($_.Length)|$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash)" })
    } else { @('absent') }
    $library = if (Test-Path -LiteralPath $fullLibrary) {
        @(Get-ChildItem -LiteralPath $fullLibrary -Recurse -File -Force | Sort-Object FullName | ForEach-Object { "$($_.FullName)|$($_.Length)|$($_.LastWriteTimeUtc.Ticks)" })
    } else { @('absent') }
    return [pscustomobject]@{
        registration = Get-TextHash $registration
        program = ($program -join ',')
        shortcuts = ($shortcuts -join ';')
        data = Get-TextHash ($data -join "`n")
        libraryFiles = @($library).Count
        library = Get-TextHash ($library -join "`n")
        credentials = Get-TextHash ((Get-Credentials 'Copilotix-Translation') -join "`n")
    }
}
function Assert-FullEditionUntouched([string]$Step) {
    $now = Get-FullEditionSnapshot
    foreach ($name in $fullBefore.PSObject.Properties.Name) {
        Assert-That ($fullBefore.$name -eq $now.$name) "Full edition changed ($name) after: $Step"
    }
}
function Get-LiteRegistration {
    return Get-ItemProperty -LiteralPath "$uninstallKeys\$liteGuid" -ErrorAction SilentlyContinue
}
function Invoke-Installer([string]$Executable, [string[]]$Arguments, [int]$ExpectedExit = 0) {
    $run = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $run.WaitForExit(180000)) { throw "Installer timed out (PID $($run.Id))" }
    Assert-That ($run.ExitCode -eq $ExpectedExit) "Unexpected exit $($run.ExitCode), expected $ExpectedExit from $Executable $($Arguments -join ' ')"
}
function Wait-Until([scriptblock]$Condition, [string]$Message, [int]$Seconds = 30) {
    $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
    while (-not (& $Condition)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw $Message }
        Start-Sleep -Milliseconds 200
    }
}
function Step([string]$Message) {
    $script:passes += $Message
    Write-Host "PASS: $Message"
}
function Get-OwnedLiteProcesses {
    return @(Get-Process -Name $liteProcess -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $application })
}
function Stop-OwnedLite {
    foreach ($owned in @(Get-OwnedLiteProcesses)) { Stop-Process -Id $owned.Id -Force -ErrorAction SilentlyContinue }
    Wait-Until { @(Get-OwnedLiteProcesses).Count -eq 0 } 'Test instance of Lite did not stop'
}
function Assert-LiteInstalled {
    Assert-That (Test-Path -LiteralPath $application) 'Custom installation path was not used'
    Assert-That ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -eq $manifest.runtime.sha256) 'Installed executable differs from verified runtime'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $installDirectory 'resources/app.asar') -Algorithm SHA256).Hash -eq $manifest.runtime.appAsarSha256) 'Installed app.asar differs from verified runtime'
    $registration = Get-LiteRegistration
    Assert-That ($null -ne $registration) 'Lite registration is missing'
    Assert-That ($registration.DisplayName -eq "$liteName $($manifest.version)") "Unexpected display name: $($registration.DisplayName)"
    $record = Get-ItemProperty -LiteralPath "HKCU:\Software\$liteGuid"
    Assert-That ($record.InstallLocation.TrimEnd('\') -eq $installDirectory) 'Registered install path differs'
    $shell = New-Object -ComObject WScript.Shell
    foreach ($shortcut in $liteShortcuts) {
        Assert-That (Test-Path -LiteralPath $shortcut) "Shortcut is missing: $shortcut"
        Assert-That ((Get-FileHash -LiteralPath $shell.CreateShortcut($shortcut).TargetPath -Algorithm SHA256).Hash -eq $manifest.runtime.sha256) 'Shortcut targets another program'
    }
}
function Assert-LiteRemoved {
    Wait-Until { -not (Test-Path -LiteralPath $application) } 'Uninstall did not remove the program'
    Assert-That ($null -eq (Get-LiteRegistration)) 'Uninstall registration survived removal'
    foreach ($shortcut in $liteShortcuts) { Assert-That (-not (Test-Path -LiteralPath $shortcut)) "Shortcut survived uninstall: $shortcut" }
}

$release = [IO.Path]::GetFullPath($ReleaseDirectory)
$evidence = [IO.Path]::GetFullPath($EvidenceDirectory)
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$manifest = Get-Content -LiteralPath (Join-Path $release 'advanced/release-manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
Assert-That ($manifest.productName -eq $liteName) "Not a Lite release: $($manifest.productName)"
$setup = Join-Path $release $manifest.installer.file
$launcher = Join-Path $release $manifest.uninstaller.file
Assert-That ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash -eq $manifest.installer.sha256) 'Setup hash does not match manifest'
Assert-That ((Get-FileHash -LiteralPath $launcher -Algorithm SHA256).Hash -eq $manifest.uninstaller.sha256) 'Launcher hash does not match manifest'

# Preflight: refuse rather than touch anything Lite did not create in this run.
Assert-That ($null -eq (Get-LiteRegistration)) 'Lite is already installed for this account'
Assert-That (@(Get-Process -Name $liteProcess -ErrorAction SilentlyContinue).Count -eq 0) 'Lite is running'
Assert-That (-not (Test-Path -LiteralPath $liteData)) "Lite data already exists: $liteData"
Assert-That (-not (Test-Path -LiteralPath $liteDocuments)) "Lite documents already exist: $liteDocuments"
Assert-That (@(Get-Credentials 'Copilotix-Lite').Count -eq 0) 'Lite credentials already exist'
foreach ($shortcut in $liteShortcuts) { Assert-That (-not (Test-Path -LiteralPath $shortcut)) "Existing shortcut: $shortcut" }
Assert-That (@(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -eq 0) 'Exit the full edition first, so its data holds still while it is compared'

$fullBefore = Get-FullEditionSnapshot
$startedAt = [DateTime]::UtcNow
$passes = @()
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('copilotix-lite-installer-' + [Guid]::NewGuid().ToString('N'))
$customFolder = -join [char[]](0x81EA, 0x8A02, 0x5B89, 0x88DD)
$installDirectory = Join-Path $testRoot "$customFolder path\Copilotix Lite"
$application = Join-Path $installDirectory "$liteProcess.exe"
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$sentinel = Join-Path $liteData ('setup-test-' + [Guid]::NewGuid().ToString('N') + '.txt')
$process = $null
$fixtureProcess = $null
$credentialSeeded = $false
$completed = $false
New-Item -ItemType Directory -Path $testRoot | Out-Null
Push-Location $desktop
try {
    # The wizard itself, cancelled on its first page: its copy must name this product.
    $process = Start-Process -FilePath $setup -PassThru
    $languagePage = Wait-Page { param($c) @($c | Where-Object Class -eq 'ComboBox').Count -eq 1 } 'language selection'
    $combo = ($languagePage.Controls | Where-Object Class -eq 'ComboBox').Handle
    $english = -1; $items = [WizardNative]::ComboItems($combo)
    for ($i = 0; $i -lt $items.Count; $i++) { if ($items[$i] -match 'English') { $english = $i } }
    Assert-That ($english -ge 0) 'English missing from the language list'
    [WizardNative]::SendMessage($combo, 0x014E, [IntPtr]$english, [IntPtr]::Zero) | Out-Null
    Click-Control $languagePage 1
    $welcome = Wait-Page { param($c) (($c | ForEach-Object Text) -join ' ') -like '*This wizard installs Copilotix Lite*' } 'welcome naming Copilotix Lite'
    Save-Page $welcome '01-wizard-welcome'
    Click-Control $welcome 2
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
        foreach ($window in [WizardNative]::Windows($process.Id)) {
            foreach ($yes in @(Get-Controls $window | Where-Object { $_.Id -eq 6 -and $_.Class -eq 'Button' })) { [WizardNative]::PostMessage($yes.Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null }
        }
        Start-Sleep -Milliseconds 200; $process.Refresh()
    }
    Assert-That $process.HasExited 'Cancelled wizard did not exit'
    Assert-That ($null -eq (Get-LiteRegistration)) 'Cancelled wizard registered an installation'
    Step 'wizard names Copilotix Lite, cancelling installs nothing'

    Invoke-Installer $setup @('/S', '/allusers', "/D=$installDirectory") 2
    Assert-That (-not (Test-Path -LiteralPath $application)) 'All-users installation was accepted'
    Step 'all-users install rejected'

    Invoke-Installer $setup @('/S', "/D=$installDirectory")
    Assert-LiteInstalled
    Assert-FullEditionUntouched 'first install'
    $desktopPackage = Get-Content -LiteralPath (Join-Path $desktop 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    & node (Join-Path $PSScriptRoot 'installer-core-smoke.mjs') $application $manifest.version $desktopPackage.devDependencies.electron
    Assert-That ($LASTEXITCODE -eq 0) 'Installed application smoke failed'
    Step 'installs beside the full edition: own path, registration, shortcuts, verified hashes, core starts'

    # The real product, started the way a user starts it.
    $process = Start-Process -FilePath $application -PassThru
    Wait-Until { Test-Path -LiteralPath (Join-Path $liteData 'copilotix-desktop-v2.sqlite3') } 'Lite did not create its database in its own folder' 45
    Wait-Until { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero } 'Lite window did not appear' 30
    Start-Sleep -Seconds 6
    $process.Refresh()
    Assert-That (-not $process.HasExited) 'Lite exited after starting'
    Assert-That ($process.MainWindowTitle -notmatch 'failed') "Lite reported a failure: $($process.MainWindowTitle)"
    [WizardNative]::Capture($process.MainWindowHandle, (Join-Path $evidence '02-installed-home.png'))
    Assert-FullEditionUntouched 'running Lite'
    Step "runs with data only under $liteData"

    $second = Start-Process -FilePath $application -PassThru
    Assert-That ($second.WaitForExit(20000)) 'Second Lite instance did not hand over and exit'
    $process.Refresh()
    Assert-That (-not $process.HasExited) 'Second instance stopped the first'
    Step 'single instance within Lite'

    # The guard must see Lite's own executable name.
    Invoke-Installer $setup @('/S') 2
    Invoke-Installer $uninstaller @('/S', "_?=$installDirectory") 2
    $process.Refresh()
    Assert-That (-not $process.HasExited) 'Installer forcibly stopped the running application'
    Assert-That (Test-Path -LiteralPath $application) 'Blocked uninstall removed the program'
    Step 'install and uninstall refuse a running Lite without forcing it to close'

    Stop-OwnedLite
    Set-Content -LiteralPath $sentinel -Value 'Preserve Lite data' -Encoding UTF8

    # A running full edition must not block Lite. An owned sleeper carries its name, the real one is never started.
    $fixtureExecutable = Join-Path $testRoot 'Copilotix.exe'
    Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $fixtureExecutable
    $fixtureProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList '/c ping -n 120 127.0.0.1 > nul' -WindowStyle Hidden -PassThru
    Wait-Until { @(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -gt 0 } 'Name fixture did not start'
    Invoke-Installer $setup @('/S')
    Assert-LiteInstalled
    Assert-That (Test-Path -LiteralPath $sentinel) 'Replacement install removed Lite data'
    $fixtureProcess.Refresh()
    Assert-That (-not $fixtureProcess.HasExited) 'Lite setup stopped a process named Copilotix'
    Stop-Process -Id $fixtureProcess.Id -Force
    $fixtureProcess.WaitForExit(); $fixtureProcess = $null
    Assert-FullEditionUntouched 'replacement install'
    Step 'replacement install keeps path and data, and is not blocked by or stopping a process named Copilotix'

    Invoke-Installer $uninstaller @('/S', "_?=$installDirectory")
    Assert-LiteRemoved
    Assert-That (Test-Path -LiteralPath $sentinel) 'Silent uninstall removed Lite data'
    Assert-FullEditionUntouched 'silent uninstall'
    Step 'uninstall removes program, shortcuts and registration, keeps Lite data'

    # The downloaded launcher follows Lite's registration only, even with the full edition registered.
    Invoke-Installer $launcher @('/S') 2
    Assert-FullEditionUntouched 'launcher with Lite absent'
    Step 'downloaded uninstall.exe does nothing when only the full edition is installed'
    Invoke-Installer $setup @('/S', "/D=$installDirectory")
    Assert-LiteInstalled
    Invoke-Installer $launcher @('/S')
    Assert-LiteRemoved
    Assert-FullEditionUntouched 'launcher with Lite installed'
    Step 'downloaded uninstall.exe removes the registered Lite installation'

    # Optional data removal, the one path that deletes things.
    Invoke-Installer $setup @('/S', "/D=$installDirectory")
    Assert-LiteInstalled
    & node -e "new (require('@napi-rs/keyring').Entry)('Copilotix-Lite','parser-token').setPassword('lite-installer-fixture')"
    Assert-That ($LASTEXITCODE -eq 0) 'Could not create the Lite test credential'
    $credentialSeeded = $true
    Assert-That (@(Get-Credentials 'Copilotix-Lite').Count -eq 1) 'Lite test credential is not visible'
    $process = Start-Process -FilePath $application -ArgumentList @('--copilotix-uninstall-cleanup', '--lang=1033') -PassThru
    $confirmation = Wait-Page { param($c) @($c | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&', '') -eq 'Permanently remove' }).Count -eq 1 } 'data removal confirmation' 30
    Save-Page $confirmation '03-data-removal-confirmation'
    # The native dialog draws its text in a DirectUI control, readable only through UI Automation.
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
    $dialogElements = [System.Windows.Automation.AutomationElement]::FromHandle($confirmation.Window).FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
    $confirmationText = (@($dialogElements) | ForEach-Object { $_.Current.Name }) -join ' '
    Set-Content -LiteralPath (Join-Path $evidence '03-data-removal-confirmation.txt') -Value $confirmationText -Encoding UTF8
    function Click-Button($Page, [string]$Pattern) {
        $button = @($Page.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&', '') -match $Pattern })
        Assert-That ($button.Count -eq 1) "Expected one button matching $Pattern"
        Assert-That ([WizardNative]::PostMessage($button[0].Handle, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) 'Could not click the button'
    }
    if (($confirmationText -notlike "*$liteData*") -or ($confirmationText -match 'Copilotix-Translation-v2')) {
        Click-Button $confirmation '^Cancel$'
        throw "Confirmation does not name Lite's data alone, cancelled: $confirmationText"
    }
    Click-Button $confirmation '^Permanently remove$'
    $finished = $process.WaitForExit(30000)
    if (-not $finished) {
        $stuck = @([WizardNative]::Windows($process.Id) | Where-Object { [WizardNative]::IsWindowVisible($_) } | ForEach-Object {
            [System.Windows.Automation.AutomationElement]::FromHandle($_).FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name }
        }) -join ' '
        throw "Data removal did not finish: $stuck"
    }
    Assert-That ($process.ExitCode -eq 0) "Data removal failed with exit $($process.ExitCode)"
    Assert-That (-not (Test-Path -LiteralPath $sentinel)) 'Lite data survived removal'
    Assert-That (-not (Test-Path -LiteralPath (Join-Path $liteData 'copilotix-desktop-v2.sqlite3'))) 'Lite database survived removal'
    Assert-That (@(Get-Credentials 'Copilotix-Lite').Count -eq 0) 'Lite credential survived removal'
    $credentialSeeded = $false
    Assert-FullEditionUntouched 'Lite data removal'
    Step 'data removal confirmation names only Lite, removes Lite data and keys, full edition data and keys untouched'

    Invoke-Installer $uninstaller @('/S', "_?=$installDirectory")
    Assert-LiteRemoved
    Assert-FullEditionUntouched 'final uninstall'
    $completed = $true
} finally {
    Pop-Location
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id -Force }
    foreach ($owned in @(Get-OwnedLiteProcesses)) { Stop-Process -Id $owned.Id -Force -ErrorAction SilentlyContinue }
    if ($process -and -not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
    if ($credentialSeeded) { Push-Location $desktop; & node -e "new (require('@napi-rs/keyring').Entry)('Copilotix-Lite','parser-token').deleteCredential()"; Pop-Location }
    if (Test-Path -LiteralPath $uninstaller) {
        Start-Sleep -Seconds 1
        $cleanup = Start-Process -FilePath $uninstaller -ArgumentList @('/S', "_?=$installDirectory") -WindowStyle Hidden -PassThru
        $cleanup.WaitForExit(120000) | Out-Null
    }
    # Preflight proved these did not exist: whatever is there came from this run.
    if (Test-Path -LiteralPath $liteData) { Remove-Item -LiteralPath $liteData -Recurse -Force -ErrorAction Continue }
    if ((Test-Path -LiteralPath $liteDocuments) -and @(Get-ChildItem -LiteralPath $liteDocuments -Recurse -File -Force).Count -eq 0) { Remove-Item -LiteralPath $liteDocuments -Recurse -Force }
    # The cleanup helper cannot remove the temporary profile it ran from.
    Get-ChildItem -LiteralPath ([IO.Path]::GetTempPath()) -Directory -Filter 'copilotix-uninstall-cleanup-*' -ErrorAction SilentlyContinue | Where-Object { $_.CreationTimeUtc -ge $startedAt } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    $resolvedRoot = [IO.Path]::GetFullPath($testRoot)
    $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
    if ($resolvedRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($resolvedRoot) -match '^copilotix-lite-installer-[a-f0-9]{32}$')) {
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force -ErrorAction Continue
    }
    [pscustomobject]@{ completed = $completed; version = $manifest.version; setupSha256 = $manifest.installer.sha256; passes = $passes; fullEdition = $fullBefore } |
        ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $evidence 'result.json') -Encoding UTF8
}
if ($completed) { Write-Host 'Lite installer acceptance passed' }
