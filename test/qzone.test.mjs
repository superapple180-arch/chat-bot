import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { State } from '../dist/state.js';
import { Qzone, beijingDate } from '../dist/qzone.js';
import { Bridge } from '../dist/bridge.js';
import { BridgeError } from '../dist/types.js';
import { readConfig } from '../dist/config.js';
import { execFileSync } from 'node:child_process';

function fixture(t) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('artifacts/test-tmp/qzone-')), file = path.join(dir, 'state.json'), flag = path.join(dir, 'request.json');
  const state = new State(file), states = [state], sent = [], prompts = [], logs = [];
  const c = { ...JSON.parse(fs.readFileSync('config.antigravity.example.json')), onebot: { selfId: '10000', accessToken: 'synthetic-qzone-token-123456', url: 'ws://127.0.0.1:3001', timeoutMs: 500 }, qzone: { enabled: true }, realSend: true };
  let date = new Date('2026-10-28T09:00:00Z');
  const transport = { async run(input) { prompts.push(input); return { response: '把一件小事认真做完，也是一种很好的前进方式。慢慢来，留一点耐心给自己。', conversationId: 'synthetic' }; } };
  const sender = { ready: true, async publishQzone(text) { sent.push(text); return 'synthetic-tid'; }, async send() {} };
  const make = (s = state) => new Qzone(s, transport, sender, (...args) => logs.push(args), flag, () => date);
  const manager = make(), request = (patch = {}) => fs.writeFileSync(flag, JSON.stringify({ selfId: c.onebot.selfId, date: beijingDate(date), ...patch }));
  t.after(() => { states.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { c, state, states, file, flag, transport, sender, sent, prompts, logs, manager, make, request, setDate: d => { date = new Date(d); } };
}

test('Beijing date follows midnight at UTC 16:00', () => {
  assert.equal(beijingDate(new Date('2026-10-28T15:59:59Z')), '2026-10-28');
  assert.equal(beijingDate(new Date('2026-10-28T16:00:00Z')), '2026-10-29');
});

test('independent fresh generation publishes once per Beijing day, including duplicate triggers and restart', async t => {
  const f = fixture(t); f.request(); await f.manager.runRequested(f.c);
  assert.equal(f.sent.length, 1); assert.equal(f.prompts[0].conversationId, undefined);
  assert.match(f.prompts[0].prompt, /独立创作/); assert.equal(f.state.data.qzonePosts['10000:2026-10-28'].status, 'sent');
  f.request(); await f.manager.runRequested(f.c); assert.equal(f.sent.length, 1); assert.equal(f.prompts.length, 1);
  f.state.close(); const reopened = new State(f.file); f.states.push(reopened); const next = f.make(reopened);
  f.request(); await next.runRequested(f.c); assert.equal(f.sent.length, 1);
  f.setDate('2026-10-28T16:00:00Z'); f.request(); await next.runRequested(f.c); assert.equal(f.sent.length, 2);
  assert.match(f.prompts[1].prompt, /把一件小事/);
});

test('disabled, wrong-account, stale and malformed local requests cannot publish', async t => {
  const f = fixture(t);
  f.request(); await f.manager.runRequested({ ...f.c, qzone: { enabled: false } }); assert.equal(f.prompts.length, 0);
  for (const patch of [{ selfId: '99999' }, { date: '2020-01-01' }]) { f.request(patch); await f.manager.runRequested(f.c); }
  fs.writeFileSync(f.flag, '{broken'); await f.manager.runRequested(f.c);
  assert.equal(f.sent.length, 0); assert.equal(f.prompts.length, 0);
});

test('dry run does not publish or consume real daily allowance; invalid drafts never publish', async t => {
  const f = fixture(t); f.request(); await f.manager.runRequested({ ...f.c, realSend: false });
  assert.equal(f.sent.length, 0); assert.equal(f.state.data.qzonePosts['dry-run:10000:2026-10-28'].status, 'dry-run');
  f.request(); await f.manager.runRequested(f.c); assert.equal(f.sent.length, 1);
  f.setDate('2026-10-29T09:00:00Z'); f.transport.run = async () => ({ response: 'x'.repeat(301) });
  f.request(); await f.manager.runRequested(f.c); assert.equal(f.sent.length, 1);
  assert.equal(f.state.data.qzonePosts['10000:2026-10-29'].code, 'INVALID_QZONE_DRAFT');
});

test('pause during generation and a midnight transition prevent publishing', async t => {
  const f = fixture(t), controller = new AbortController();
  f.transport.run = async () => { controller.abort(); return { response: '不应发布' }; };
  f.request(); await f.manager.runRequested(f.c, controller.signal); assert.equal(f.sent.length, 0);
  f.setDate('2026-10-29T15:59:59Z');
  f.transport.run = async () => { f.setDate('2026-10-29T16:00:01Z'); return { response: '不应跨日发布' }; };
  f.request(); await f.manager.runRequested(f.c); assert.equal(f.sent.length, 0);
});

test('uncertain publication and interrupted sending remain blocked for that day across restart', async t => {
  const f = fixture(t); let attempts = 0;
  f.sender.publishQzone = async () => { attempts++; throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true); };
  f.request(); await f.manager.runRequested(f.c); assert.equal(attempts, 1);
  assert.equal(f.state.data.qzonePosts['10000:2026-10-28'].status, 'uncertain');
  f.request(); await f.manager.runRequested(f.c); assert.equal(attempts, 1);
  f.state.data.qzonePosts['10000:2026-10-28'].status = 'sending'; f.state.save(); f.make();
  assert.equal(f.state.data.qzonePosts['10000:2026-10-28'].status, 'uncertain');
  f.request(); await f.manager.runRequested(f.c); assert.equal(attempts, 1);
});

test('bridge pauses Qzone work with its controller and keeps model work serial with incoming replies', async t => {
  const f = fixture(t); let finish, replyCalls = 0;
  f.c.friends = ['20001']; f.transport.run = () => new Promise(resolve => { finish = resolve; });
  const generator = { async ready() {}, async verify() {}, async generate() { replyCalls++; return '聊天回答'; } };
  const bridge = new Bridge(f.c, f.state, generator, f.sender, () => {}, undefined, undefined, f.manager);
  f.request(); await bridge.idleCheck(); assert.equal(finish, undefined);
  await bridge.resume(); const idle = bridge.idleCheck();
  while (!finish) await delay(1);
  bridge.accept({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10000, user_id: 20001, message_id: 1, message: [{ type: 'text', data: { text: '你好' } }] });
  assert.equal(replyCalls, 0); finish({ response: '独立创作' }); await idle; await bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(replyCalls, 1);
  f.setDate('2026-10-29T09:00:00Z'); f.request(); finish = undefined; const cancelled = bridge.idleCheck();
  while (!finish) await delay(1); bridge.pause(); finish({ response: '取消本轮' }); await cancelled;
  assert.equal(f.sent.length, 1);
});

test('Qzone config rejects incorrect providers and malformed enabled flags', t => {
  const f = fixture(t), file = path.join(path.dirname(f.file), 'config.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.c.onebot.accessToken + '\n');
  for (const patch of [{ qzone: null }, { qzone: { enabled: 'true' } }, { provider: 'gemini' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.c, ...patch })); assert.throws(() => readConfig(file), { code: 'INVALID_QZONE_CONFIG' });
  }
  for (const proxyUrl of ['http://remote.example:7890', 'https://127.0.0.1:7890', 'http://user:secret@127.0.0.1:7890', 'http://127.0.0.1:7890/?key=x']) {
    fs.writeFileSync(file, JSON.stringify({ ...f.c, qzone: { enabled: true, proxyUrl } })); assert.throws(() => readConfig(file), { code: 'INVALID_QZONE_PROXY' });
  }
});

test('NapCat preload routes only Qzone HTTPS hosts through the configured local proxy and preserves direct agents for other traffic', t => {
  const f = fixture(t), dir = path.dirname(f.file); fs.mkdirSync(path.join(dir, 'scripts'));
  const preload = path.join(dir, 'scripts/napcat-qzone-proxy.cjs'); fs.copyFileSync('scripts/napcat-qzone-proxy.cjs', preload);
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify({ qzone: { enabled: true, proxyUrl: 'http://127.0.0.1:7890' } }));
  const output = execFileSync(process.execPath, ['-e', "const a=require('node:https').globalAgent; console.log(JSON.stringify(['https://ssl.ptlogin2.qq.com/jump','https://ptlogin2.qzone.qq.com/','https://user.qzone.qq.com/','https://qzone.qq.com.evil.example/','http://127.0.0.1:3001/','https://example.com/'].map(u=>a.getProxyForUrl(u))));"], { cwd: dir, windowsHide: true, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require="${preload.replaceAll('\\', '/')}"` } });
  assert.deepEqual(JSON.parse(output), ['http://127.0.0.1:7890/', 'http://127.0.0.1:7890/', 'http://127.0.0.1:7890/', '', '', '']);
});

test('local trigger CLI only queues an account-bound daily request and reports existing publication without requeueing', t => {
  const f = fixture(t), dir = path.dirname(f.file);
  fs.cpSync('dist', path.join(dir, 'dist'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'scripts')); fs.mkdirSync(path.join(dir, 'state'));
  fs.copyFileSync('scripts/request-qzone.mjs', path.join(dir, 'scripts/request-qzone.mjs'));
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(dir, 'config.local.json'), JSON.stringify(f.c));
  fs.writeFileSync(path.join(dir, '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.c.onebot.accessToken + '\n');
  const localState = { pauseReason: 'USER_PAUSED' }, stateFile = path.join(dir, 'state/antigravity.json');
  fs.writeFileSync(stateFile, JSON.stringify(localState));
  const run = (...args) => JSON.parse(execFileSync(process.execPath, [path.join(dir, 'scripts/request-qzone.mjs'), ...args], { cwd: dir, windowsHide: true, encoding: 'utf8' }));
  assert.equal(run('--status').status, 'not-requested');
  const queued = run(); assert.equal(queued.status, 'queued'); assert.equal(queued.paused, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'state/qzone-request.json'))), { selfId: '10000', date: beijingDate() });
  fs.rmSync(path.join(dir, 'state/qzone-request.json'));
  localState.qzonePosts = { ['10000:' + beijingDate()]: { status: 'sent', tid: 'synthetic-tid' } };
  fs.writeFileSync(stateFile, JSON.stringify(localState));
  assert.equal(run().status, 'sent'); assert.equal(fs.existsSync(path.join(dir, 'state/qzone-request.json')), false);
});
