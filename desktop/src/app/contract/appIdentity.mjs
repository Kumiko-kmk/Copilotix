/**
 * Everything that makes an installation a separate product. Shared with the packaging scripts.
 * The full edition's values are in use on people's machines: changing one orphans their data,
 * saved keys or installation. installGuid is what electron-builder derives from appId.
 */
export const FULL_IDENTITY = Object.freeze({
  appId: 'com.kumiko.copilotix.translation',
  productName: 'Copilotix',
  executableName: 'Copilotix',
  userDataFolder: 'Copilotix-Translation-v2',
  credentialService: 'Copilotix-Translation',
  documentsFolder: 'Copilotix',
  installGuid: '14328922-5660-531d-8d5f-b169b5a958e0',
  releaseDirectory: 'release'
})

export const LITE_IDENTITY = Object.freeze({
  version: '1.0.0',
  appId: 'com.kumiko.copilotix.lite',
  productName: 'Copilotix Lite',
  executableName: 'CopilotixLite',
  userDataFolder: 'Copilotix-Lite',
  credentialService: 'Copilotix-Lite',
  documentsFolder: 'Copilotix Lite',
  installGuid: '0bd267d6-26a7-540d-9caf-eeda2860585f',
  releaseDirectory: 'release-lite'
})
