import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const desktopRoot = resolve(import.meta.dirname, '..')
const packageJson = JSON.parse(readFileSync(resolve(desktopRoot, 'package.json'), 'utf8'))
const installer = readFileSync(resolve(desktopRoot, packageJson.build.nsis.include), 'utf8').replace(/\r\n/g, '\n')
const require = createRequire(import.meta.url)
const builderRoot = dirname(require.resolve('app-builder-lib/package.json', {
  paths: [dirname(require.resolve('electron-builder/package.json'))]
}))

describe('Windows installer safety policy', () => {
  it('offers a desktop shortcut checkbox selected by default and honors opting out', () => {
    expect(packageJson.version).toBe('1.0.0')
    expect(installer).toContain('StrCpy $copilotixDesktopShortcut ${BST_CHECKED}')
    expect(installer).toContain('Page custom copilotixInstallOptions copilotixInstallOptionsLeave')
    expect(installer).toContain('${NSD_SetState} $copilotixDesktopShortcutCheckbox $copilotixDesktopShortcut')
    expect(installer).toContain('${NSD_GetState} $copilotixDesktopShortcutCheckbox $copilotixDesktopShortcut')
    const install = installer.match(/!macro customInstall\n([\s\S]*?)!macroend/u)?.[1]
    expect(install).toContain('${IfNot} ${Silent}')
    expect(install).toContain('${AndIfNot} ${isUpdated}')
    expect(install).toContain('${AndIf} $copilotixDesktopShortcut == ${BST_UNCHECKED}')
    expect(install).toContain('Delete "$newDesktopLink"')
  })
  it('offers explicit data cleanup only for interactive removal before binaries are deleted', () => {
    expect(installer).toContain('!define UNINSTALL_FILENAME "uninstall.exe"')
    expect(installer).toContain('UninstPage custom un.copilotixDataOptions un.copilotixDataOptionsLeave')
    expect(installer).toContain('StrCpy $copilotixRemoveData ${BST_UNCHECKED}')
    const cleanup = installer.match(/!macro customUnInstall\n([\s\S]*?)!macroend/u)?.[1]
    expect(cleanup).toContain('${IfNot} ${Silent}')
    expect(cleanup).toContain('${AndIfNot} ${isUpdated}')
    expect(cleanup).toContain('${AndIf} $copilotixRemoveData == ${BST_CHECKED}')
    expect(cleanup).toContain('--copilotix-uninstall-cleanup --lang=$LANGUAGE')
    expect(cleanup).toMatch(/\$R0 != 0\s+SetErrorLevel \$R0\s+Quit/u)
    expect(cleanup).not.toContain('RMDir')
    const builderUninstaller = readFileSync(resolve(builderRoot, 'templates/nsis/uninstaller.nsh'), 'utf8')
    expect(builderUninstaller.indexOf('!insertmacro customUnInstall')).toBeLessThan(builderUninstaller.indexOf('# delete the installed files'))
  })
  it('keeps the application identity and guided user-only installation contract', () => {
    expect(packageJson.build.appId).toBe('com.kumiko.copilotix.translation')
    expect(packageJson.build.nsis).toMatchObject({
      oneClick: false, perMachine: false, allowElevation: false,
      allowToChangeInstallationDirectory: true, deleteAppDataOnUninstall: false,
      createDesktopShortcut: true, createStartMenuShortcut: true
    })
    expect(packageJson.build.nsis.artifactName).toBe('setup.exe')
    expect(installer).toMatch(/!macro customInstallMode\s+StrCpy \$isForceCurrentInstall "1"/u)
    expect(installer).toMatch(/!macro customInit[\s\S]*?!insertmacro setInstallModePerUser/u)
    const uninit = installer.match(/!macro customUnInit([\s\S]*?)!macroend/u)?.[1]
    expect(uninit).toContain('StrCpy $installMode CurrentUser')
    expect(uninit).toContain('SetShellVarContext current')
    expect(uninit).not.toContain('!insertmacro setInstallModePerUser')
    expect(uninit).not.toMatch(/StrCpy \$INSTDIR/u)
  })

  it('overrides the installed builder hook before its dangerous default is expanded', () => {
    const hook = readFileSync(resolve(builderRoot, 'templates/nsis/include/allowOnlyOneInstallerInstance.nsh'), 'utf8')
    const target = readFileSync(resolve(builderRoot, 'out/targets/nsis/NsisTarget.js'), 'utf8')
    expect(target).toContain('scriptGenerator.include(customInclude)')
    // Builder 26 signs the uninstaller automatically; no signUninstaller option.
    expect(target).toContain('await packager.signIf(uninstallerPath)')
    expect(hook).toMatch(/!ifmacrodef customCheckAppRunning\s+!insertmacro customCheckAppRunning\s+!else/u)
    expect(installer).toContain('!macro customCheckAppRunning')
    expect(installer).toContain('${nsProcess::FindProcess} "${APP_EXECUTABLE_FILENAME}" $R0')
    expect(installer).not.toMatch(/(?:taskkill|Stop-Process|KillProcess|CloseProcess|KILL_PROCESS)/u)
    expect(installer).toMatch(/\$R0 == 603\s+\$\{ExitDo\}/u)
    expect(installer).toMatch(/\$\{If\} \$\{Silent\}\s+SetErrorLevel 2\s+Quit/u)
  })

  it('ships a real multiresolution ICO based on the application branding', () => {
    const icon = readFileSync(resolve(desktopRoot, packageJson.build.win.icon))
    expect(icon.readUInt16LE(0)).toBe(0)
    expect(icon.readUInt16LE(2)).toBe(1)
    const count = icon.readUInt16LE(4)
    expect(count).toBeGreaterThanOrEqual(6)
    const widths = []
    for (let index = 0; index < count; index++) {
      const entry = 6 + index * 16
      widths.push(icon[entry] || 256)
      const bytes = icon.readUInt32LE(entry + 8)
      const offset = icon.readUInt32LE(entry + 12)
      expect(bytes).toBeGreaterThan(0)
      expect(offset + bytes).toBeLessThanOrEqual(icon.length)
    }
    expect(widths).toEqual(expect.arrayContaining([16, 32, 48, 256]))
  })
})
