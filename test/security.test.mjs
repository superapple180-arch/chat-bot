import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { MemoryStore } from '../dist/memory.js';
import { State } from '../dist/state.js';
import { Bridge } from '../dist/bridge.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { filterEvent, digest } from '../dist/filter.js';
import { BridgeError } from '../dist/types.js';
import { acquireLock } from '../dist/lock.js';

async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw Error('WAIT_TIMEOUT'); await delay(5); }
}
function fixture(t) {
  const parent = path.resolve('artifacts/test-tmp'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'security-'));
  const cleanups = [];
  t.after(async () => { for (const close of cleanups.reverse()) await close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, cleanups, state(file = path.join(dir, 'state.json')) { const s = new State(file); cleanups.push(() => s.close()); return s; } };
}
const config = () => ({ provider: 'antigravity', antigravity: { executable: process.execPath, timeoutMs: 1000, model: '' }, onebot: { selfId: '10000', url: 'ws://127.0.0.1:3001', accessToken: 'synthetic-security-token-00000', timeoutMs: 5000 }, friends: ['20001', '20002'], groups: ['30001'], maxQueue: 50, maxMessageChars: 4000, maxReplyChars: 8000, replyStyle: '', realSend: true });
const event = (id, text, user = '20001', group = false) => ({ post_type: 'message', self_id: '10000', user_id: user, message_id: id, message_type: group ? 'group' : 'private', sub_type: 'friend', ...(group ? { group_id: '30001' } : {}), message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text } }] });

test('literal mentions cannot grant access to another person private history or facts', t => {
  const f = fixture(t), c = config(), store = new MemoryStore(':memory:'); f.cleanups.push(() => store.close());
  for (const e of [event(1, 'B_PRIVATE_SECRET', '20002'), event(2, 'GROUP_PUBLIC', '20002', true), event(3, 'A_OWN_PRIVATE')]) store.capture('10000', filterEvent(e, c, true));
  const rows = store.batch('10000', c); assert.equal(rows[0].user_id, '20002');
  store.finishJob('10000', rows, JSON.stringify({ facts: [{ subject: '20002', text: 'B_FACT_SECRET', sources: [rows[0].id] }] }), Date.now());
  for (const group of [false, true]) {
    const recalled = store.recall('10000', filterEvent(event(10, '@20002 PRIVATE SECRET FACT', '20001', group), c));
    assert.ok(!recalled.includes('B_PRIVATE_SECRET')); assert.ok(!recalled.includes('B_FACT_SECRET'));
    assert.ok(recalled.includes('A_OWN_PRIVATE'));
    if (group) assert.ok(recalled.includes('GROUP_PUBLIC'));
  }
});

test('upgrade excludes legacy assistant answers from recall without deleting original history', t => {
  const f = fixture(t), file = path.join(f.dir, 'memory.sqlite'), c = config(); let store = new MemoryStore(file);
  f.cleanups.push(() => store.close());
  const first = filterEvent(event(1, 'original user text'), c); store.capture('10000', first); store.answer('10000', first, 'POSSIBLY_LEAKED_LEGACY_ANSWER'); store.status('10000', first.eventKey, 'sent');
  store.db.exec("DELETE FROM meta WHERE key='security_scope_v2'"); store.close(); store = new MemoryStore(file);
  const query = filterEvent(event(2, 'LEGACY_ANSWER'), c);
  assert.equal(store.history('10000').length, 2);
  assert.equal(store.history('10000')[0].status, 'legacy-untrusted');
  assert.ok(!store.recall('10000', query).includes('POSSIBLY_LEAKED_LEGACY_ANSWER'));
  const next = filterEvent(event(3, 'new original text'), c); store.capture('10000', next); store.answer('10000', next, 'NEW_CONFIRMED_ANSWER'); store.status('10000', next.eventKey, 'sent');
  store.close(); store = new MemoryStore(file);
  assert.ok(store.recall('10000', query).includes('NEW_CONFIRMED_ANSWER'));
});

function hook(dir, mode, input) {
  return spawnSync(process.execPath, [path.resolve('scripts/antigravity-tools-hook.mjs'), mode, dir], { cwd: dir, input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', windowsHide: true });
}
test('the dedicated workspace denies tools for missing, invalid and mismatched guard data', t => {
  const { dir } = fixture(t), conversationId = randomUUID(), nonce = randomUUID();
  const input = { conversationId, toolCall: { name: 'run_command' } };
  for (const value of [undefined, 'bad json', '{"nonce":"bad"}', JSON.stringify({ nonce })]) {
    if (value !== undefined) fs.writeFileSync(path.join(dir, '.hook-request.json'), value);
    for (const name of ['run_command', 'finish']) {
      const result = hook(dir, 'tool', { ...input, toolCall: { name } });
      assert.equal(result.status, 0); assert.equal(JSON.parse(result.stdout).decision, 'deny');
    }
  }
  assert.equal(JSON.parse(hook(dir, 'tool', 'not-json').stdout).decision, 'deny');
  assert.equal(hook(dir, 'start', input).status, 0);
  assert.equal(JSON.parse(hook(dir, 'tool', { ...input, toolCall: { name: 'finish' } }).stdout).decision, 'allow');
  fs.writeFileSync(path.join(dir, `.hook-proof-${nonce}.json`), JSON.stringify({ nonce: randomUUID(), conversationId }));
  assert.equal(JSON.parse(hook(dir, 'tool', { ...input, toolCall: { name: 'finish' } }).stdout).decision, 'deny');
});
test('attachment guard permits only the declared unchanged synthetic PNG in the attested session', t => {
  const { dir } = fixture(t), conversationId = randomUUID(), nonce = randomUUID();
  const image = path.join(dir, 'synthetic.png'), other = path.join(dir, 'other.png');
  fs.writeFileSync(image, 'SYNTHETIC_IMAGE_ONLY'); fs.writeFileSync(other, 'OTHER_SYNTHETIC_IMAGE');
  fs.writeFileSync(path.join(dir, '.hook-request.json'), JSON.stringify({ nonce, attachments: [{ path: image, sha256: createHash('sha256').update(fs.readFileSync(image)).digest('hex') }] }));
  const tool = (AbsolutePath, patch = {}) => hook(dir, 'tool', { conversationId, stepIdx: 0, toolCall: { name: 'view_file', arguments: { AbsolutePath } }, ...patch });
  assert.equal(JSON.parse(tool(image).stdout).decision, 'deny');
  hook(dir, 'start', { conversationId });
  assert.equal(JSON.parse(tool(image).stdout).decision, 'allow');
  assert.equal(JSON.parse(hook(dir, 'tool', { conversationId, stepIdx: 0, toolCall: { name: 'view_file', args: { AbsolutePath: image } } }).stdout).decision, 'allow');
  assert.equal(JSON.parse(tool(other).stdout).decision, 'deny');
  assert.equal(JSON.parse(tool(image, { conversationId: randomUUID() }).stdout).decision, 'deny');
  assert.equal(JSON.parse(hook(dir, 'tool', { conversationId, toolCall: { name: 'view_file', arguments: { AbsolutePath: image, extra: true } } }).stdout).decision, 'deny');
  fs.writeFileSync(image, 'CHANGED_AFTER_SCOPE_APPROVAL');
  assert.equal(JSON.parse(tool(image).stdout).decision, 'deny');
  assert.equal(JSON.parse(hook(dir, 'tool', { conversationId, toolCall: { name: 'run_command', arguments: { command: 'echo test' } } }).stdout).decision, 'deny');
});

for (const mode of ['cancel', 'timeout']) test(`transport keeps guard and remains unsettled until process close after ${mode}`, async t => {
  const { dir } = fixture(t), controller = new AbortController(); let child, killed = false, settled = false;
  const launch = (_exe, _args, options) => {
    child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed = true; assert.ok(fs.existsSync(path.join(dir, '.hook-request.json'))); assert.equal(JSON.parse(hook(dir, 'tool', { toolCall: { name: 'run_command' } }).stdout).decision, 'deny'); return true; };
    queueMicrotask(() => {
      const id = randomUUID(); fs.writeFileSync(options.env.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({ nonce: options.env.QQ_BRIDGE_HOOK_NONCE, conversationId: id }));
      child.stdout.write(JSON.stringify({ event: 'init', conversation_id: id, init: { tools: [] } }) + '\n');
      if (mode === 'cancel') controller.abort();
    }); return child;
  };
  const transport = new AntigravityProcess({ executable: process.execPath, timeoutMs: mode === 'timeout' ? 25 : 1000, model: '' }, dir, launch);
  const result = transport.run({ prompt: 'synthetic only', signal: controller.signal }); result.then(() => { settled = true; }, () => { settled = true; });
  await until(() => killed); assert.equal(settled, false); assert.ok(fs.existsSync(path.join(dir, '.hook-request.json')));
  child.emit('close', 1);
  await assert.rejects(result, { code: mode === 'cancel' ? 'PAUSED' : 'ANTIGRAVITY_TIMEOUT' });
  assert.ok(!fs.existsSync(path.join(dir, '.hook-request.json')));
  assert.equal(JSON.parse(hook(dir, 'tool', { toolCall: { name: 'run_command' } }).stdout).decision, 'deny');
});

for (const outcome of ['dry-run', 'failed', 'uncertain', 'sent']) test(`only acknowledged sends retain provider context: ${outcome}`, async t => {
  const f = fixture(t), state = f.state(), c = config(), requests = [], sent = [];
  c.realSend = outcome !== 'dry-run';
  const transport = { check() {}, async run(r) { requests.push(r); return { conversationId: r.conversationId ?? randomUUID(), response: 'synthetic response' }; } };
  let first = true;
  const sender = { ready: true, async send(_target, answer) { if (first && ['failed', 'uncertain'].includes(outcome)) { first = false; throw new BridgeError('QQ_SEND_TEST', 'QQ_SEND_FAILED', outcome === 'uncertain'); } first = false; sent.push(answer); } };
  const bridge = new Bridge(c, state, new Antigravity(transport, state), sender, () => {});
  await bridge.resume(); const firstEvent = event(1, 'first'); bridge.accept(firstEvent); await bridge.settled();
  assert.equal(state.event(filterEvent(firstEvent, c).eventKey).status, outcome);
  bridge.pause(); bridge.config = { ...c, realSend: true }; await bridge.resume(); bridge.accept(event(2, 'second')); await bridge.settled();
  assert.equal(requests.length, 2);
  assert.equal(Boolean(requests[1].conversationId), outcome === 'sent');
  assert.equal(sent.length, outcome === 'sent' ? 2 : 1);
});

test('restart discards a provider session whose generation was never acknowledged', async t => {
  const f = fixture(t), state = f.state(), calls = [];
  const transport = { check() {}, async run(r) { calls.push(r); return { conversationId: r.conversationId ?? randomUUID(), response: 'synthetic' }; } };
  const agent = new Antigravity(transport, state);
  await agent.generate('A', 'delivered', ''); state.confirmReply('A');
  await agent.generate('A', 'process will crash before send', '');
  state.close(); const restored = f.state();
  assert.equal(restored.data.antigravitySessions.A, undefined);
  await new Antigravity(transport, restored).generate('A', 'after restart', '');
  assert.equal(calls[2].conversationId, undefined);
});

test('a dry run never resumes or invalidates the confirmed production session', async t => {
  const f = fixture(t), state = f.state(), c = config(), requests = [];
  const transport = { check() {}, async run(r) { requests.push(r); return { conversationId: r.conversationId ?? randomUUID(), response: 'synthetic' }; } };
  const bridge = new Bridge(c, state, new Antigravity(transport, state), { ready: true, async send() {} }, () => {});
  await bridge.resume(); bridge.accept(event(1, 'production first')); await bridge.settled();
  const key = filterEvent(event(1, 'production first'), c).key, confirmed = state.data.antigravitySessions[key].id;
  bridge.config = { ...c, realSend: false }; bridge.accept(event(2, 'dry run')); await bridge.settled();
  assert.equal(requests[1].conversationId, undefined); assert.equal(state.data.antigravitySessions[key].id, confirmed);
  bridge.config = c; bridge.accept(event(3, 'production next')); await bridge.settled();
  assert.equal(requests[2].conversationId, confirmed); assert.equal(Object.keys(state.data.antigravitySessions).length, 1);
});

test('legacy migration preserves permanent deduplication and invalidates old provider sessions once', t => {
  const f = fixture(t), file = path.join(f.dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: { gemini: { url: 'old', mode: 'Flash' } }, antigravitySessions: { agent: { id: randomUUID(), model: '' } }, events: { sent: { status: 'sent', at: '2026-01-01' }, pending: { status: 'sending', at: '2026-01-01' }, uncertain: { status: 'uncertain', at: '2026-01-01' } }, pauseReason: '' }));
  let state = f.state(file);
  assert.equal(state.data.version, 2); assert.equal(state.event('sent').status, 'sent'); assert.equal(state.event('uncertain').status, 'uncertain'); assert.equal(state.event('pending').status, 'interrupted');
  assert.deepEqual(state.data.sessions, {}); assert.deepEqual(state.data.antigravitySessions, {});
  assert.equal(JSON.parse(fs.readFileSync(file)).events, undefined);
  state.data.antigravitySessions.A = { id: randomUUID(), model: '' }; state.save(); const id = state.data.antigravitySessions.A.id;
  state.close(); state = f.state(file); assert.equal(state.data.antigravitySessions.A.id, id);
});

test('event updates never rewrite metadata or load historical events into the state object', t => {
  const f = fixture(t), state = f.state(), file = path.join(f.dir, 'state.json'), metadata = fs.readFileSync(file, 'utf8');
  const save = t.mock.method(state, 'save', () => { throw Error('UNEXPECTED_METADATA_REWRITE'); });
  for (let i = 0; i < 1000; i++) for (const status of ['accepted', 'generating', 'sending', 'sent']) state.record(digest(String(i)), status);
  assert.equal(save.mock.callCount(), 0); assert.equal(fs.readFileSync(file, 'utf8'), metadata); assert.equal(state.data.events, undefined);
  assert.equal(state.event(digest('999')).status, 'sent'); assert.equal(Object.keys(state.events()).length, 1000);
});

for (const fault of ['missing', 'empty']) test(`${fault} event database fails closed instead of forgetting permanent deduplication`, t => {
  const f = fixture(t), state = f.state(), file = path.join(f.dir, 'state.json'); state.record('old', 'sent'); state.close();
  fs.rmSync(file + '.events.sqlite');
  if (fault === 'empty') fs.writeFileSync(file + '.events.sqlite', '');
  assert.throws(() => f.state(file), /STATE_EVENTS_MISSING/);
});

test('OS-backed lock remains exclusive even if PID metadata disappears, and crash permits recovery', async t => {
  const f = fixture(t), file = path.join(f.dir, 'bridge.lock');
  const release = acquireLock(file); f.cleanups.push(release);
  fs.rmSync(file); assert.throws(() => acquireLock(file), { code: 'BRIDGE_ALREADY_RUNNING' }); release();
  const module = new URL('../dist/lock.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import {acquireLock} from ${JSON.stringify(module)}; acquireLock(${JSON.stringify(file)}); console.log('LOCKED'); setInterval(()=>{},1000);`], { windowsHide: true });
  let out = ''; child.stdout.on('data', x => out += x); child.stderr.resume(); const closed = new Promise(r => child.on('close', r));
  f.cleanups.push(async () => { child.kill(); await closed; });
  await until(() => out.includes('LOCKED')); assert.throws(() => acquireLock(file), { code: 'BRIDGE_ALREADY_RUNNING' });
  child.kill(); await closed; const recovered = acquireLock(file); recovered(); assert.ok(!fs.existsSync(file));
});

for (const pauseMode of ['console', 'flag', 'preexisting-flag']) test(`autostart cannot override pause before connection: ${pauseMode}`, async t => {
  const f = fixture(t); fs.cpSync('dist', path.join(f.dir, 'dist'), { recursive: true }); fs.writeFileSync(path.join(f.dir, 'package.json'), '{"type":"module"}');
  fs.mkdirSync(path.join(f.dir, 'scripts')); fs.copyFileSync('scripts/antigravity-tools-hook.mjs', path.join(f.dir, 'scripts/antigravity-tools-hook.mjs'));
  fs.mkdirSync(path.join(f.dir, 'state'));
  if (pauseMode === 'preexisting-flag') fs.writeFileSync(path.join(f.dir, 'state/pause.flag'), 'pause');
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => server.on('listening', r));
  let held, peer;
  server.on('connection', socket => socket.on('message', raw => { const m = JSON.parse(raw); if (m.action === 'get_login_info') { held = m; peer = socket; } else {
    assert.ok(['get_status', 'get_group_member_info'].includes(m.action));
    if (m.action === 'get_group_member_info') { assert.equal(m.params.user_id, '10000'); assert.equal(m.params.group_id, '30001'); }
    socket.send(JSON.stringify({ echo: m.echo, status: 'ok', retcode: 0, data: m.action === 'get_status' ? { online: true, good: true } : { user_id: '10000', group_id: '30001', card: '' } }));
  } }));
  f.cleanups.push(async () => { for (const socket of server.clients) socket.terminate(); await new Promise(r => server.close(r)); });
  const c = config(); c.realSend = false; c.onebot.url = `ws://127.0.0.1:${server.address().port}`; fs.writeFileSync(path.join(f.dir, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(f.dir, 'config.local.json'), JSON.stringify(c));
  const child = spawn(process.execPath, [path.join(f.dir, 'dist/cli.js'), '--run'], { cwd: f.dir, windowsHide: true }); let out = ''; child.stdout.on('data', x => out += x); child.stderr.resume(); const closed = new Promise(r => child.on('close', r));
  f.cleanups.push(async () => { child.kill(); await closed; });
  await until(() => held);
  if (pauseMode === 'console') { child.stdin.write('p\n'); await until(() => out.includes('USER_PAUSED')); }
  if (pauseMode === 'flag') { fs.writeFileSync(path.join(f.dir, 'state/pause.flag'), 'pause'); await until(() => out.includes('USER_PAUSED')); }
  peer.send(JSON.stringify({ echo: held.echo, status: 'ok', retcode: 0, data: { user_id: '10000' } })); await until(() => out.includes('[ONEBOT] CONNECTED'));
  child.stdin.write('s\n'); await until(() => out.includes('"paused":true'));
  assert.ok(!out.includes('[RUNNING]')); child.stdin.write('q\n'); assert.equal(await closed, 0);
});

test('all provider verification and memory entrypoints honor the same live lock before invoking a provider', async t => {
  const f = fixture(t); fs.cpSync('dist', path.join(f.dir, 'dist'), { recursive: true }); fs.cpSync('scripts', path.join(f.dir, 'scripts'), { recursive: true }); fs.writeFileSync(path.join(f.dir, 'package.json'), '{"type":"module"}');
  const release = acquireLock(path.join(f.dir, 'state/bridge.lock')); f.cleanups.push(release);
  for (const script of ['dist/cli.js', 'dist/verify-antigravity.js', 'dist/verify-gemini.js', 'dist/verify-memory.js', 'dist/memory-cli.js', 'scripts/verify-antigravity-bridge.mjs', 'scripts/verify-friend-agent.mjs', 'scripts/verify-attachments.mjs', 'scripts/verify-chat-vision.mjs', 'scripts/driver-smoke.mjs', 'scripts/check-window-policy.mjs']) {
    const result = spawnSync(process.execPath, [path.join(f.dir, script)], { cwd: f.dir, encoding: 'utf8', windowsHide: true, timeout: 5000 });
    assert.notEqual(result.status, 0, script); assert.match(result.stdout + result.stderr, /BRIDGE_ALREADY_RUNNING/, script);
  }
});
