; Extend electron-builder's guided installer; retain its upgrade/rollback logic.
; The default CHECK_APP_RUNNING eventually force-kills the app. Copilotix has a
; durable background queue, so installation and removal must wait for tray Exit.
!include "nsProcess.nsh"
!include "nsDialogs.nsh"

; common.nsh defines the default before this supported late hook. Installer
; registration and removal both use this name; retain builder's signed binary.
!macro customHeader
  !undef UNINSTALL_FILENAME
  !define UNINSTALL_FILENAME "uninstall.exe"
!macroend

!ifdef BUILD_UNINSTALLER
  Var copilotixRemoveData
  Var copilotixRemoveDataCheckbox
!endif

LangString copilotixRunning 2052 "Copilotix 仍在运行（可能在系统托盘中）。请从托盘菜单选择“退出”，等待后台任务安全停止后，再点击“重试”。安装器不会强制关闭程序。"
LangString copilotixRunning 1028 "Copilotix 仍在執行（可能在系統匣中）。請從系統匣選單選擇「退出」，等待背景任務安全停止後，再按「重試」。安裝程式不會強制關閉程式。"
LangString copilotixRunning 1033 "Copilotix is still running, possibly in the system tray. Choose Exit from its tray menu and wait for background tasks to stop safely, then click Retry. Setup will not force-close the app."
LangString copilotixProcessError 2052 "无法确认 Copilotix 是否已经退出。为保护后台任务，本次操作已停止。请退出 Copilotix 后重试。"
LangString copilotixProcessError 1028 "無法確認 Copilotix 是否已經退出。為保護背景任務，本次操作已停止。請退出 Copilotix 後重試。"
LangString copilotixProcessError 1033 "Setup could not confirm that Copilotix has exited. This operation has stopped to protect background tasks. Exit Copilotix and try again."
LangString copilotixWelcome 2052 "此向导将为当前 Windows 用户安装 Copilotix。$\r$\n$\r$\n您可以选择程序安装位置。文档库的位置在应用的文件存储设置中管理，与安装位置独立。$\r$\n$\r$\n升级或卸载前，请从系统托盘菜单退出 Copilotix，等待后台任务停止。卸载默认保留资料；可在卸载向导中选择同时移除文档库、设置和凭证。"
LangString copilotixWelcome 1028 "此精靈將為目前 Windows 使用者安裝 Copilotix。$\r$\n$\r$\n您可以選擇程式安裝位置。文檔庫的位置在應用程式的文件儲存設定中管理，與安裝位置獨立。$\r$\n$\r$\n升級或解除安裝前，請從系統匣選單退出 Copilotix，等待背景任務停止。解除安裝預設保留資料；可在精靈中選擇同時移除文檔庫、設定和憑證。"
LangString copilotixWelcome 1033 "This wizard installs Copilotix for your current Windows account.$\r$\n$\r$\nYou can choose where the program is installed. Manage the separate document library location in the app's file storage settings.$\r$\n$\r$\nBefore upgrading or uninstalling, choose Exit in the system tray and wait for background tasks to stop. Uninstall keeps your data by default; its wizard offers optional library, settings and credential removal."

!macro customWelcomePage
  !define MUI_WELCOMEPAGE_TEXT "$(copilotixWelcome)"
  !insertmacro MUI_PAGE_WELCOME
!macroend

; Hide the all-users choice even when Setup is started by an administrator.
!macro customInstallMode
  StrCpy $isForceCurrentInstall "1"
!macroend

!macro preInit
  !ifndef BUILD_UNINSTALLER
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "/allusers" $R1
    ${IfNot} ${Errors}
      SetErrorLevel 2
      Quit
    ${EndIf}
  !endif
!macroend

!macro customInit
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  !insertmacro setInstallModePerUser
!macroend

!macro customUnInit
  StrCpy $copilotixRemoveData ${BST_UNCHECKED}
  StrCpy $hasPerMachineInstallation "0"
  StrCpy $hasPerUserInstallation "1"
  ; The uninstaller already knows its own directory (including _?= when called
  ; during upgrades). setInstallModePerUser would replace it with a registry
  ; or default path; after registration removal a retry would leave files.
  StrCpy $installMode CurrentUser
  SetShellVarContext current
!macroend

LangString copilotixUninstallTitle 2052 "文档库与资料"
LangString copilotixUninstallTitle 1028 "文檔庫與資料"
LangString copilotixUninstallTitle 1033 "Library and data"
LangString copilotixUninstallSubtitle 2052 "选择是否同时移除您的 Copilotix 资料。"
LangString copilotixUninstallSubtitle 1028 "選擇是否同時移除您的 Copilotix 資料。"
LangString copilotixUninstallSubtitle 1033 "Choose whether to also remove your Copilotix data."
LangString copilotixUninstallDescription 2052 "默认仅移除程序，保留文档库、设置和已保存凭证，方便之后重新安装。$\r$\n$\r$\n若勾选下方选项，程序会再次显示实际文档库和资料路径，请您确认。仅删除 Copilotix 管理的文档与资料，不删除导入前的源文件。此操作无法撤销。"
LangString copilotixUninstallDescription 1028 "預設僅移除程式，保留文檔庫、設定和已儲存憑證，方便之後重新安裝。$\r$\n$\r$\n若勾選下方選項，程式會再次顯示實際文檔庫和資料路徑，請您確認。僅刪除 Copilotix 管理的文檔與資料，不刪除匯入前的來源檔案。此操作無法復原。"
LangString copilotixUninstallDescription 1033 "By default, only the program is removed. Your library, settings and saved credentials are kept for a later reinstall.$\r$\n$\r$\nIf selected below, Copilotix will show the actual library and data paths for a second confirmation. Only Copilotix-managed documents and data are removed; original imported files are kept. This cannot be undone."
LangString copilotixUninstallCheckbox 2052 "同时移除文档库、设置和已保存凭证"
LangString copilotixUninstallCheckbox 1028 "同時移除文檔庫、設定和已儲存憑證"
LangString copilotixUninstallCheckbox 1033 "Also remove the library, settings and saved credentials"
LangString copilotixCleanupError 2052 "无法完成资料清理，卸载已停止。程序文件仍保留；请确认资料路径可以访问后重试。"
LangString copilotixCleanupError 1028 "無法完成資料清理，解除安裝已停止。程式檔案仍保留；請確認資料路徑可以存取後重試。"
LangString copilotixCleanupError 1033 "Data cleanup could not complete, so uninstall has stopped. Program files are kept. Check access to your data paths and try again."

!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.copilotixDataOptions un.copilotixDataOptionsLeave

  Function un.copilotixDataOptions
    ${If} ${isUpdated}
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "$(copilotixUninstallTitle)" "$(copilotixUninstallSubtitle)"
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    ${NSD_CreateLabel} 0 0 100% 88u "$(copilotixUninstallDescription)"
    Pop $0
    ${NSD_CreateCheckbox} 0 96u 100% 28u "$(copilotixUninstallCheckbox)"
    Pop $copilotixRemoveDataCheckbox
    ${NSD_SetState} $copilotixRemoveDataCheckbox $copilotixRemoveData
    nsDialogs::Show
  FunctionEnd

  Function un.copilotixDataOptionsLeave
    ${NSD_GetState} $copilotixRemoveDataCheckbox $copilotixRemoveData
  FunctionEnd
!macroend

; Cleanup runs before builder removes program files. Upgrades and silent
; uninstall never delete user data. The helper asks for a second confirmation.
!macro customUnInstall
  ${IfNot} ${Silent}
  ${AndIfNot} ${isUpdated}
  ${AndIf} $copilotixRemoveData == ${BST_CHECKED}
    ClearErrors
    ExecWait '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" --copilotix-uninstall-cleanup --lang=$LANGUAGE' $R0
    ${If} ${Errors}
      MessageBox MB_OK|MB_ICONSTOP "$(copilotixCleanupError)"
      SetErrorLevel 1
      Quit
    ${EndIf}
    ${If} $R0 != 0
      SetErrorLevel $R0
      Quit
    ${EndIf}
  ${EndIf}
!macroend

; nsProcess searches by executable name, so the ZIP edition is guarded too.
; 0 = running; 603 = no matching process; all other results fail closed.
; Anonymous LogicLib loops permit expansion in installer and uninstaller.
!macro customCheckAppRunning
  ${Do}
    ${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0
    ${If} $R0 == 603
      ${ExitDo}
    ${EndIf}
    ${If} ${Silent}
      SetErrorLevel 2
      Quit
    ${EndIf}
    ${If} $R0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$(copilotixProcessError)"
      SetErrorLevel 2
      Quit
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "$(copilotixRunning)" /SD IDCANCEL IDRETRY +3
    SetErrorLevel 2
    Quit
  ${Loop}
!macroend
