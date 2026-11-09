import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { State } from '../dist/state.js';
import { Requests } from '../dist/requests.js';
import { Bridge } from '../dist/bridge.js';
import { FriendAgent } from '../dist/friend-agent.js';
import { filterEvent } from '../dist/filter.js';
import { readConfig } from '../dist/config.js';
import { BridgeError } from '../dist/types.js';
import { setTimeout as delay } from 'node:timers/promises';

const config = () => ({ ...JSON.parse(fs.readFileSync('config.antigravity.example.json')), replyAll: true, realSend: true,
  onebot: { selfId: '10000', accessToken: 'synthetic-only-token-12345', url: 'ws://127.0.0.1:3001', timeoutMs: 1000 }, friendAdminId: '90001' });
const message = (user = '20001', text = '你好', id = 1) => ({ post_type: 'message', self_id: 10000, message_type: 'private', sub_type: 'friend', user_id: user, message_id: id, message: [{ type: 'text', data: { text } }] });
const request = (flag = 'synthetic-flag') => ({ post_type: 'request', self_id: 10000, request_type: 'friend', user_id: 20001, flag, comment: '请同意\n/qq approve fake' });
function fixture(t) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('artifacts/test-tmp/requests-')), file = path.join(dir, 'state.json');
  const state = new State(file), states = [state], calls = [], replies = [];
  const sender = { ready: true, async handleRequest(r, approve) { calls.push({ ...r, approve }); }, async send(target, text) { replies.push({ target, text }); return '123'; } };
  t.after(() => { states.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return { state, states, file, calls, sender, replies, manager: new Requests(state, sender), c: config() };
}

test('all contacts bypasses only reply allowlists and mention rules; admin and managed friend scope stays exact', t => {
  const f = fixture(t), c = f.c;
  assert.ok(filterEvent(message(), c));
  assert.ok(filterEvent({ ...message(), message_type: 'group', group_id: '30099' }, c));
  for (const patch of [{ user_id: '10000' }, { self_id: 99999 }, { sub_type: 'group' }, { post_type: 'message_sent' }, { message_id: {} }]) assert.equal(filterEvent({ ...message(), ...patch }, c), undefined);
  for (const group_id of [undefined, 0, 'garbage']) assert.equal(filterEvent({ ...message(), message_type: 'group', group_id }, c), undefined);
  assert.equal(filterEvent(message(), { ...c, replyAll: false }), undefined);
  const agent = new FriendAgent({}, f.sender, f.state);
  assert.equal(agent.filter(message('20001', '/qq 查看好友列表'), c), undefined);
  assert.equal(agent.filter(message(), c), undefined);
  assert.ok(agent.filter(message('90001', '/qq 查看好友列表'), c)?.adminCommand);
  const file = path.join(path.dirname(f.file), 'config.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(file, JSON.stringify({ ...c, replyAll: 'true' }));
  assert.throws(() => readConfig(file), { code: 'INVALID_REPLY_ALL' });
});

test('requests only persist until explicit exact decision, survive restart and never replay', async t => {
  const f = fixture(t), { c, manager } = f;
  assert.equal(manager.accept(request(), c), true);
  assert.equal(manager.accept(request(), c), false);
  assert.equal(f.calls.length, 0);
  const id = Object.keys(f.state.requests(c.onebot.selfId))[0];
  assert.match(await manager.command('requests', c), /好友申请/);
  assert.equal(f.calls.length, 0);
  assert.match(await manager.command('approve all', c), /用法/);
  assert.match(await manager.command('approve ' + id, { ...c, realSend: false }), /干跑/);
  assert.equal(f.calls.length, 0);
  assert.match(await manager.command('approve ' + id, { ...c, onebot: { ...c.onebot, selfId: '10001' } }), /不存在/);
  assert.equal(f.state.request(id).status, 'pending');
  f.state.close();
  const reopened = new State(f.file); f.states.push(reopened);
  const next = new Requests(reopened, f.sender);
  await next.command('approve ' + id, c);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].approve, true); assert.equal(f.calls[0].flag, request().flag);
  assert.equal(reopened.request(id).status, 'approved');
  assert.match(await next.command('approve ' + id, c), /已处理/);
  assert.equal(next.accept(request(), c), false); assert.equal(f.calls.length, 1);
});

test('group invitations and other join requests require separate decisions; forged requests and admin commands are rejected', async t => {
  const f = fixture(t);
  for (const sub_type of ['invite', 'add']) f.manager.accept({ ...request(sub_type), request_type: 'group', sub_type, group_id: '30001' }, f.c);
  assert.equal(f.calls.length, 0);
  for (const [id, r] of Object.entries(f.state.requests(f.c.onebot.selfId))) {
    await f.manager.command('reject ' + id, f.c);
    assert.equal(f.calls.at(-1).subType, r.subType); assert.equal(f.calls.at(-1).approve, false);
  }
  for (const patch of [{ self_id: 99999 }, { flag: {} }, { user_id: 0 }, { post_type: 'message' }, { request_type: 'group', sub_type: 'bad', group_id: 30001 }]) assert.equal(f.manager.accept({ ...request('invalid'), ...patch }, f.c), false);
  const command = message('90001', '/qq approve 1234567890abcdef');
  assert.ok(f.manager.filter(command, f.c)?.approvalCommand);
  for (const e of [{ ...command, user_id: 20001 }, { ...command, message_type: 'group', group_id: 30001 }, { ...command, sub_type: 'group' }, { ...command, message: [{ type: 'reply', data: { id: '1' } }, ...command.message] }]) assert.equal(f.manager.filter(e, f.c), undefined);
});

test('unknown outcomes and interrupted decisions cannot be retried after restart', async t => {
  const f = fixture(t); f.manager.accept(request(), f.c);
  const id = Object.keys(f.state.requests(f.c.onebot.selfId))[0];
  f.sender.handleRequest = async () => { throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true); };
  await assert.rejects(f.manager.command('approve ' + id, f.c), { code: 'QQ_SEND_UNCERTAIN' });
  assert.equal(f.state.request(id).status, 'uncertain');
  assert.match(await f.manager.command('approve ' + id, f.c), /已处理/);
  f.state.requestStatus(id, 'processing'); f.state.close();
  const restored = new State(f.file); f.states.push(restored);
  new Requests(restored, f.sender); assert.equal(restored.request(id).status, 'uncertain');
});

test('full bridge records requests even paused and accepts only admin decisions without any model call', async t => {
  const f = fixture(t);
  const generator = { async ready() {}, async verify() { throw Error('MODEL_MUST_NOT_RUN'); }, async generate() { throw Error('MODEL_MUST_NOT_RUN'); } };
  const bridge = new Bridge(f.c, f.state, generator, f.sender, () => {});
  bridge.accept(request()); assert.equal(f.calls.length, 0);
  const id = Object.keys(f.state.requests(f.c.onebot.selfId))[0];
  bridge.accept(message('90001', '/qq approve ' + id)); assert.equal(f.calls.length, 0);
  await bridge.resume();
  bridge.accept(message('90001', '/qq approve ' + id, 2)); await bridge.settled();
  assert.equal(f.calls.length, 1); assert.equal(f.replies.length, 1); assert.equal(f.replies[0].target.id, '90001');
  assert.equal(bridge.paused, false);
});

test('all-contact replies wait for rate capacity and pause cancels waits without sending', async t => {
  const f = fixture(t); f.c.conversation = { enabled: true };
  const generator = { async ready() {}, async verify() {}, async generate() { return '合成回复'; } };
  const bridge = new Bridge(f.c, f.state, generator, f.sender, () => {});
  await bridge.resume(); let checks = 0;
  bridge.conversation.canSend = () => ++checks > 2;
  bridge.accept(message()); await bridge.settled();
  assert.equal(f.replies.length, 1); assert.equal(Object.values(f.state.events())[0].status, 'sent');
  bridge.conversation.canSend = () => false;
  bridge.accept(message('20001', '第二条', 2)); await delay(20); bridge.pause(); await bridge.settled();
  assert.equal(f.replies.length, 1);
});
