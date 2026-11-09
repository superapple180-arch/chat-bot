const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, nativeImage, net } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { fork, spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const components = require('./components.cjs');
const smoke = process.argv.includes('--smoke-test');
if (smoke) {
  if (!process.env.CHAT_BOT_SMOKE_ROOT) throw Error('SMOKE_ROOT_REQUIRED');
  app.setPath('userData', path.resolve(process.env.CHAT_BOT_SMOKE_ROOT));
}
app.setName('chat-bot');
let origin;
let window, tray, service, quitting = false, updates, updateReady = false, quitTask;
let prepared;
const pending = new Map();
const codeRoot = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
const node = app.isPackaged ? path.join(process.resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'bin/node') : path.join(codeRoot, 'runtime', process.platform === 'win32' ? 'node.exe' : 'bin/node');
const bootstrap = pathToFileURL(path.join(__dirname, 'renderer.html')).href;
const dataRoot = app.getPath('userData'), componentRoot = path.join(dataRoot, 'components');
let qqWindow;
async function openQQ() {
  await call('qq');
  const directory = process.platform === 'darwin' ? path.join(app.getPath('home'), 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config') : path.join(componentRoot, 'napcat', process.platform === 'win32' ? 'napcat/config' : 'config');
  const { token } = JSON.parse(fs.readFileSync(path.join(directory, 'webui.json'), 'utf8'));
  if (typeof token !== 'string' || !token) throw Error('NAPCAT_LOGIN_CONFIG_REQUIRED');
  if (qqWindow && !qqWindow.isDestroyed()) { qqWindow.show(); return { opened: true }; }
  qqWindow = new BrowserWindow({ width: 1050, height: 780, title: 'QQ 扫码登录', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  qqWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  qqWindow.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== 'http://127.0.0.1:6099') event.preventDefault(); });
  for (let attempt = 0; attempt < 40; attempt++) {
    try { await qqWindow.loadURL('http://127.0.0.1:6099/webui?token=' + encodeURIComponent(token)); return { opened: true }; } catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  throw Error('NAPCAT_LOGIN_NOT_READY');
}
function emit(text) { if (window && !window.isDestroyed()) window.webContents.send('desktop-status', { text }); }
async function openManagement() {
  const status = await call('status');
  if (!/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(status.origin ?? '') || new URL(status.origin).port > 65535) throw Error('MANAGEMENT_NOT_READY');
  origin = status.origin;
  window.webContents.send('desktop-status', { text: '正在打开管理台', leaving: true });
  await new Promise(resolve => setTimeout(resolve, 180)); await window.loadURL(origin);
}
function safeError(error) { return error && /^[A-Z][A-Z_0-9]+$/.test(error.message) ? error.message : 'OPERATION_FAILED'; }
function call(action, payload) {
  return new Promise((resolve, reject) => {
    if (!service?.connected) return reject(Error('BACKEND_UNAVAILABLE'));
    const id = randomUUID(), timer = setTimeout(() => { pending.delete(id); reject(Error('BACKEND_TIMEOUT')); }, 320000);
    pending.set(id, { resolve, reject, timer }); service.send({ id, action, payload });
  });
}
function launchService() {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(node)) return reject(Error('BUNDLED_NODE_MISSING'));
    fs.mkdirSync(dataRoot, { recursive: true });
    service = fork(path.join(codeRoot, 'dist/desktop-service.js'), [], { cwd: dataRoot, execPath: node, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, QQ_BOT_CODE_ROOT: codeRoot, QQ_BOT_DATA_ROOT: dataRoot, QQ_BOT_COMPONENT_ROOT: componentRoot, QQ_BOT_DESKTOP: '1', CHAT_BOT_SERVICE_TEST: smoke ? '1' : '0' } });
    const timer = setTimeout(() => reject(Error('BACKEND_START_TIMEOUT')), 15000);
    service.on('message', m => {
      if (m.ready) { clearTimeout(timer); resolve(m); }
      const item = pending.get(m.id); if (!item) return;
      clearTimeout(item.timer); pending.delete(m.id); m.error ? item.reject(Error(m.error)) : item.resolve(m.result);
    });
    const ended = () => { clearTimeout(timer); reject(Error('BACKEND_EXITED')); for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('BACKEND_EXITED')); } pending.clear(); if (!quitting) emit('后台服务已退出 请重新启动应用'); };
    service.once('error', ended); service.once('exit', ended);
  });
}
async function stop() {
  if (service?.connected) { await call('stop'); service.disconnect(); }
}
async function quit(install = false) {
  if (quitTask) return quitTask;
  quitTask = (async () => {
    emit('正在等待任务结束'); await stop(); quitting = true;
    if (install) updates.quitAndInstall(false, true); else app.quit();
  })().catch(error => { quitTask = undefined; emit(safeError(error)); throw error; });
  return quitTask;
}
function setupUpdates() {
  if (!app.isPackaged || smoke || require('./package.json').chatBotReleaseChannel !== 'stable') return;
  updates = require('electron-updater').autoUpdater;
  updates.autoDownload = true; updates.autoInstallOnAppQuit = false; updates.allowPrerelease = false;
  updates.channel = `latest-${process.platform}-${process.arch}`; updates.allowDowngrade = false;
  updates.on('update-available', () => emit('发现新版本 正在下载'));
  updates.on('download-progress', p => emit(`更新已下载 ${Math.floor(p.percent)}%`));
  updates.on('update-downloaded', () => { updateReady = true; emit('更新已就绪 可从应用菜单选择重启安装'); });
  updates.on('error', () => emit('更新检查未完成 当前版本可继续使用'));
  void updates.checkForUpdates().catch(() => {});
  const timer = setInterval(() => void updates.checkForUpdates().catch(() => {}), 6 * 3600000); timer.unref();
}
async function installUpdate() {
  if (!updateReady) throw Error('UPDATE_NOT_READY');
  const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['取消', '重启安装'], defaultId: 0, cancelId: 0, message: '等待当前任务结束后重启安装更新', detail: '配置与聊天数据会保留 发送结果不明的任务不会自动重发' });
  if (response === 1) await quit(true);
}
async function clearData() {
  const { response } = await dialog.showMessageBox(window, { type: 'warning', buttons: ['保留数据', '清除应用数据并退出'], defaultId: 0, cancelId: 0, message: '卸载与数据清理', detail: '清除本应用的配置 聊天记忆和下载组件 macOS 外部 QQ 与模型服务历史需要在相应软件中管理' });
  if (response !== 1) return { cleared: false };
  await stop();
  const resolved = path.resolve(dataRoot);
  if (resolved !== path.resolve(app.getPath('userData')) || resolved === path.parse(resolved).root) throw Error('INVALID_DATA_ROOT');
  // Close Chromium before deletion so its profile files are no longer locked.
  quitting = true; window.destroy();
  app.once('will-quit', () => {
    const script = path.join(codeRoot, 'scripts/clear-desktop-data.mjs');
    spawn(node, [script, resolved, resolved], { cwd: path.dirname(resolved), windowsHide: true, detached: true, stdio: 'ignore' }).unref();
  }); app.quit(); return { cleared: true };
}
async function modelLogin() {
  const agy = path.join(componentRoot, 'antigravity', process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (!fs.existsSync(agy)) throw Error('PREPARE_COMPONENTS_FIRST');
  const cwd = path.join(dataRoot, 'state/antigravity-workspace'); fs.mkdirSync(cwd, { recursive: true });
  if (process.platform === 'win32') {
    const literal = x => "'" + x.replaceAll("'", "''") + "'";
    const encoded = Buffer.from(`Set-Location -LiteralPath ${literal(cwd)}; & ${literal(agy)}`, 'utf16le').toString('base64');
    spawn('powershell.exe', ['-NoProfile', '-Command', `Start-Process powershell.exe -WindowStyle Normal -ArgumentList '-NoProfile','-NoExit','-EncodedCommand','${encoded}'`], { windowsHide: true, stdio: 'ignore' }).on('error', () => emit('模型登录窗口未能打开'));
  } else if (process.platform === 'darwin') {
    const quote = x => "'" + x.replaceAll("'", "'\\''") + "'";
    execFile('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(`cd ${quote(cwd)} && ${quote(agy)}`)}`], () => {});
  } else spawn('x-terminal-emulator', ['-e', agy], { cwd, detached: true, stdio: 'ignore' }).on('error', () => emit('请安装系统终端后重试模型登录')).unref();
  return { opened: true };
}
function menus() {
  const template = [
    { label: '打开 chat-bot', click: () => { window.show(); window.focus(); } },
    { label: '首次配置与组件', click: () => void window.loadURL(bootstrap) },
    { label: '模型登录', click: () => void modelLogin().catch(e => emit(safeError(e))) },
    { label: 'QQ 扫码登录', click: () => void openQQ().catch(e => emit(safeError(e))) },
    { label: '配置私人远程访问', click: () => void call('remote').then(() => emit('私人访问已配置 请重新打开连接与诊断')).catch(() => { emit('请先安装并登录 Tailscale 然后重试'); void shell.openExternal('https://tailscale.com/download'); }) },
    { label: '检查更新', click: () => updates ? void updates.checkForUpdates().catch(() => {}) : emit('开发或内测构建尚未接入正式更新源') },
    { label: '重启安装更新', click: () => void installUpdate().catch(e => emit(safeError(e))) },
    { label: '卸载与数据清理', click: () => void clearData().catch(e => emit(safeError(e))) },
    { type: 'separator' }, { label: '退出', click: () => void quit().catch(e => emit(safeError(e))) }
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'chat-bot', submenu: template }, { role: 'editMenu' }, { role: 'viewMenu' }]));
}
async function main() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'icon.png'));
  window = new BrowserWindow({ width: 1360, height: 900, minWidth: 920, minHeight: 680, show: false, title: 'chat-bot', icon, backgroundColor: '#ffffff', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  tray = new Tray(process.platform === 'darwin' ? icon.resize({ width: 20, height: 20 }) : icon); tray.setToolTip('chat-bot'); tray.on('click', () => { window.show(); window.focus(); }); menus();
  window.on('close', e => { if (!quitting) { e.preventDefault(); window.hide(); } });
  const external = url => { try { const u = new URL(url); if (['https:', 'http:'].includes(u.protocol) && !u.username && !u.password) void shell.openExternal(url); } catch {} };
  window.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  window.webContents.on('will-navigate', (event, url) => { if (url !== bootstrap && new URL(url).origin !== origin) { event.preventDefault(); external(url); } });
  ipcMain.handle('chat-bot', async (event, action, payload) => {
    const url = event.senderFrame?.url;
    if (event.sender !== window.webContents || !(url === bootstrap || origin && url?.startsWith(origin + '/'))) throw Error('INVALID_DESKTOP_SENDER');
    try {
      switch (action) {
        case 'status': return { ...await call('status'), platform: process.platform, componentsReady: fs.existsSync(path.join(componentRoot, 'voice-ready.json')) };
        case 'prepare': prepared = await components.prepare(componentRoot, codeRoot, emit, net.fetch); return { ready: true };
        case 'setup': await call('setup', payload); await openManagement(); return { configured: true };
        case 'open': await call('start'); await openManagement(); return { opened: true };
        case 'modelLogin': return modelLogin();
        case 'macInstaller': {
          if (process.platform !== 'darwin' || !prepared?.macInstaller) throw Error('PREPARE_COMPONENTS_FIRST');
          await shell.openPath(path.resolve(prepared.macInstaller, '../../..')); return { opened: true };
        }
        case 'qq': return openQQ();
        case 'remote': return call('remote');
        case 'checkUpdate': if (updates) await updates.checkForUpdates(); else throw Error('UPDATE_FEED_NOT_READY'); return { checked: true };
        case 'installUpdate': await installUpdate(); return { requested: true };
        case 'clearData': return clearData();
        default: throw Error('UNKNOWN_DESKTOP_ACTION');
      }
    } catch (e) { return { error: safeError(e) }; }
  });
  await window.loadURL(bootstrap); window.show();
  const status = await launchService();
  emit(status.configured ? '已检测到本机配置' : '本机服务已就绪');
  if (status.configured) { await call('start'); await openManagement(); }
  setupUpdates();
  if (smoke) {
    await new Promise(resolve => setTimeout(resolve, 1500));
    fs.writeFileSync(path.join(dataRoot, 'first-run.png'), (await window.webContents.capturePage()).toPNG());
    await quit();
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.on('activate', () => { window?.show(); window?.focus(); });
  app.on('before-quit', e => { if (!quitting) { e.preventDefault(); void quit().catch(error => emit(safeError(error))); } });
  app.whenReady().then(main).catch(async error => { if (smoke) { fs.mkdirSync(dataRoot, { recursive: true }); fs.writeFileSync(path.join(dataRoot, 'error.txt'), safeError(error)); } else await dialog.showMessageBox({ type: 'error', message: 'chat-bot 未能启动', detail: safeError(error) }); quitting = true; service?.kill(); app.exit(1); });
}
