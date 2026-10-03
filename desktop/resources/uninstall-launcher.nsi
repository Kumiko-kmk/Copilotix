; Downloaded release entry: only launch the registered current-user uninstaller.
; Never delete files or derive the installation location from this EXE's folder.
Unicode true
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
SetCompressor /SOLID lzma
Name "Copilotix Uninstall"
OutFile "${OUTPUT_PATH}"
Icon "${ICON_PATH}"
VIProductVersion "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "ProductName" "Copilotix"
VIAddVersionKey /LANG=1033 "FileDescription" "Copilotix registered uninstall launcher"
VIAddVersionKey /LANG=1033 "FileVersion" "${PRODUCT_VERSION}"
VIAddVersionKey /LANG=1033 "LegalCopyright" "Copilotix contributors"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!define /ifndef INSTALL_GUID "14328922-5660-531d-8d5f-b169b5a958e0"
!define INSTALL_KEY "Software\${INSTALL_GUID}"
!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${INSTALL_GUID}"
Var registeredRoot
Var registeredCommand
Var target
Var quiet

Section
  SetShellVarContext current
  SetRegView 64
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/S" $1
  StrCpy $quiet 0
  ${IfNot} ${Errors}
    StrCpy $quiet 1
  ${EndIf}
  ReadRegStr $registeredRoot HKCU "${INSTALL_KEY}" "InstallLocation"
  ReadRegStr $registeredCommand HKCU "${UNINSTALL_KEY}" "UninstallString"
  StrCmp $registeredRoot "" missing
  StrCmp $registeredCommand "" missing

  ; Accept only canonical absolute non-root Windows paths. This excludes relative
  ; registry values and command syntax; no registry command is ever executed.
  StrCpy $0 $registeredRoot
  System::Call 'shlwapi::PathIsRelativeW(w r0) i.r1'
  StrCmp $1 0 +2
  Goto invalid
  System::Call 'shlwapi::PathIsRootW(w r0) i.r1'
  StrCmp $1 0 +2
  Goto invalid
  GetFullPathName $0 "$registeredRoot"
  StrCmp $0 $registeredRoot +2
  Goto invalid
  IfFileExists "$registeredRoot\Copilotix.exe" +2 invalid
  IfFileExists "$registeredRoot\resources\app.asar" +2 invalid

  StrCpy $target "$registeredRoot\uninstall.exe"
  StrCmp $registeredCommand '$\"$target$\" /currentuser' launch
  StrCmp $registeredCommand '$\"$target$\"' launch
  StrCpy $target "$registeredRoot\Uninstall Copilotix.exe"
  StrCmp $registeredCommand '$\"$target$\" /currentuser' launch
  StrCmp $registeredCommand '$\"$target$\"' launch invalid

launch:
  IfFileExists "$target" +2 invalid
  ; Prevent accidental recursion if a download overwrote the installed file.
  StrCmp "$EXEPATH" "$target" invalid
  ClearErrors
  ${If} $quiet == 1
    ; Explicit /S retains data and waits for removal of the installed program.
    ; _?= is the registered root, never the downloaded launcher's directory.
    ExecWait '$\"$target$\" /currentuser /S _?=$registeredRoot' $0
    IfErrors invalid
    SetErrorLevel $0
    Goto done
  ${EndIf}
  ExecShell "open" "$target" "/currentuser" SW_SHOWNORMAL
  IfErrors invalid
  SetErrorLevel 0
  Goto done

missing:
  ${If} $quiet == 0
    MessageBox MB_OK|MB_ICONINFORMATION "未找到目前使用者的 Copilotix 安裝。請先執行 Setup；若已移除，無需再次卸載。$\r$\n$\r$\nNo Copilotix installation was found for this Windows account. Run Setup first, or no further removal is needed."
  ${EndIf}
  SetErrorLevel 2
  Goto done
invalid:
  ${If} $quiet == 0
    MessageBox MB_OK|MB_ICONSTOP "無法安全確認 Copilotix 安裝位置，未執行任何卸載。請使用 Windows 設定中的已安裝應用程式，或重新執行 Setup 修復安裝。$\r$\n$\r$\nThe registered Copilotix installation could not be verified. No removal was performed. Use Windows Installed apps or repair the installation with Setup."
  ${EndIf}
  SetErrorLevel 2
done:
SectionEnd
