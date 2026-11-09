import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { assertPackagedDependencies } from './assert-packaged-dependencies.mjs';
import { withoutToken } from '../dist/secrets.js';
const resources = path.resolve(process.argv[2]), backend = path.join(resources, 'backend');
assertPackagedDependencies(backend);
const require = createRequire(path.join(backend, 'package.json'));
const { WebSocketServer } = require('ws');
fs.mkdirSync('.cache', { recursive: true });
const root = fs.mkdtempSync(path.resolve('.cache/packaged-backend-'));
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(resolve => server.on('listening', resolve));
let sends = 0;
server.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(raw);
  if (!['get_status', 'get_login_info'].includes(message.action)) { sends++; socket.close(); return; }
  socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: message.action === 'get_login_info' ? { user_id: 900000001, nickname: '合成打包测试' } : { online: true, good: true } }));
}));
const config = JSON.parse(fs.readFileSync(path.join(backend, 'config.antigravity.example.json')));
config.onebot = { ...config.onebot, selfId: '900000001', accessToken: 'synthetic-' + randomBytes(16).toString('hex'), url: `ws://127.0.0.1:${server.address().port}` };
config.antigravity.executable = process.execPath;
fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + config.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(root, 'config.local.json'), JSON.stringify(withoutToken(config)));
const worker = fork(path.join(backend, 'dist/web-worker.js'), [], { cwd: root, execPath: process.execPath, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, QQ_BOT_CODE_ROOT: backend, QQ_BOT_DATA_ROOT: root, QQ_BOT_COMPONENT_ROOT: path.join(root, 'components'), QQ_BOT_AUTO_RUN: '0' } });
let ready = false, connected = false, failure;
worker.on('message', message => { if (message.type === 'ready') ready = true; if (message.type === 'startup-error') failure = message.error; if (message.type === 'status') connected = message.value.onebotConnected === true && message.value.paused === true; });
const exited = new Promise(resolve => worker.once('exit', resolve));
try {
  const end = Date.now() + 15000;
  while (!failure && !(ready && connected) && Date.now() < end) await delay(50);
  if (failure || !ready || !connected || sends) throw Error('PACKAGED_BACKEND_SMOKE_FAILED');
  worker.send({ id: 'synthetic-stop', action: 'stop' });
  if (await exited !== 0) throw Error('PACKAGED_BACKEND_EXIT_FAILED');
  console.log(JSON.stringify({ packagedNode: process.version, workerReady: ready, syntheticOneBotConnected: connected, realQQCalls: 0, sends }));
} finally {
  if (worker.exitCode === null) { worker.kill(); await exited; }
  for (const client of server.clients) client.terminate();
  await new Promise(resolve => server.close(resolve));
  if (path.dirname(root) !== path.resolve('.cache')) throw Error('INVALID_SMOKE_ROOT');
  fs.rmSync(root, { recursive: true, force: true });
}
