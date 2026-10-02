import { describe, expect, it } from 'vitest'
import { registeredUninstallerPath, nsisDefine, buildStandaloneUninstaller } from '../scripts/build-uninstall-launcher.mjs'

describe('standalone registered uninstall entry', () => {
  it.each(['uninstall.exe', 'Uninstall Copilotix.exe'])('finds only the registered %s in a custom Unicode path', (name) => {
    const root = 'C:\\使用者\\program files\\Copilotix'
    expect(registeredUninstallerPath(root, `"${root}\\${name}" /currentuser`)).toBe(`${root}\\${name}`)
  })
  it.each([
    ['relative\\Copilotix', '"relative\\Copilotix\\uninstall.exe"'],
    ['C:\\', '"C:\\uninstall.exe"'],
    ['C:\\app\\..\\Copilotix', '"C:\\app\\..\\Copilotix\\uninstall.exe"'],
    ['C:\\Copilotix', 'cmd.exe /c del C:\\Copilotix'],
    ['C:\\Copilotix', '"C:\\Other\\uninstall.exe" /currentuser'],
    ['C:\\Copilotix', '"C:\\Copilotix\\uninstall.exe" /S'],
    ['C:\\Copilotix', '"C:\\Copilotix\\uninstall.exe" /allusers'],
  ])('rejects unsafe registration %s', (root, command) => {
    expect(registeredUninstallerPath(root, command)).toBeNull()
  })
  it('rejects NSIS directive injection', () => {
    expect(() => nsisDefine('OUTPUT_PATH', 'C:\\out$INSTDIR\\uninstall.exe')).toThrow('Unsafe NSIS')
    expect(() => nsisDefine('OUTPUT_PATH', 'C:\\out\n!system del')).toThrow('Unsafe NSIS')
  })
  it('requires a trusted production signer before invoking any compiler', async () => {
    await expect(buildStandaloneUninstaller({ outputPath: 'C:\\output\\uninstall.exe', productionRelease: true })).rejects.toThrow(/Production uninstaller|requires Windows/u)
  })
})
