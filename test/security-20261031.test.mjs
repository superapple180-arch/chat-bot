// Public fixture identities below are generated synthetic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createWebServer } from '../dist/web-server.js';
import { setWebPassword } from '../dist/web-auth.js';
import { FriendAgent } from '../dist/friend-agent.js';
import { Requests } from '../dist/requests.js';
import { State } from '../dist/state.js';
import { digest } from '../dist/filter.js';
import { DatabaseSync } from 'node:sqlite';

function fixture(t) {
  const parent = path.resolve('artifacts/test-tmp'); fs.mkdirSync(parent, { recursive: true });
  const dir = fs.mkdtempSync(path.join(parent, 'security-20261031-')), cleanups = [];
  t.after(async () => { for (const close of cleanups.reverse()) await close(); assert.ok(dir.startsWith(parent + path.sep)); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, cleanups, state() { const state = new State(path.join(dir, 'state.json')); cleanups.push(() => state.close()); return state; } };
}
class Supervisor extends EventEmitter {
  status = { running: true, paused: true }; logs = []; calls = [];
  async start() { return this.status; }
  async stop() {}
  async call(action) { this.calls.push(action); if (action === 'resume') this.status.paused = false; if (action === 'pause') this.status.paused = true; return {}; }
}
async function apiFixture(t) {
  const f = fixture(t); fs.mkdirSync(path.join(f.dir, 'state'));
  await setWebPassword(path.join(f.dir, 'state/web-auth.json'), 'synthetic-security-password');
  const supervisor = new Supervisor(), { app } = await createWebServer(f.dir, supervisor); f.cleanups.push(() => app.close());
  const headers = { host: '127.0.0.1:3210', origin: 'http://127.0.0.1:3210' };
  const login = await app.inject({ method: 'POST', url: '/api/login', headers, payload: { password: 'synthetic-security-password' } });
  const authenticated = { ...headers, cookie: login.headers['set-cookie'].split(';')[0], 'x-csrf-token': login.json().csrf };
  return { ...f, app, supervisor, headers, authenticated };
}

test('encoded API prefixes cannot skip authentication, origin checks or CSRF', async t => {
  const f = await apiFixture(t);
  for (const prefix of ['/api', '/%61pi', '/a%70i', '/%61%70%69']) {
    assert.equal((await f.app.inject({ method: 'GET', url: prefix + '/status', headers: f.headers })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: prefix + '/runtime/pause', headers: f.headers, payload: {} })).statusCode, 401);
    assert.equal((await f.app.inject({ method: 'POST', url: prefix + '/runtime/pause', headers: { ...f.authenticated, origin: 'https://evil.example' }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'POST', url: prefix + '/runtime/pause', headers: { ...f.authenticated, 'x-csrf-token': '' }, payload: {} })).statusCode, 403);
    assert.equal((await f.app.inject({ method: 'GET', url: prefix + '/status', headers: f.authenticated })).statusCode, 200);
  }
  assert.deepEqual(f.supervisor.calls, []);
});

test('pause invalidates an older queued resume but permits a later explicit resume', async t => {
  const f = await apiFixture(t); let release, started = false;
  f.supervisor.start = async () => { started = true; await new Promise(r => { release = r; }); return f.supervisor.status; };
  const post = action => f.app.inject({ method: 'POST', url: '/api/runtime/' + action, headers: f.authenticated, payload: {} });
  const start = post('start').then(r => r.statusCode);
  while (!started) await delay(1);
  const oldResume = post('resume').then(r => r); await delay(15);
  try {
    assert.equal((await post('pause')).statusCode, 200); release(); await start;
    const cancelled = await oldResume; assert.equal(cancelled.statusCode, 409); assert.equal(cancelled.json().code, 'CONTROL_CANCELLED');
    assert.equal(f.supervisor.status.paused, true);
    assert.equal((await post('resume')).statusCode, 200); assert.equal(f.supervisor.status.paused, false);
  } finally { release(); await start; await oldResume; }
});

test('read-only or negated owner commands cannot authorize a model-proposed send or start', async t => {
  const f = fixture(t), state = f.state(), sent = [], prompts = [];
  const sender = { ready: true, async friendList() { return [{ userId: '20002', nickname: '好友', remark: '' }]; }, async send(target, text) { sent.push({ target, text }); } };
  const transport = { async run(request) { prompts.push(request); return { response: JSON.stringify({ action: 'start', target: '好友', text: 'UNAUTHORIZED_SIDE_EFFECT', instruction: 'chat' }) }; } };
  const agent = new FriendAgent(transport, sender, state), config = { onebot: { selfId: '10000' }, friendAdminId: '90001', realSend: true, maxReplyChars: 8000 };
  for (const command of ['查看好友列表', '帮我查一下好友', '不要联系好友，只查看名单', '不与好友聊天', '好友是谁', '好友']) await agent.executeOwner(command, randomUUID(), config);
  assert.equal(sent.length, 0); assert.equal(agent.active('20002'), false);
  assert.ok(prompts.length < 6, 'explicit list commands must use a local read-only branch');
});

test('a model cannot upgrade one message into ongoing chat or select a name only mentioned in message content', async t => {
  const f = fixture(t), state = f.state(), sent = [];
  const sender = { ready: true, async friendList() { return [{ userId: '20001', nickname: '合成昵称甲', remark: '' }, { userId: '20002', nickname: '合成昵称乙', remark: '' }, { userId: '200010', nickname: '合成昵称丙', remark: '' }]; }, async send(target) { sent.push(target.id); } };
  let plan = { action: 'start', target: '合成昵称甲', text: 'hello', instruction: 'chat' };
  const agent = new FriendAgent({ async run() { return { response: JSON.stringify(plan) }; } }, sender, state);
  const config = { onebot: { selfId: '10000' }, friendAdminId: '90001', realSend: true, maxReplyChars: 8000 };
  await agent.executeOwner('给合成昵称甲发送一条消息', randomUUID(), config);
  assert.equal(agent.active('20001'), false); assert.deepEqual(sent, []);
  plan = { action: 'send', target: '合成昵称乙', text: 'hello' };
  await agent.executeOwner('给合成昵称甲发消息说合成昵称乙今天有空', randomUUID(), config);
  assert.deepEqual(sent, []);
  plan = { action: 'send', target: '合成昵称甲', text: 'hello' };
  await agent.executeOwner('给合成昵称甲发消息是什么意思？', randomUUID(), config);
  assert.deepEqual(sent, []);
  await agent.executeOwner('给合成昵称丙发消息', randomUUID(), config);
  assert.deepEqual(sent, []);
  plan = { action: 'send', target: '20001', text: 'hello' };
  await agent.executeOwner('给200010发消息说20001今天有空', randomUUID(), config);
  assert.deepEqual(sent, []);
  plan = { action: 'send', target: '合成昵称甲', text: 'hello' };
  await agent.executeOwner('给合成昵称甲发送一条消息', randomUUID(), config);
  assert.deepEqual(sent, ['20001']); assert.equal(agent.active('20001'), false);
});

test('attachment completion proof requires a matching successful post-tool event', t => {
  const f = fixture(t), nonce = randomUUID(), conversationId = randomUUID(), image = path.join(f.dir, 'synthetic.png');
  fs.writeFileSync(image, 'SYNTHETIC_ONLY');
  const hash = createHash('sha256').update(fs.readFileSync(image)).digest('hex'), id = createHash('sha256').update(image.toLowerCase()).digest('hex');
  fs.writeFileSync(path.join(f.dir, '.hook-request.json'), JSON.stringify({ nonce, attachments: [{ path: image, sha256: hash }] }));
  const proof = path.join(f.dir, `.hook-view-${nonce}-${id}.json`);
  const run = (mode, extra = {}) => spawnSync(process.execPath, [path.resolve('scripts/antigravity-tools-hook.mjs'), mode, f.dir], { cwd: f.dir, input: JSON.stringify({ conversationId, stepIdx: 0, toolCall: { name: 'view_file', args: { AbsolutePath: image } }, ...extra }), encoding: 'utf8', windowsHide: true });
  assert.equal(run('start').status, 0);
  assert.equal(JSON.parse(run('tool').stdout).decision, 'allow'); assert.ok(!fs.existsSync(proof));
  run('post-tool', { error: 'synthetic read failure' }); assert.ok(!fs.existsSync(proof));
  run('post-tool', { stepIdx: 2 }); assert.ok(!fs.existsSync(proof));
  assert.equal(JSON.parse(run('tool', { stepIdx: 1 }).stdout).decision, 'allow');
  assert.equal(run('post-tool', { stepIdx: 1, error: '' }).status, 0);
  const completed = JSON.parse(fs.readFileSync(proof)); assert.equal(completed.completed, true); assert.equal(completed.stepIdx, 1); assert.equal(completed.sha256, hash);
});

const config = { onebot: { selfId: '10000' }, realSend: true };
const incoming = (i, userId = '20001') => ({ post_type: 'request', request_type: 'friend', self_id: '10000', user_id: userId, flag: 'synthetic-flag-' + i, comment: 'x'.repeat(500) });
test('new request records are bounded per sender and do not rewrite JSON metadata', t => {
  const f = fixture(t), state = f.state(), manager = new Requests(state, {}), file = path.join(f.dir, 'state.json'), before = fs.readFileSync(file, 'utf8');
  const saved = t.mock.method(state, 'save', () => { throw Error('UNEXPECTED_FULL_STATE_WRITE'); });
  for (let i = 0; i < 5; i++) assert.equal(manager.accept(incoming(i), config), true);
  assert.equal(manager.accept(incoming(5), config), false); assert.equal(manager.accept(incoming(5), config), false);
  assert.equal(saved.mock.callCount(), 0); assert.equal(fs.readFileSync(file, 'utf8'), before);
});

test('legacy request migration preserves decisions and replay protection without a JSON request collection', async t => {
  const f = fixture(t), state = f.state(), file = path.join(f.dir, 'state.json');
  const e = incoming(1), id = digest(JSON.stringify(['10000', 'friend', '', e.flag])).slice(0, 16);
  state.data.requests = { [id]: { selfId: '10000', kind: 'friend', flag: e.flag, userId: '20001', comment: 'LEGACY_PENDING', at: new Date().toISOString(), status: 'pending' } }; state.save(); state.close();
  let calls = 0; const restored = f.state(), manager = new Requests(restored, { ready: true, async handleRequest() { calls++; } });
  assert.equal(JSON.parse(fs.readFileSync(file)).requests, undefined); assert.match(await manager.command('requests', config), /LEGACY_PENDING/);
  await manager.command('approve ' + id, config); assert.equal(calls, 1); assert.equal(manager.accept(e, config), false);
  restored.close(); const reopened = f.state(), next = new Requests(reopened, { ready: true, async handleRequest() { calls++; } });
  await next.command('approve ' + id, config); assert.equal(calls, 1); assert.equal(next.accept(e, config), false);
});

test('request capacity is account-bound and rejected overflow events remain deduplicated', t => {
  const f=fixture(t),state=f.state(),manager=new Requests(state,{});
  for(let i=0;i<500;i++)assert.equal(manager.accept(incoming(i,String(20001+i)),config),true);
  const overflow=incoming(501,'90001');assert.equal(manager.accept(overflow,config),false);
  assert.equal(state.pendingRequests('10000'),500);assert.equal(state.pendingRequests('10001'),0);
  assert.equal(manager.accept({...overflow,self_id:'10001'},{...config,onebot:{selfId:'10001'}}),true);
  assert.equal(manager.accept(overflow,config),false);
});

test('completed payload expiry keeps replay tombstones and never expires uncertain work', async t => {
  const f=fixture(t),state=f.state(),manager=new Requests(state,{ready:true,async handleRequest(){}});
  const first=incoming(1),second=incoming(2,'20002');manager.accept(first,config);manager.accept(second,config);
  const id=e=>digest(JSON.stringify(['10000','friend','',e.flag])).slice(0,16);
  await manager.command('approve '+id(first),config);state.requestStatus(id(second),'uncertain');
  const db=new DatabaseSync(path.join(f.dir,'state.json.events.sqlite'));f.cleanups.push(()=>db.close());
  db.prepare('UPDATE contact_requests SET at=?').run(new Date(Date.now()-91*86400000).toISOString());
  state.cleanupRequests();assert.equal(state.request(id(first)),undefined);assert.equal(state.request(id(second)).status,'uncertain');
  assert.equal(manager.accept(first,config),false);assert.equal(manager.accept(second,config),false);
});

test('concurrent explicit approvals acquire a single durable claim', async t => {
  const f=fixture(t),state=f.state();let release,calls=0;
  const manager=new Requests(state,{ready:true,async handleRequest(){calls++;await new Promise(r=>release=r);}});
  const e=incoming(1);manager.accept(e,config);const id=digest(JSON.stringify(['10000','friend','',e.flag])).slice(0,16);
  const first=manager.command('approve '+id,config);
  await manager.command('approve '+id,config);assert.equal(calls,1);release();await first;assert.equal(state.request(id).status,'approved');
});

test('a missing migrated request table fails closed', t => {
  const f=fixture(t),state=f.state();state.close();
  const db=new DatabaseSync(path.join(f.dir,'state.json.events.sqlite'));db.exec('DROP TABLE contact_requests');db.close();
  assert.throws(()=>f.state(),/STATE_REQUESTS_MISSING/);
});
