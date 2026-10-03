# Exercise actual NSIS controls without displaying interactive windows.
[CmdletBinding()]
param(
    [string]$ReleaseDirectory,
    [string]$EvidenceDirectory,
    [ValidateSet('English','SimplifiedChinese','TraditionalChinese')][string]$Language='English',
    [switch]$Install
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ReleaseDirectory) { $ReleaseDirectory = Join-Path $PSScriptRoot '../../release' }
if (-not $EvidenceDirectory) { $EvidenceDirectory = Join-Path $PSScriptRoot '../test-artifacts/installer-wizard' }
Add-Type -AssemblyName System.Drawing
$drawingReferences = if ($PSVersionTable.PSEdition -eq 'Core') {
    @((Get-ChildItem -LiteralPath (Join-Path $PSHOME 'ref') -Filter '*.dll').FullName) +
        @([System.Drawing.Bitmap].Assembly.Location) +
        @((Get-ChildItem -LiteralPath $PSHOME -Filter 'System.Private.Windows.*.dll').FullName)
} else { @('System.Drawing') }
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
public static class WizardNative {
    public delegate bool EnumCallback(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumCallback callback, IntPtr param);
    [DllImport("user32.dll")] static extern bool EnumChildWindows(IntPtr parent, EnumCallback callback, IntPtr param);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr hwnd);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, string lparam);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, StringBuilder lparam);
    [DllImport("user32.dll")] public static extern IntPtr SendMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid folder, uint flags, IntPtr token, out IntPtr path);
    public static string UserPrograms() {
        Guid folder=new Guid("5CD7AEE2-2219-4A67-B85D-6C9CE15660CB"); IntPtr p;
        int result=SHGetKnownFolderPath(ref folder,0,IntPtr.Zero,out p);
        try { if(result!=0) throw new Exception("Cannot resolve current-user Programs folder"); return Marshal.PtrToStringUni(p); }
        finally { if(p!=IntPtr.Zero) Marshal.FreeCoTaskMem(p); }
    }
    public static IntPtr[] Windows(int pid) {
        var result = new List<IntPtr>();
        EnumWindows((h,p) => { uint owner; GetWindowThreadProcessId(h, out owner); if(owner == pid) result.Add(h); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
    public static IntPtr[] Children(IntPtr parent) {
        var result = new List<IntPtr>();
        EnumChildWindows(parent, (h,p) => { result.Add(h); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
    public static string Text(IntPtr hwnd) { var s = new StringBuilder(16384); SendMessage(hwnd,0x000D,(IntPtr)s.Capacity,s); return s.ToString(); }
    public static string Class(IntPtr hwnd) { var s = new StringBuilder(256); GetClassName(hwnd,s,s.Capacity); return s.ToString(); }
    public static string[] ComboItems(IntPtr hwnd) {
        int count=SendMessage(hwnd,0x0146,IntPtr.Zero,IntPtr.Zero).ToInt32(); var items=new List<string>();
        for(int i=0;i<count;i++) { var s=new StringBuilder(512); SendMessage(hwnd,0x0148,(IntPtr)i,s); items.Add(s.ToString()); }
        return items.ToArray();
    }
    public static void Capture(IntPtr hwnd, string path) {
        Rect r; if(!GetWindowRect(hwnd,out r)) throw new Exception("Cannot measure wizard");
        using(var b = new Bitmap(r.Right-r.Left,r.Bottom-r.Top)) using(var g = Graphics.FromImage(b)) {
            var dc=g.GetHdc(); bool ok; try { ok=PrintWindow(hwnd,dc,2); } finally { g.ReleaseHdc(dc); }
            if(!ok) throw new Exception("PrintWindow failed"); b.Save(path,ImageFormat.Png);
        }
    }
}
'@ -ReferencedAssemblies $drawingReferences
function Assert-That([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Controls([IntPtr]$Window) {
    foreach ($handle in [WizardNative]::Children($Window)) {
        if ([WizardNative]::IsWindowVisible($handle)) {
            [pscustomobject]@{ Handle=$handle; Id=[WizardNative]::GetDlgCtrlID($handle); Class=[WizardNative]::Class($handle); Text=[WizardNative]::Text($handle) }
        }
    }
}
function Wait-Page([scriptblock]$Predicate, [string]$Description, [int]$Seconds=30) {
    $deadline=[DateTime]::UtcNow.AddSeconds($Seconds)
    do {
        $process.Refresh()
        Assert-That (-not $process.HasExited) "Setup exited while waiting for $Description"
        foreach ($window in [WizardNative]::Windows($process.Id)) {
            if (-not [WizardNative]::IsWindowVisible($window)) { continue }
            $controls=@(Get-Controls $window)
            if (& $Predicate $controls) { return [pscustomobject]@{ Window=$window; Controls=$controls } }
        }
        Start-Sleep -Milliseconds 200
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Timed out waiting for $Description"
}
function Save-Page($Page, [string]$Name) {
    $Page.Controls | Select-Object Id,Class,Text | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $evidence "$Name.json") -Encoding UTF8
    [WizardNative]::Capture($Page.Window, (Join-Path $evidence "$Name.png"))
}
function Click-Control($Page, [int]$Id) {
    $controls=@(Get-Controls $Page.Window)
    $control=@($controls | Where-Object { $_.Id -eq $Id -and $_.Class -eq 'Button' })
    $visibleButtons=($controls | Where-Object Class -eq 'Button' | ForEach-Object { "$($_.Id): $($_.Text)" }) -join '; '
    Assert-That ($control.Count -eq 1) "Expected visible wizard button $Id; visible buttons: $visibleButtons"
    Assert-That ([WizardNative]::PostMessage($control[0].Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero)) "Could not click visible wizard button $Id"
}
$release=[IO.Path]::GetFullPath($ReleaseDirectory)
$evidence=Join-Path ([IO.Path]::GetFullPath($EvidenceDirectory)) $Language
New-Item -ItemType Directory -Path $evidence -Force | Out-Null
$manifestPath=Join-Path $release 'advanced/release-manifest.json'
if (-not (Test-Path -LiteralPath $manifestPath)) { $manifestPath=Join-Path $release 'release-manifest.json' }
$manifest=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$setup=Join-Path $release $manifest.installer.file
Assert-That ((Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.installer.sha256) 'Setup hash differs from release manifest'
$testRoot=Join-Path ([IO.Path]::GetTempPath()) ('copilotix-wizard-'+[Guid]::NewGuid().ToString('N'))
$destination=Join-Path $testRoot '精靈自訂 path\Copilotix'
if ($Install) {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall','HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
        $existing=@(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*' })
        Assert-That ($existing.Count -eq 0) 'Use a clean Windows account for wizard installation'
    }
    foreach ($path in @((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Copilotix.lnk'),(Join-Path ([Environment]::GetFolderPath('Programs')) 'Copilotix.lnk'))) { Assert-That (-not (Test-Path -LiteralPath $path)) "Existing shortcut: $path" }
    Assert-That (@(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -eq 0) 'Exit Copilotix before wizard installation'
}
$process=Start-Process -FilePath $setup -WindowStyle Hidden -PassThru
$installed=$false
try {
    $languagePage=Wait-Page { param($c) @($c | Where-Object Class -eq 'ComboBox').Count -eq 1 } 'language selector'
    Save-Page $languagePage '01-language'
    $combo=($languagePage.Controls | Where-Object Class -eq 'ComboBox').Handle
    $items=[WizardNative]::ComboItems($combo)
    $items | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'languages.json') -Encoding UTF8
    Assert-That ($items.Count -eq 3) 'Expected English, simplified Chinese and traditional Chinese'
    $languagePattern=switch($Language) { 'English' {'English'} 'SimplifiedChinese' {'简体|Simplified'} 'TraditionalChinese' {'繁體|Traditional'} }
    $selected=-1
    for($i=0;$i -lt $items.Count;$i++){ if($items[$i] -match $languagePattern){$selected=$i} }
    Assert-That ($selected -ge 0) "Requested language missing: $Language ($($items -join ', '))"
    [WizardNative]::SendMessage($combo,0x014E,[IntPtr]$selected,[IntPtr]::Zero) | Out-Null
    Click-Control $languagePage 1
    $welcomePattern=switch($Language) { 'English' {'This wizard installs Copilotix'} 'SimplifiedChinese' {'此向导将为当前 Windows 用户安装 Copilotix'} 'TraditionalChinese' {'此精靈將為目前 Windows 使用者安裝 Copilotix'} }
    $preservePattern=switch($Language) { 'English' {'Uninstall keeps your data by default'} 'SimplifiedChinese' {'卸载默认保留资料'} 'TraditionalChinese' {'解除安裝預設保留資料'} }
    $welcome=Wait-Page { param($c) (($c | ForEach-Object Text) -join ' ') -like "*$welcomePattern*" } 'custom welcome copy'
    Save-Page $welcome '02-welcome'
    Assert-That (($welcome.Controls.Text -join ' ') -like "*$preservePattern*") 'Data preservation copy missing'
    Click-Control $welcome 1
    $directory=Wait-Page { param($c) @($c | Where-Object Class -eq 'Edit').Count -eq 1 } 'editable installation directory'
    $edit=($directory.Controls | Where-Object Class -eq 'Edit').Handle
    $defaultDirectory=[WizardNative]::Text($edit)
    [pscustomobject]@{ defaultDirectory=$defaultDirectory; currentUser=$env:USERNAME } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'default-install-directory.json') -Encoding UTF8
    if ($Install) { Assert-That ($defaultDirectory -eq (Join-Path ([WizardNative]::UserPrograms()) 'Copilotix')) 'Default program path differs from current-user Programs known folder' }
    [WizardNative]::SendMessage($edit,0x000C,[IntPtr]::Zero,$destination) | Out-Null
    Assert-That ([WizardNative]::Text($edit) -eq $destination) 'Unicode custom directory was not accepted by directory picker'
    $directory.Controls=@(Get-Controls $directory.Window)
    Save-Page $directory '03-directory'
    Assert-That (@($directory.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text.Replace('&','') -match 'Browse|浏览|瀏覽' }).Count -eq 1) 'Browse control missing'
    Click-Control $directory 1
    $shortcutPattern=switch($Language) { 'English' {'Create a desktop shortcut'} 'SimplifiedChinese' {'创建桌面图标'} 'TraditionalChinese' {'建立桌面圖標'} }
    $options=Wait-Page { param($c) @($c | Where-Object { $_.Class -eq 'Button' -and $_.Text -eq $shortcutPattern }).Count -eq 1 } 'desktop shortcut option'
    Save-Page $options '04-desktop-shortcut'
    $shortcut=($options.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text -eq $shortcutPattern }).Handle
    Assert-That ([WizardNative]::SendMessage($shortcut,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 1) 'Desktop shortcut option is not selected by default'
    [WizardNative]::SendMessage($shortcut,0x00F1,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
    Assert-That ([WizardNative]::SendMessage($shortcut,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0) 'Desktop shortcut option cannot be unchecked'
    [WizardNative]::SendMessage($shortcut,0x00F1,[IntPtr]1,[IntPtr]::Zero) | Out-Null
    Assert-That ([WizardNative]::SendMessage($shortcut,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 1) 'Desktop shortcut option cannot be reselected'
    if ($Install) {
        Click-Control $options 1
        $finish=Wait-Page { param($c) @($c | Where-Object { $_.Class -eq 'Button' -and $_.Text -like '*Run Copilotix*' }).Count -eq 1 } 'finish controls' 180
        $installed=$true
        Save-Page $finish '04-finish'
        $run=($finish.Controls | Where-Object { $_.Class -eq 'Button' -and $_.Text -like '*Run Copilotix*' }).Handle
        [WizardNative]::SendMessage($run,0x00F1,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null
        Assert-That ([WizardNative]::SendMessage($run,0x00F0,[IntPtr]::Zero,[IntPtr]::Zero).ToInt32() -eq 0) 'Launch checkbox did not uncheck'
        Save-Page $finish '05-finish-launch-unchecked'
        Click-Control $finish 1
        Assert-That ($process.WaitForExit(30000)) 'Finish did not close Setup'
        $app=Join-Path $destination 'Copilotix.exe'
        Assert-That (Test-Path -LiteralPath $app) 'GUI-selected custom destination not installed'
        Assert-That ((Get-FileHash -LiteralPath $app -Algorithm SHA256).Hash.ToLowerInvariant() -eq $manifest.runtime.sha256) 'GUI installed runtime hash differs'
        $registration=@(Get-ChildItem -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall' | Get-ItemProperty | Where-Object { $_.PSObject.Properties['DisplayName'] -and $_.DisplayName -like 'Copilotix*' })
        Assert-That ($registration.Count -eq 1) 'GUI install registration missing'
        $installRecord=Get-ItemProperty -LiteralPath ('HKCU:\Software\'+$registration[0].PSChildName)
        Assert-That ($installRecord.InstallLocation.TrimEnd('\') -eq $destination) 'GUI install registered incorrect directory'
        $installRecord | Select-Object InstallLocation | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $evidence 'installed-directory.json') -Encoding UTF8
        Assert-That (@(Get-Process -Name Copilotix -ErrorAction SilentlyContinue).Count -eq 0) 'Unchecked launch still started app'
        Write-Host 'PASS: GUI custom directory install and optional launch finish control'
    } else {
        Click-Control $options 2
        # NSIS displays a cancellation confirmation in some builds.
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            foreach ($window in [WizardNative]::Windows($process.Id)) {
                $yes=@(Get-Controls $window | Where-Object { $_.Id -eq 6 -and $_.Class -eq 'Button' })
                if ($yes.Count) { [WizardNative]::PostMessage($yes[0].Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
            }
            Start-Sleep -Milliseconds 200; $process.Refresh()
        }
        Assert-That ($process.HasExited) 'Cancel did not close Setup'
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $destination 'Copilotix.exe'))) 'Cancelling options page unexpectedly installed program'
    }
    Write-Host 'PASS: language selector, branded welcome, editable Unicode directory, default checked desktop shortcut and cancellation/finish'
} finally {
    $process.Refresh()
    if (-not $process.HasExited) {
        foreach ($window in [WizardNative]::Windows($process.Id)) { [WizardNative]::PostMessage($window,0x0010,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
        $deadline=[DateTime]::UtcNow.AddSeconds(10)
        while (-not $process.HasExited -and [DateTime]::UtcNow -lt $deadline) {
            foreach ($window in [WizardNative]::Windows($process.Id)) {
                foreach ($yes in @(Get-Controls $window | Where-Object { $_.Id -eq 6 -and $_.Class -eq 'Button' })) { [WizardNative]::PostMessage($yes.Handle,0x00F5,[IntPtr]::Zero,[IntPtr]::Zero) | Out-Null }
            }
            Start-Sleep -Milliseconds 200; $process.Refresh()
        }
    }
    if ($installed) {
        $uninstaller=Join-Path $destination 'uninstall.exe'
        $cleanup=Start-Process -FilePath $uninstaller -ArgumentList @('/S',"_?=$destination") -WindowStyle Hidden -PassThru
        Assert-That ($cleanup.WaitForExit(120000)) 'Wizard test uninstall timed out'
        Assert-That ($cleanup.ExitCode -eq 0) 'Wizard test uninstall failed'
        $deadline=[DateTime]::UtcNow.AddSeconds(30)
        while ((Test-Path -LiteralPath (Join-Path $destination 'Copilotix.exe')) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 200 }
        Assert-That (-not (Test-Path -LiteralPath (Join-Path $destination 'Copilotix.exe'))) 'Wizard test runtime survived uninstall'
        $resolved=[IO.Path]::GetFullPath($testRoot)
        Assert-That ($resolved.StartsWith([IO.Path]::GetFullPath([IO.Path]::GetTempPath()),[StringComparison]::OrdinalIgnoreCase) -and [IO.Path]::GetFileName($resolved).StartsWith('copilotix-wizard-')) 'Unsafe cleanup target'
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    $process.Dispose()
}
