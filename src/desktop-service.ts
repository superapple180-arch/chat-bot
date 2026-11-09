import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createWebServer } from './web-server.js';
import { Supervisor } from './web-supervisor.js';
import { setWebPassword } from './web-auth.js';
import { readConfig } from './config.js';
import { migrateLegacyConfig, saveOneBotToken, configuredOneBotToken, withoutToken } from './secrets.js';
import { codePath, componentPath } from './paths.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const root = process.env.QQ_BOT_DATA_ROOT;
if (!root || !process.connected) throw Error('DESKTOP_IPC_REQUIRED');
fs.mkdirSync(root, { recursive: true }); process.chdir(root);
const stateFile = path.join(root, 'state/desktop.json');
const readState = () => fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const previous = readState();
function writeState(value: object) {
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(value), { mode: 0o600 }); fs.renameSync(stateFile + '.tmp', stateFile);
}
writeState({ cleanExit: false, restoreRunning: false });
const supervisor = new Supervisor(root, codePath());
let app: Awaited<ReturnType<typeof createWebServer>>['app'] | undefined;
let startNapcat: (() => Promise<unknown>) | undefined;
let clean = false, queue = Promise.resolve();
function managementOrigin() {
  const address = app?.server.address();
  return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : undefined;
}
async function configureRemote() {
  const executable = process.platform === 'win32' ? path.join(process.env.ProgramFiles ?? 'C:/Program Files', 'Tailscale/tailscale.exe') : process.platform === 'darwin' ? '/Applications/Tailscale.app/Contents/MacOS/Tailscale' : 'tailscale';
  const run = promisify(execFile);
  const { stdout } = await run(executable, ['status', '--json'], { windowsHide: true, timeout: 15000 });
  const name = JSON.parse(stdout).Self?.DNSName;
  if (typeof name !== 'string' || !/^[a-z0-9.-]+\.ts\.net\.$/i.test(name)) throw Error('TAILSCALE_LOGIN_REQUIRED');
  await run(executable, ['serve', '--bg', '--yes', managementOrigin()!], { windowsHide: true, timeout: 30000 });
  fs.writeFileSync('state/web-access.json', JSON.stringify({ remoteOrigin: 'https://' + name.slice(0, -1) }), { mode: 0o600 });
}
async function start() {
  if (app) return;
  migrateLegacyConfig(path.join(root!, 'config.local.json'));
  readConfig(path.join(root!, 'config.local.json'));
  const server = await createWebServer(root!, supervisor);
  startNapcat = server.startNapcat;
  const port = process.env.CHAT_BOT_SERVICE_TEST === '1' ? Number(process.env.CHAT_BOT_SERVICE_TEST_PORT ?? 0) : 3210;
  try {
    try { await server.app.listen({ host: '127.0.0.1', port }); }
    catch (e: any) {
      if (!port || !['EADDRINUSE', 'EACCES'].includes(e.code)) throw e;
      await server.app.listen({ host: '127.0.0.1', port: 0 });
    }
  } catch (e) { await server.app.close(); throw e; }
  app = server.app;
  if (fs.existsSync('state/web-access.json')) {
    try { await configureRemote(); }
    catch { supervisor.logs.push({ at: new Date().toISOString(), category: 'STARTUP', code: 'PRIVATE_ACCESS_REFRESH_FAILED' }); }
  }
  if (process.env.CHAT_BOT_SERVICE_TEST !== '1' && previous.cleanExit === true && previous.restoreRunning === true) {
    try {
      try { await startNapcat!(); } catch (e: any) { if (!['NAPCAT_ALREADY_RUNNING', 'NAPCAT_START_ALREADY_REQUESTED'].includes(e.code)) throw e; }
      await supervisor.start(true);
    }
    catch { supervisor.logs.push({ at: new Date().toISOString(), category: 'STARTUP', code: 'AUTO_RESTORE_FAILED_REMAIN_PAUSED' }); }
  }
}
async function setup(input: any) {
  if (fs.existsSync('config.local.json')) throw Error('ALREADY_CONFIGURED');
  if (!input || !/^[1-9]\d{4,19}$/.test(input.selfId) || typeof input.password !== 'string' || input.password !== input.confirm) throw Error('INVALID_SETUP');
  if (!fs.existsSync(componentPath('voice-ready.json')) || !fs.existsSync(componentPath('antigravity', process.platform === 'win32' ? 'agy.exe' : 'agy'))) throw Error('PREPARE_COMPONENTS_FIRST');
  const config = JSON.parse(fs.readFileSync(codePath('config.antigravity.example.json'), 'utf8'));
  config.onebot.selfId = input.selfId;
  const configuredToken = configuredOneBotToken(root!);
  config.onebot.accessToken = configuredToken ?? randomBytes(32).toString('hex');
  config.antigravity.executable = componentPath('antigravity', process.platform === 'win32' ? 'agy.exe' : 'agy');
  config.attachments.localRoots = []; config.realSend = false;
  const directory = process.platform === 'darwin'
    ? path.join(process.env.HOME!, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config')
    : componentPath('napcat', process.platform === 'win32' ? 'napcat/config' : 'config');
  const accountFile = path.join(directory, `onebot11_${input.selfId}.json`);
  if (fs.existsSync(accountFile)) {
    const existing = JSON.parse(fs.readFileSync(accountFile, 'utf8'));
    const endpoint = existing.network?.websocketServers?.find((item: any) => item.enable === true && item.host === '127.0.0.1' && item.port === 3001 && item.messagePostFormat === 'array' && item.reportSelfMessage === false);
    if (!endpoint || typeof endpoint.token !== 'string' || endpoint.token.length < 16 || /[\r\n]/.test(endpoint.token) || endpoint.token.includes('REPLACE')) throw Error('EXISTING_NAPCAT_CONFIG_REQUIRES_MANUAL_SETUP');
    if (configuredToken !== undefined && configuredToken !== endpoint.token) throw Error('EXISTING_NAPCAT_TOKEN_MISMATCH');
    config.onebot.accessToken = endpoint.token;
  }
  await setWebPassword('state/web-auth.json', input.password);
  try {
    saveOneBotToken(root!, config.onebot.accessToken);
    fs.writeFileSync('config.local.json', JSON.stringify(withoutToken(config), null, 2), { mode: 0o600, flag: 'wx' });
    for (const kind of ['voice', 'media']) {
      fs.mkdirSync(`assets/${kind}`, { recursive: true });
      if (!fs.existsSync(`assets/${kind}/index.json`)) fs.writeFileSync(`assets/${kind}/index.json`, '[]\n', { flag: 'wx' });
    }
    fs.mkdirSync(directory, { recursive: true });
    const onebot = { network: { httpServers: [], httpClients: [], websocketClients: [], websocketServers: [{ name: 'chat-bot-local', enable: true, host: '127.0.0.1', port: 3001, messagePostFormat: 'array', reportSelfMessage: false, token: config.onebot.accessToken, enableForcePushEvent: true, debug: false, heartInterval: 30000 }] }, musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false };
    if (!fs.existsSync(accountFile)) fs.writeFileSync(accountFile, JSON.stringify(onebot), { mode: 0o600, flag: 'wx' });
    const webuiFile = path.join(directory, 'webui.json');
    if (!fs.existsSync(webuiFile)) fs.writeFileSync(webuiFile, JSON.stringify({ host: '127.0.0.1', port: 6099, token: randomBytes(32).toString('hex'), loginRate: 3 }), { mode: 0o600, flag: 'wx' });
  } catch (error) {
    fs.rmSync('config.local.json', { force: true }); fs.rmSync('state/web-auth.json', { force: true }); throw error;
  }
  await start(); return { configured: true };
}
async function stop() {
  const { restore } = supervisor.status.running ? await supervisor.call('drain') : { restore: false };
  if (app) { await app.close(); app = undefined; }
  writeState({ cleanExit: true, restoreRunning: restore === true }); clean = true;
  return { stopped: true };
}
const send = (message: object) => { if (process.connected) process.send?.(message); };
process.on('message', (m: any) => {
  queue = queue.then(async () => {
    try {
      let result: unknown;
      switch (m.action) {
        case 'status': result = { configured: fs.existsSync('config.local.json'), ...supervisor.status, origin: managementOrigin() }; break;
        case 'setup': result = await setup(m.payload); break;
        case 'start': await start(); result = { configured: true }; break;
        case 'qq':
          await start();
          try { await startNapcat!(); } catch (e: any) { if (!['NAPCAT_ALREADY_RUNNING', 'NAPCAT_START_ALREADY_REQUESTED'].includes(e.code)) throw e; }
          result = { opened: true }; break;
        case 'remote': {
          await start(); await configureRemote();
          result = { configured: true }; break;
        }
        case 'stop': result = await stop(); break;
        default: throw Error('UNKNOWN_DESKTOP_ACTION');
      }
      send({ id: m.id, result });
    } catch (e: any) { send({ id: m.id, error: e.code === 'EADDRINUSE' ? 'MANAGEMENT_PORT_IN_USE' : e.code === 'EACCES' ? 'LOCAL_ACCESS_DENIED' : e instanceof Error && /^[A-Z_0-9]+$/.test(e.message) ? e.message : 'DESKTOP_SERVICE_FAILED' }); }
  });
});
process.on('disconnect', () => { if (!clean) { supervisor.disconnect(); void app?.close().finally(() => process.exit(0)); } else process.exit(0); });
send({ ready: true, configured: fs.existsSync('config.local.json') });
