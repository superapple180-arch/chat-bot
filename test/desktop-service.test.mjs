import { readOneBotToken } from '../dist/secrets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import http from 'node:http';

async function fixture(t, existing, preferredPort = 0) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/desktop setup-')), components = path.join(root, 'components');
  fs.mkdirSync(path.join(components, 'antigravity'), { recursive: true });
  fs.writeFileSync(path.join(components, 'antigravity', process.platform === 'win32' ? 'agy.exe' : 'agy'), 'synthetic-placeholder');
  fs.writeFileSync(path.join(components, 'voice-ready.json'), '{}');
  // Avoid any user's external macOS QQ container in this test.
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  const directory = process.platform === 'darwin' ? path.join(home, 'Library/Containers/com.tencent.qq/Data/Library/Application Support/QQ/NapCat/config') : path.join(components, 'napcat', process.platform === 'win32' ? 'napcat/config' : 'config');
  fs.mkdirSync(directory, { recursive: true });
  const accountFile = path.join(directory, 'onebot11_900000001.json');
  if (existing) fs.writeFileSync(accountFile, JSON.stringify(existing));
  const child = fork(path.resolve('dist/desktop-service.js'), [], { cwd: root, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: { ...process.env, HOME: home, CHAT_BOT_SERVICE_TEST: '1', CHAT_BOT_SERVICE_TEST_PORT: String(preferredPort), QQ_BOT_CODE_ROOT: process.cwd(), QQ_BOT_DATA_ROOT: root, QQ_BOT_COMPONENT_ROOT: components } });
  const closed = new Promise(resolve => child.once('exit', resolve));
  const requests = new Map();
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('SERVICE_TEST_TIMEOUT')), 5000);
    child.once('error', reject);
    child.on('message', message => {
      if (message.ready) { clearTimeout(timer); resolve(message); }
      const pending = requests.get(message.id); if (pending) { requests.delete(message.id); message.error ? pending.reject(Error(message.error)) : pending.resolve(message.result); }
    });
  });
  const call = (action, payload) => new Promise((resolve, reject) => { const id = randomUUID(); requests.set(id, { resolve, reject }); child.send({ id, action, payload }); });
  t.after(async () => {
    if (child.connected) { await call('stop').catch(() => {}); child.disconnect(); }
    await closed; fs.rmSync(root, { recursive: true, force: true });
  });
  await ready; return { root, call, accountFile };
}
const setup = { selfId: '900000001', password: 'synthetic-long-password', confirm: 'synthetic-long-password' };
test('desktop setup works without TTY, stores only a password hash, and uses separate writable data', async t => {
  const f = await fixture(t); assert.equal((await f.call('status')).configured, false);
  await assert.rejects(f.call('setup', { ...setup, confirm: 'wrong' }), /INVALID_SETUP/);
  await f.call('setup', setup);
  const config = JSON.parse(fs.readFileSync(path.join(f.root, 'config.local.json')));
  assert.equal(config.realSend, false); assert.deepEqual(config.attachments.localRoots, []);
  assert.equal(config.onebot.accessToken, '');assert.ok(readOneBotToken(f.root).length >= 32);
  assert.ok(!fs.readFileSync(path.join(f.root, 'state/web-auth.json'), 'utf8').includes(setup.password));
  assert.equal((await f.call('status')).running, false);
});
test('desktop setup adopts a valid existing local OneBot token without modifying its file', async t => {
  const existing = { network: { websocketServers: [{ enable: true, host: '127.0.0.1', port: 3001, messagePostFormat: 'array', reportSelfMessage: false, token: 'synthetic-existing-token-0123456789' }] } };
  const f = await fixture(t, existing), before = fs.readFileSync(f.accountFile, 'utf8');
  await f.call('setup', setup);
  assert.equal(fs.readFileSync(f.accountFile, 'utf8'), before);
  assert.equal(readOneBotToken(f.root), existing.network.websocketServers[0].token);assert.equal(JSON.parse(fs.readFileSync(path.join(f.root, 'config.local.json'))).onebot.accessToken, '');
});
test('incompatible external OneBot settings stop setup before password or account configuration is written', async t => {
  const f = await fixture(t, { network: { websocketServers: [] } });
  await assert.rejects(f.call('setup', setup), /EXISTING_NAPCAT_CONFIG_REQUIRES_MANUAL_SETUP/);
  assert.equal(fs.existsSync(path.join(f.root, 'config.local.json')), false);
  assert.equal(fs.existsSync(path.join(f.root, 'state/web-auth.json')), false);
});

test('occupied management port selects an isolated port, serves authenticated API and keeps the existing service alive', async t => {
  const occupied = http.createServer((_request, response) => response.end('synthetic-existing-service'));
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => occupied.close(resolve)));
  const port = occupied.address().port, f = await fixture(t, undefined, port);
  await f.call('setup', setup);
  const status = await f.call('status');
  assert.match(status.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.notEqual(new URL(status.origin).port, String(port));
  const headers = { Origin: status.origin, 'Content-Type': 'application/json' };
  const login = await fetch(status.origin + '/api/login', { method: 'POST', headers, body: JSON.stringify({ password: setup.password }) });
  assert.equal(login.status, 200); const { csrf } = await login.json();
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const current = await fetch(status.origin + '/api/status', { headers: { Cookie: cookie } });
  assert.equal(current.status, 200); assert.equal((await current.json()).running, false);
  const rejected = await fetch(status.origin + '/api/logout', { method: 'POST', headers: { ...headers, Cookie: cookie, Origin: 'http://127.0.0.1:' + port, 'X-CSRF-Token': csrf }, body: '{}' });
  assert.equal(rejected.status, 403);
  assert.equal(await (await fetch('http://127.0.0.1:' + port)).text(), 'synthetic-existing-service');
});
