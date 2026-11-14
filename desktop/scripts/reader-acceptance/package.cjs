const { resolve } = require('node:path')
module.exports = {
  appId: 'com.copilotix.reader.acceptance.20261031', productName: 'Copilotix Reader Acceptance',
  executableName: 'CopilotixReader', asar: true,
  directories: { app: resolve(__dirname, '../../../output/reader-acceptance-20261031/app'), output: resolve(__dirname, '../../../output/reader-acceptance-20261031/package') },
  electronDist: resolve(__dirname, '../../node_modules/electron/dist'), electronVersion: '44.1.1',
  npmRebuild: false,
  files: ['main.cjs', 'renderer/**', 'paper/**', 'package.json', 'LICENSE.md', '!node_modules/**'],
  win: { target: ['portable'], icon: resolve(__dirname, '../../resources/icon.ico'), signAndEditExecutable: false },
  portable: { artifactName: 'CopilotixReader-Acceptance.exe' },
  electronLanguages: ['zh-TW', 'en-US'], compression: 'normal'
}
