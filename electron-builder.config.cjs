const formal = process.env.CHAT_BOT_FORMAL === '1';
module.exports = {
  appId: 'io.github.bapple666.chatbot', productName: 'chat-bot',
  extraMetadata: { version: require('./package.json').version, chatBotReleaseChannel: formal ? 'stable' : 'internal' },
  directories: { app: 'desktop-app', output: 'artifacts/desktop', buildResources: 'desktop-app' },
  files: ['main.cjs', 'preload.cjs', 'components.cjs', 'renderer.html', 'renderer.css', 'renderer.js', 'icon.png', 'package.json'],
  extraResources: [{ from: '.cache/desktop/backend', to: 'backend' }, { from: '.cache/desktop/backend/node_modules', to: 'backend/node_modules' }, { from: '.cache/desktop/node', to: 'node' }],
  afterPack: async context => {
    const { assertPackagedDependencies } = await import('./scripts/assert-packaged-dependencies.mjs');
    assertPackagedDependencies(require('node:path').join(context.packager.getResourcesDir(context.appOutDir), 'backend'));
  },
  asar: true, npmRebuild: false, forceCodeSigning: formal,
  electronDist: require('node:path').join(require('node:path').dirname(require.resolve('electron/package.json')), 'dist'),
  artifactName: 'chat-bot-${version}-${os}-${arch}.${ext}',
  publish: [{ provider: 'github', owner: 'superapple180-arch', repo: 'chat-bot', releaseType: 'draft', channel: `latest-${process.platform}-${process.arch}` }],
  win: { target: [{ target: 'nsis', arch: ['x64'] }], icon: 'desktop-app/icon.png' },
  nsis: { oneClick: false, allowToChangeInstallationDirectory: true, perMachine: false, allowElevation: false, deleteAppDataOnUninstall: false, include: 'desktop-app/uninstaller.nsh' },
  mac: { target: ['dmg', 'zip'], icon: 'desktop-app/icon.png', category: 'public.app-category.social-networking', minimumSystemVersion: '13.5', hardenedRuntime: true, notarize: formal, binaries: ['Contents/Resources/node/bin/node'] },
  linux: { target: ['AppImage', 'deb'], icon: 'desktop-app/icon.png', category: 'Network', maintainer: 'chat-bot contributors <chat-bot@users.noreply.github.com>', synopsis: '非商业 QQ 聊天助手', executableName: 'chat-bot' }
};
