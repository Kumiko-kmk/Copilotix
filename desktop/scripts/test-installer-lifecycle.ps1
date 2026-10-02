# Exercise the real NSIS artifact; never replace an existing user's installation.
[CmdletBinding()]
param([string]$ReleaseDirectory)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $PSScriptRoot '../../release' }

function Assert-That([bool]$Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}
# Shell links may expose a DOS short path; compare the actual filesystem target.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class InstallerFilePath {
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern uint GetFinalPathNameByHandle(IntPtr file, StringBuilder path, uint length, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr file);
    public static string Canonical(string path) {
        IntPtr file=CreateFile(path,0,7,IntPtr.Zero,3,0,IntPtr.Zero);
        if(file==new IntPtr(-1)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
        try {
            var result=new StringBuilder(32768);
            uint length=GetFinalPathNameByHandle(file,result,(uint)result.Capacity,0);
            if(length==0 || length>=result.Capacity) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
            return result.ToString();
        } finally { CloseHandle(file); }
    }
}
[
    ComImport,
    Guid("000214F9-0000-0000-C000-000000000046"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
]
interface IShellLinkW {
    [PreserveSig]
    int GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder path, int length, IntPtr findData, uint flags);
}
[
    ComImport,
    Guid("0000010b-0000-0000-C000-000000000046"),
    InterfaceType(ComInterfaceType.InterfaceIsIUnknown)
]
interface IPersistFile {
    [PreserveSig] int GetClassID(out Guid classId);
    [PreserveSig] int IsDirty();
    [PreserveSig] int Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);
    [PreserveSig] int Save([MarshalAs(UnmanagedType.LPWStr)] string fileName, bool remember);
    [PreserveSig] int SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);
    [PreserveSig] int GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
}
public static class InstallerShortcut {
    static readonly Guid ShellLinkClass = new Guid("00021401-0000-0000-C000-000000000046");
    public static string GetTarget(string shortcutPath) {
        object link = Activator.CreateInstance(Type.GetTypeFromCLSID(ShellLinkClass, true));
        try {
            int loadResult = ((IPersistFile)link).Load(shortcutPath, 0);
            if (loadResult < 0) Marshal.ThrowExceptionForHR(loadResult);
            var target = new StringBuilder(32768);
            int pathResult = ((IShellLinkW)link).GetPath(target, target.Capacity, IntPtr.Zero, 0);
            if (pathResult < 0) Marshal.ThrowExceptionForHR(pathResult);
            return target.ToString();
        } finally {
            Marshal.ReleaseComObject(link);
        }
    }
}
'@
function Get-CopilotixRegistration {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        if (Test-Path -LiteralPath $root) {
            Get-ChildItem -LiteralPath $root | Get-ItemProperty | Where-Object {
                $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*'
            }
        }
    }
}
function Invoke-Installer([string]$Executable, [string[]]$Arguments, [int]$ExpectedExit = 0) {
    $process = Start-Process -FilePath $Executable -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(120000)) { throw "Installer timed out (PID $($process.Id)); inspect before rerunning." }
    Assert-That ($process.ExitCode -eq $ExpectedExit) "Unexpected exit $($process.ExitCode), expected $ExpectedExit from $Executable"
}
function Wait-Until([scriptblock]$Condition, [string]$Message) {
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    while (-not (& $Condition)) {
        if ([DateTime]::UtcNow -ge $deadline) { throw $Message }
        Start-Sleep -Milliseconds 200
    }
}

$release = [IO.Path]::GetFullPath($ReleaseDirectory)
$manifest = Get-Content -LiteralPath (Join-Path $release 'advanced/release-manifest.json') -Raw | ConvertFrom-Json
$setup = Join-Path $release $manifest.installer.file
Assert-That (Test-Path -LiteralPath $setup -PathType Leaf) 'Setup artifact is missing'
Assert-That ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.installer.sha256) 'Setup hash does not match manifest'
Assert-That (@(Get-CopilotixRegistration).Count -eq 0) 'Existing Copilotix installation detected; run in a clean Windows account instead'
Assert-That (@(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -eq 0) 'Copilotix is running; exit it using the tray before lifecycle tests'

$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Copilotix.lnk'
$menuShortcut = Join-Path ([Environment]::GetFolderPath('Programs')) 'Copilotix.lnk'
foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
    Assert-That (-not (Test-Path -LiteralPath $shortcut)) "Existing shortcut detected: $shortcut"
}
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('copilotix-installer-' + [Guid]::NewGuid().ToString('N'))
$installDirectory = Join-Path $testRoot '自訂安裝 path\Copilotix'
$application = Join-Path $installDirectory 'Copilotix.exe'
$uninstaller = Join-Path $installDirectory 'uninstall.exe'
$dataRoot = Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'Copilotix-Translation-v2'
$dataRootExisted = Test-Path -LiteralPath $dataRoot
$sentinel = Join-Path $dataRoot ('setup-test-' + [Guid]::NewGuid().ToString('N') + '.txt')
$database = Join-Path $dataRoot 'copilotix-desktop-v2.sqlite3'
$databaseHash = if (Test-Path -LiteralPath $database) { (Get-FileHash -LiteralPath $database).Hash } else { $null }
$fixtureProcess = $null
$completed = $false
$credentialFixture = [Guid]::NewGuid().ToString('N')
$credentialCreated = $false

New-Item -ItemType Directory -Path $testRoot, $dataRoot -Force | Out-Null
Set-Content -LiteralPath $sentinel -Value 'Preserve existing settings and document library' -Encoding UTF8
$library = Join-Path $testRoot 'independent-library'
New-Item -ItemType Directory -Path $library | Out-Null
$paper = Join-Path $library 'original.pdf'
$runtimeRoot = if ($manifest.schemaVersion -ge 5) { Split-Path -Parent (Join-Path $release $manifest.runtimeArtifactDirectory) } elseif ($manifest.schemaVersion -ge 4) { $release } elseif ($manifest.PSObject.Properties['artifactDirectory']) { Join-Path $release $manifest.artifactDirectory } else { Join-Path $release 'advanced' }
Copy-Item -LiteralPath (Join-Path $runtimeRoot "$($manifest.runtime.directory)/resources/tutorial/Attention Is All You Need.pdf") -Destination $paper
$paperHash = (Get-FileHash -LiteralPath $paper).Hash

function Assert-PreservedData {
    Assert-That (Test-Path -LiteralPath $sentinel) 'Uninstall or upgrade removed application data'
    Assert-That ((Get-FileHash -LiteralPath $paper).Hash -eq $paperHash) 'Document library changed'
    if ($databaseHash) { Assert-That ((Get-FileHash -LiteralPath $database).Hash -eq $databaseHash) 'Existing database changed' }
    & node (Join-Path $PSScriptRoot 'installer-credential-fixture.mjs') verify $credentialFixture
    Assert-That ($LASTEXITCODE -eq 0) 'Credential Manager fixture did not survive'
}
function Assert-Installed {
    Assert-That (Test-Path -LiteralPath $application) 'Custom installation path was not used'
    Assert-That ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash -eq $manifest.runtime.sha256) 'Installed executable differs from verified runtime'
    Assert-That ((Get-FileHash -LiteralPath (Join-Path $installDirectory 'resources/app.asar') -Algorithm SHA256).Hash -eq $manifest.runtime.appAsarSha256) 'Installed app.asar differs from verified runtime'
    Assert-That (Test-Path -LiteralPath $uninstaller) 'Uninstaller is missing'
    $registration = @(Get-CopilotixRegistration)
    Assert-That ($registration.Count -eq 1) 'Expected one Windows uninstall registration'
    Assert-That ($registration[0].PSPath -like '*HKEY_CURRENT_USER*') 'Install must register only for current user'
    $installationRecord = Get-ItemProperty -LiteralPath ("HKCU:\Software\" + $registration[0].PSChildName)
    Assert-That ($installationRecord.InstallLocation.TrimEnd('\') -eq $installDirectory) 'Registered install path differs'
    foreach ($shortcut in @($desktopShortcut, $menuShortcut)) {
        Assert-That (Test-Path -LiteralPath $shortcut) "Shortcut is missing: $shortcut"
        $target = [InstallerShortcut]::GetTarget($shortcut)
        Write-Host "Shortcut target: $target; expected: $application"
        Assert-That ([InstallerFilePath]::Canonical($target) -eq [InstallerFilePath]::Canonical($application)) 'Shortcut targets incorrect executable'
    }
    $desktopPackage = Get-Content -LiteralPath (Join-Path $PSScriptRoot '../package.json') -Raw | ConvertFrom-Json
    # Windows PowerShell does not reliably capture a GUI executable's output.
    & node (Join-Path $PSScriptRoot 'installer-core-smoke.mjs') $application $manifest.version $desktopPackage.devDependencies.electron
    Assert-That ($LASTEXITCODE -eq 0) 'Installed application smoke failed'
    Assert-PreservedData
}
function Uninstall-TestApplication {
    # _?= prevents NSIS from spawning a detached temporary uninstaller, allowing
    # us to wait for actual completion. It must be the final unquoted argument.
    Invoke-Installer $uninstaller @('/S', "_?=$installDirectory")
    Wait-Until { -not (Test-Path -LiteralPath $application) } 'Uninstall did not remove application'
    Assert-That (@(Get-CopilotixRegistration).Count -eq 0) 'Uninstall registration survived removal'
    foreach ($shortcut in @($desktopShortcut, $menuShortcut)) { Assert-That (-not (Test-Path -LiteralPath $shortcut)) 'Shortcut survived uninstall' }
    Assert-PreservedData
}

try {
    & node (Join-Path $PSScriptRoot 'installer-credential-fixture.mjs') create $credentialFixture
    Assert-That ($LASTEXITCODE -eq 0) 'Failed to create isolated Credential Manager fixture'
    $credentialCreated = $true
    Invoke-Installer $setup @('/S', '/allusers', "/D=$installDirectory") 2
    Assert-That (-not (Test-Path -LiteralPath $application)) 'All-users installation was accepted'
    Write-Host 'PASS: all-users install rejected'
    Invoke-Installer $setup @('/S', "/D=$installDirectory")
    Assert-Installed
    Write-Host 'PASS: current-user install, Unicode/space path, shortcuts, hashes, core startup'
    Invoke-Installer $setup @('/S')
    Assert-Installed
    Write-Host 'PASS: replacement install retains path and data'

    # An owned sleeping process named Copilotix exercises the native process
    # guard without starting a user's queue or holding their database open.
    $fixtureExecutable = Join-Path $testRoot 'Copilotix.exe'
    Copy-Item -LiteralPath "$env:SystemRoot\System32\cmd.exe" -Destination $fixtureExecutable
    $fixtureProcess = Start-Process -FilePath $fixtureExecutable -ArgumentList '/c ping -n 120 127.0.0.1 > nul' -WindowStyle Hidden -PassThru
    Wait-Until { @(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -gt 0 } 'Guard fixture did not start'
    Invoke-Installer $setup @('/S') 2
    $fixtureProcess.Refresh()
    Assert-That (-not $fixtureProcess.HasExited) 'Setup forcibly terminated the running process'
    Invoke-Installer $uninstaller @('/S', "_?=$installDirectory") 2
    $fixtureProcess.Refresh()
    Assert-That (-not $fixtureProcess.HasExited) 'Uninstaller forcibly terminated the running process'
    Assert-That (Test-Path -LiteralPath $application) 'Blocked uninstall removed application'
    Stop-Process -Id $fixtureProcess.Id
    $fixtureProcess.WaitForExit()
    $fixtureProcess = $null
    Write-Host 'PASS: install and uninstall refuse running application without force termination'

    Uninstall-TestApplication
    Write-Host 'PASS: uninstall removes program, shortcuts, registration and preserves data'
    Invoke-Installer $setup @('/S', "/D=$installDirectory")
    Assert-Installed
    Uninstall-TestApplication
    Write-Host 'PASS: reinstall and second uninstall retain data'
    $completed = $true
} finally {
    if ($credentialCreated) {
        & node (Join-Path $PSScriptRoot 'installer-credential-fixture.mjs') remove $credentialFixture
    }
    if ($fixtureProcess -and -not $fixtureProcess.HasExited) { Stop-Process -Id $fixtureProcess.Id }
    if (Test-Path -LiteralPath $application) {
        Write-Warning "Test installation retained for diagnosis: $installDirectory. Uninstall it before rerunning."
    }
    if (Test-Path -LiteralPath $sentinel) { Remove-Item -LiteralPath $sentinel }
    if (-not $dataRootExisted -and @(Get-ChildItem -LiteralPath $dataRoot -Force).Count -eq 0) { Remove-Item -LiteralPath $dataRoot }
    if ($completed) {
        $resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
        $resolvedTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
        Assert-That ($resolvedTestRoot.StartsWith($resolvedTemp, [StringComparison]::OrdinalIgnoreCase) -and ([IO.Path]::GetFileName($resolvedTestRoot) -match '^copilotix-installer-[a-f0-9]{32}$')) 'Refusing unexpected cleanup path'
        Remove-Item -LiteralPath $resolvedTestRoot -Recurse -Force
    }
}
