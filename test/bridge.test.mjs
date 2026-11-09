import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { State } from '../dist/state.js';
import { Gemini } from '../dist/gemini.js';
import { Bridge } from '../dist/bridge.js';
import { BridgeError } from '../dist/types.js';
import { filterEvent } from '../dist/filter.js';
import { localUrl, readConfig } from '../dist/config.js';
const base = JSON.parse(fs.readFileSync('config.example.json'));
export const config = () => ({ ...structuredClone(base), onebot: { ...base.onebot, selfId: '10000', accessToken: 'test-only-token-0123456789' }, friends: ['20001','20002'], groups: ['30001'], realSend: true });
export const event = (id = 1, user = '20001') => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 10000, user_id: Number(user), message_id: id, message: [{ type: 'text', data: { text: `hello-${id}` } }] });
class FakeDesktop {
  view = { url: 'https://gemini.google.com/app/personal', mode: 'Flash', fingerprint: 'initial', hasDraft: false, busy: false, minimized: false, userCount: 0, responseCount: 0, text: '', marker: '', submitted: false };
  sessions = new Map(); calls = []; sends = 0; concurrent = 0; maxConcurrent = 0; n = 0;
  fail; mutate; slow = 0;
  async call(input, signal) {
    this.calls.push(input.action); this.concurrent++; this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    try {
      if (this.slow) await delay(this.slow);
      if (signal?.aborted) throw new BridgeError('PAUSED', 'GENERATION_FAILED', true);
      if (this.fail?.action === input.action) throw new BridgeError(this.fail.code, this.fail.category, this.fail.uncertain);
      if (input.action === 'observe') return { ...this.view };
      if (this.view.hasDraft) throw new BridgeError('MANUAL_DRAFT');
      if (this.view.busy) throw new BridgeError('ALREADY_GENERATING');
      if (input.fingerprint !== this.view.fingerprint || input.mode !== this.view.mode) throw new BridgeError('USER_INTERVENED');
      if (input.action === 'check') return { ...this.view };
      if (input.action === 'new') this.view = { ...this.view, url: 'https://gemini.google.com/app', fingerprint: 'new-' + ++this.n, userCount: 0, responseCount: 0 };
      if (input.action === 'send') {
        this.sends++;
        const url = input.url === 'https://gemini.google.com/app' ? 'https://gemini.google.com/app/s' + ++this.n : input.url;
        const history = this.sessions.get(url) ?? [];
        const text = JSON.parse(input.text.split('聊天内容（JSON 字符串）：\n')[1].split('\n本轮关联编号：')[0]);
        history.push(text); this.sessions.set(url, history);
        this.view = { ...this.view, url, fingerprint: 'sent-' + ++this.n, userCount: history.length, responseCount: history.length, text: history.join('|'), marker: input.marker, submitted: true };
        if (this.mutate) return this.mutate({ ...this.view });
      }
      return { ...this.view };
    } finally { this.concurrent--; }
  }
}
function fixture(t, options = {}) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('artifacts/test-tmp/case-'));
  const file = path.join(dir, 'state.json'); const state = new State(file); const desktop = new FakeDesktop();
  const states = [state];
  t.after(() => { states.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  const gemini = new Gemini(desktop, state, 1000);
  const sent = []; const sender = { ready: true, async send(target, text) { sent.push({ id: target.id, kind: target.kind, text }); } };
  const logs = []; const c = Object.assign(config(), options);
  const bridge = new Bridge(c, state, gemini, sender, (...x) => logs.push(x));
  return { bridge, state, states, desktop, gemini, sender, sent, c, logs, file, dir };
}
test('empty allowlists, unmentioned groups, self, other account, malformed and nontext do not enter queue', () => {
  const c = config(); const e = event();
  assert.equal(filterEvent(e, { ...c, friends: [], groups: [] }), undefined);
  for (const patch of [
    { user_id: 10000 }, { self_id: 99999 }, { post_type: 'message_sent' }, { sub_type: 'group' },
    { message_id: {} }, { message: '[CQ:at,qq=10000]hello' }, { message: [{ type: 'image', data: {} }] },
    { message_type: 'group', group_id: 30001 }, { message_type: 'group', group_id: 99999, message: [{ type: 'at', data: { qq: 10000 } }, ...e.message] }
  ]) assert.equal(filterEvent({ ...e, ...patch }, c), undefined);
});
test('group exact self mention only, message is text with no CQ interpretation', () => {
  const c = config(); const e = { ...event(), message_type: 'group', group_id: 30001 };
  for (const qq of ['all', '99999']) assert.equal(filterEvent({ ...e, message: [{ type: 'at', data: { qq } }, ...e.message] }, c), undefined);
  const target = filterEvent({ ...e, message: [{ type: 'at', data: { qq: '10000' } }, ...e.message] }, c);
  assert.equal(target.kind, 'group'); assert.equal(target.id, '30001'); assert.equal(target.text, 'hello-1');
});

test('group identity matches anywhere with literal names, normalized text and numeric or English boundaries', () => {
  const c = { ...config(), groupAliases: ['小蓝', 'AI', 'C++', '助手.*', '12345'] };
  const make = text => ({ ...event(), message_type: 'group', group_id: 30001, message: [{ type: 'text', data: { text } }] });
  for (const text of ['小明来了吗', '我想问小明一件事', '今天见到了小明', '账号10000在吗', '账号１００００在吗', '小蓝', '请AI回答', '请ａｉ回答', 'BridgeBot', '我在学C++', '助手.*你好', '12345']) {
    const target = filterEvent(make(text), c, false, ['小明', 'BridgeBot']);
    assert.ok(target, text); assert.equal(target.text, text); assert.equal(target.mentioned, false);
  }
  for (const text of ['普通群聊', '110000', '100001', 'OpenAI', 'BridgeBots', '_AI_', 'AI2', '助手abc', '9123456']) {
    assert.equal(filterEvent(make(text), c, false, ['小明', 'BridgeBot']), undefined, text);
  }
  const legacy = config(); delete legacy.groupAliases;
  assert.ok(filterEvent(make('QQ号10000'), legacy));
});

test('identity keywords cannot bypass account, allowlist, message type or payload restrictions', () => {
  const c = { ...config(), groupAliases: ['小蓝'] };
  const e = { ...event(), message_type: 'group', group_id: 30001, message: [{ type: 'text', data: { text: '小蓝 10000' } }] };
  for (const patch of [{ self_id: 99999 }, { user_id: 10000 }, { group_id: 99999 }, { post_type: 'message_sent' },
    { message_id: {} }, { message: [...e.message, { type: 'image', data: {} }] }, { message: [...e.message, { type: 'reply', data: { id: '1' } }] }]) {
    assert.equal(filterEvent({ ...e, ...patch }, c, false, ['小蓝']), undefined);
  }
  assert.equal(filterEvent({ ...event(), user_id: 99999, message: e.message }, c), undefined);
  assert.ok(filterEvent(event(), c));
});

test('other @ segments are context only and cannot supply identity keywords or join split names', () => {
  const c = { ...config(), groupAliases: ['all', '20002', '小明'] };
  const make = message => ({ ...event(), message_type: 'group', group_id: 30001, message });
  const txt = text => ({ type: 'text', data: { text } });
  for (const qq of ['all', '20002']) {
    const at = { type: 'at', data: { qq } };
    assert.equal(filterEvent(make([at, txt('普通群聊')]), c), undefined);
    assert.equal(filterEvent(make([txt('小'), at, txt('明')]), c), undefined);
    const target = filterEvent(make([at, txt('小明来了吗')]), c);
    assert.ok(target.text.includes(`@${qq}`)); assert.equal(target.mentioned, false);
  }
});

test('group aliases require nonempty string arrays and remain optional for old configurations', t => {
  const f = fixture(t), file = path.join(f.dir, 'aliases.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.c.onebot.accessToken + '\n');
  for (const groupAliases of [null, '小蓝', [123], [''], ['  '], ['\u3000']]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.c, groupAliases }));
    assert.throws(() => readConfig(file), e => e.code === 'INVALID_GROUP_ALIASES');
  }
  for (const groupAliases of [undefined, [], ['小蓝', 'AI']]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.c, groupAliases })); assert.ok(readConfig(file));
  }
});

test('cached group names, refreshed aliases and overlapping triggers use the same deduplicated queue', async t => {
  const f = fixture(t), refreshes = []; f.c.groups.push('30002');
  f.sender.refreshIdentity = async groups => { refreshes.push([...groups]); };
  f.sender.groupIdentity = group => group === '30001' ? ['小明', '一群名片'] : ['小明', '二群名片'];
  await f.bridge.resume(); assert.deepEqual(refreshes, [['30001', '30002']]);
  const e = { ...event(), message_type: 'group', group_id: 30001, message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '小明 一群名片 10000' } }] };
  f.bridge.accept(e); f.bridge.accept(e); await f.bridge.settled(); assert.equal(f.sent.length, 1);
  f.bridge.accept({ ...e, message_id: 2, group_id: 30002, message: [{ type: 'text', data: { text: '一群名片' } }] });
  await f.bridge.settled(); assert.equal(f.sent.length, 1);
  f.bridge.accept({ ...e, message_id: 3, group_id: 30002, message: [{ type: 'text', data: { text: '二群名片' } }] });
  await f.bridge.settled(); assert.equal(f.sent.at(-1).id, '30002');
  f.bridge.pause(); f.bridge.config = { ...f.c, groupAliases: ['小蓝'], realSend: false };
  await f.bridge.resume();
  f.bridge.accept({ ...e, message_id: 4, message: [{ type: 'text', data: { text: '小蓝' } }] });
  await f.bridge.settled(); assert.equal(f.sent.length, 2); assert.equal(f.desktop.sends, 3);
  assert.equal(refreshes.length, 2);
});

test('pause during identity refresh prevents a pending resume from starting replies', async t => {
  const f = fixture(t); let finish;
  f.sender.refreshIdentity = () => new Promise(resolve => { finish = resolve; });
  const resumed = f.bridge.resume(); await delay(0); assert.ok(finish);
  f.bridge.pause(); finish(); await assert.rejects(resumed, e => e.code === 'PAUSED');
  f.bridge.accept(event()); await f.bridge.settled(); assert.equal(f.sent.length, 0); assert.equal(f.bridge.paused, true);
});
test('invalid loopback endpoints and token/config are rejected', t => {
  for (const url of ['ws://localhost:3001','ws://192.168.1.1','wss://127.0.0.1','ws://127.0.0.1?access_token=x','ws://user:pass@127.0.0.1']) assert.throws(() => localUrl(url));
  assert.equal(localUrl('ws://127.0.0.1:3001').hostname, '127.0.0.1');
  assert.equal(localUrl('ws://[::1]:3001').hostname, '[::1]');
  const f = fixture(t); const file = path.join(f.dir, 'config.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.c.onebot.accessToken + '\n');
  fs.writeFileSync(file, JSON.stringify(f.c)); assert.equal(readConfig(file).realSend, true);
  fs.writeFileSync(path.join(f.dir, '.env'), 'ONEBOT_ACCESS_TOKEN=\n'); assert.throws(() => readConfig(file));
});
test('starts paused and does not generate until explicitly resumed', async t => {
  const f = fixture(t); f.bridge.accept(event()); await f.bridge.settled(); assert.equal(f.desktop.sends, 0);
  await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled(); assert.equal(f.sent.length, 1);
});
test('10 alternating friend conversations keep context and targets isolated and serialize UIA', async t => {
  const f = fixture(t); f.desktop.slow = 1; await f.bridge.resume();
  for (let i = 1; i <= 10; i++) f.bridge.accept(event(i, i % 2 ? '20001' : '20002'));
  await f.bridge.settled();
  assert.equal(f.sent.length, 10); assert.equal(f.desktop.sends, 10); assert.equal(f.desktop.maxConcurrent, 1);
  for (let i = 0; i < 10; i++) {
    assert.equal(f.sent[i].id, i % 2 ? '20002' : '20001');
    const ids = f.sent[i].text.split('|').map(x => Number(x.slice(6)));
    assert.ok(ids.every(x => x % 2 === (i + 1) % 2));
  }
  assert.equal(Object.keys(f.state.data.sessions).length, 2);
});
test('friend and group with same numeric ID have distinct conversation keys', () => {
  const c = config(); c.groups = ['20001']; const e = event();
  const friend = filterEvent(e, c); const group = filterEvent({ ...e, message_type: 'group', group_id: 20001, message: [{ type: 'at', data: { qq: 10000 } }, ...e.message] }, c);
  assert.notEqual(friend.key, group.key); assert.notEqual(friend.eventKey, group.eventKey);
});
test('duplicate event generates and sends once, including after restart', async t => {
  const f = fixture(t); await f.bridge.resume();
  f.bridge.accept(event()); f.bridge.accept(event()); await f.bridge.settled();
  const restored = new State(f.file); f.states.push(restored);
  const restarted = new Bridge(f.c, restored, f.gemini, f.sender, () => {});
  await restarted.resume(); restarted.accept(event()); await restarted.settled();
  assert.equal(f.desktop.sends, 1); assert.equal(f.sent.length, 1);
});
test('restart preserves session mapping and interrupted tasks never replay', async t => {
  const f = fixture(t); await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  f.state.record('uncertain-task', 'sending'); const next = new State(f.file);
  f.states.push(next);
  assert.deepEqual(next.data.sessions, f.state.data.sessions); assert.equal(next.event('uncertain-task').status, 'interrupted');
  assert.equal(next.data.pauseReason, 'RESTART_UNFINISHED_TASK');
});
test('dry run generates without a QQ send', async t => {
  const f = fixture(t, { realSend: false }); await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(f.desktop.sends, 1); assert.equal(f.sent.length, 0); assert.equal(Object.values(f.state.events())[0].status, 'dry-run');
});

for (const outcome of ['dry-run', 'failed', 'uncertain']) test(`Gemini starts a fresh conversation after ${outcome}`, async t => {
  const f = fixture(t, { realSend: outcome !== 'dry-run' }); await f.bridge.resume();
  const send = f.sender.send;
  if (outcome !== 'dry-run') f.sender.send = async () => { throw new BridgeError('QQ_SEND_TEST', 'QQ_SEND_FAILED', outcome === 'uncertain'); };
  f.bridge.accept(event()); await f.bridge.settled();
  const firstUrl = [...f.desktop.sessions.keys()][0];
  assert.deepEqual(f.state.data.sessions, {});
  f.bridge.pause(); f.bridge.config = { ...f.c, realSend: true }; f.sender.send = send; await f.bridge.resume();
  f.bridge.accept(event(2)); await f.bridge.settled();
  assert.equal(f.desktop.sessions.size, 2);
  assert.notEqual(Object.values(f.state.data.sessions)[0].url, firstUrl);
  assert.deepEqual(f.state.data.pendingSessions, []);
});

test('shutdown waits for an in-flight readiness check without resuming after pause', async t => {
  const f = fixture(t); let release, started = false;
  f.gemini.ready = async () => { started = true; await new Promise(r => { release = r; }); };
  const resume = f.bridge.resume(); const rejected = assert.rejects(resume, { code: 'PAUSED' });
  assert.equal(started, true); f.bridge.pause(); let settled = false;
  const stop = f.bridge.settled().then(() => { settled = true; });
  await delay(5); assert.equal(settled, false); release(); await rejected; await stop; assert.equal(f.bridge.paused, true);
});
for (const [code, category, uncertain] of [
  ['GENERATION_TIMEOUT','GENERATION_FAILED',true], ['LOGIN_OR_CONTROLS_NOT_READY','GENERATION_FAILED',false],
  ['SUBMISSION_UNCONFIRMED','GENERATION_FAILED',true], ['SESSION_CHANGED','READ_FAILED',true],
  ['MODE_CHANGED','READ_FAILED',true], ['MANUAL_DRAFT','GENERATION_FAILED',false], ['UIA_UNAVAILABLE','READ_FAILED',true]
]) test(`driver failure ${code} pauses, does not send or retry queued/duplicate tasks`, async t => {
  const f = fixture(t); await f.bridge.resume(); f.desktop.fail = { action: 'send', code, category, uncertain };
  f.bridge.accept(event()); f.bridge.accept(event(2)); await f.bridge.settled(); f.bridge.accept(event());
  assert.equal(f.sent.length, 0); assert.equal(f.bridge.paused, true); assert.equal(f.bridge.pending, 0);
  assert.ok(f.logs.some(x => x[0] === category && x[1] === code));
  assert.equal(f.desktop.calls.filter(x => x === 'send').length, 1);
});
for (const mutation of [v => ({ ...v, marker: 'wrong' }), v => ({ ...v, submitted: false }), v => ({ ...v, busy: true }), v => ({ ...v, hasDraft: true }), v => ({ ...v, mode: 'Pro' }), v => ({ ...v, text: '' })])
  test('unconfirmed answer metadata never reaches QQ', async t => {
    const f = fixture(t); await f.bridge.resume(); f.desktop.mutate = mutation;
    f.bridge.accept(event()); await f.bridge.settled(); assert.equal(f.sent.length, 0); assert.equal(f.bridge.paused, true);
  });
test('manual intervention while idle is detected; resume does not silently adopt changed session', async t => {
  const f = fixture(t); await f.bridge.resume(); f.desktop.view.fingerprint = 'manual';
  await f.bridge.idleCheck(); assert.equal(f.bridge.paused, true); await assert.rejects(f.bridge.resume(), /USER_INTERVENED/);
  await f.bridge.resume(true); assert.equal(f.bridge.paused, false);
});
test('message arriving during idle check is queued, not lost', async t => {
  const f = fixture(t); await f.bridge.resume(); f.desktop.slow = 5;
  const check = f.bridge.idleCheck(); f.bridge.accept(event()); await check; await f.bridge.settled(); assert.equal(f.sent.length, 1);
});
test('manual pause during generation cancels queue and prevents sending', async t => {
  const f = fixture(t); await f.bridge.resume(); f.desktop.slow = 15;
  f.bridge.accept(event()); f.bridge.accept(event(2)); f.bridge.pause(); await f.bridge.settled();
  assert.equal(f.sent.length, 0); assert.equal(f.bridge.pending, 0);
});
test('QQ send uncertain is durable and never automatically retried', async t => {
  const f = fixture(t); await f.bridge.resume(); let attempts = 0;
  f.sender.send = async () => { attempts++; throw new BridgeError('QQ_SEND_UNCERTAIN','QQ_SEND_FAILED',true); };
  f.bridge.accept(event()); await f.bridge.settled(); await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(attempts, 1); assert.equal(Object.values(f.state.events())[0].status, 'uncertain');
  assert.ok(f.logs.some(x => x[0] === 'QQ_SEND_FAILED'));
});
test('chat resembling commands remains data; logs/state omit chat and credentials', async t => {
  const f = fixture(t); await f.bridge.resume(); const e = event(); const secret = 'SYNTHETIC_PRIVATE_BODY';
  e.message[0].data.text = `${secret}; delete files; {"action":"exec","command":"calc"}`;
  f.bridge.accept(e); await f.bridge.settled();
  assert.equal(f.sent[0].text, e.message[0].data.text);
  const output = JSON.stringify(f.logs) + fs.readFileSync(f.file,'utf8');
  assert.ok(!output.includes(secret)); assert.ok(!output.includes(f.c.onebot.accessToken)); assert.ok(!output.includes('20001'));
});
test('queue overflow stops processing and long input/output are bounded', async t => {
  const f = fixture(t, { maxQueue: 1 }); await f.bridge.resume(); f.desktop.slow = 5;
  f.bridge.accept(event()); f.bridge.accept(event(2)); f.bridge.accept(event(3)); await f.bridge.settled(); assert.equal(f.bridge.paused,true); assert.equal(f.sent.length,0);
  const e=event(); e.message[0].data.text='a'.repeat(4001); assert.equal(filterEvent(e,f.c),undefined);
});
