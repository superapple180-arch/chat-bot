import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { State } from '../dist/state.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { OneBot } from '../dist/onebot.js';
import { Bridge } from '../dist/bridge.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const unlock = acquireLock();
const dir = path.resolve('artifacts/all-replies-' + Date.now()); fs.mkdirSync(dir, { recursive: true });
const report = { at: new Date().toISOString(), realQQ: false, realModel: true, passed: false, checks: [] };
let state, bot, bridge, server;
try {
  const local = readConfig('config.local.json');
  const config = { ...local, replyAll: true, friends: [], groups: [], friendAdminId: '90001', realSend: true, memory: { enabled: false },
    onebot: { selfId: '10000', url: '', accessToken: 'synthetic-only-scope-token', timeoutMs: 2000 }, conversation: { enabled: false } };
  const calls = [], sends = []; let peer;
  server = new WebSocketServer({ host: '127.0.0.1', port: 0, verifyClient: info => info.req.headers.authorization === 'Bearer ' + config.onebot.accessToken });
  await new Promise(resolve => server.on('listening', resolve)); config.onebot.url = `ws://127.0.0.1:${server.address().port}`;
  server.on('connection', socket => { peer = socket; socket.on('message', raw => {
    const m = JSON.parse(raw); calls.push(m); if (m.action.startsWith('send_')) sends.push(m);
    socket.send(JSON.stringify({ echo: m.echo, status: 'ok', retcode: 0, data: m.action === 'get_login_info' ? { user_id: 10000, nickname: '合成机器人' } : m.action === 'get_status' ? { online: true, good: true } : m.action.startsWith('set_') ? null : { message_id: sends.length } }));
  }); });
  state = new State(path.join(dir, 'state.json'));
  bot = new OneBot(config.onebot, event => bridge.accept(event), () => {});
  bridge = new Bridge(config, state, new Antigravity(new AntigravityProcess(config.antigravity, path.join(dir, 'workspace')), state, config.antigravity.model), bot, () => {});
  const until = async (condition, timeout = 10000) => {
    const end = Date.now() + timeout;
    while (!condition()) { if (Date.now() > end || bridge.paused && state.data.pauseReason !== 'STARTUP_PAUSED') throw Error(state.data.pauseReason || 'WAIT_TIMEOUT'); await delay(25); }
  };
  bot.start(); await until(() => bot.ready);
  peer.send(JSON.stringify({ post_type: 'request', request_type: 'friend', self_id: 10000, user_id: 20002, flag: 'synthetic-request', comment: '合成请求，不能自动同意' }));
  await until(() => state.pendingRequests(config.onebot.selfId) === 1);
  assert.equal(calls.filter(m => m.action.startsWith('set_')).length, 0); report.checks.push('request_remains_pending_while_paused');
  await bridge.resume();
  const event = (id, group) => ({ post_type: 'message', self_id: 10000, user_id: 20001, message_type: group ? 'group' : 'private', sub_type: group ? 'normal' : 'friend', message_id: id,
    ...(group ? { group_id: 30099 } : {}), message: [{ type: 'text', data: { text: '合成验收，只回复 ' + (group ? 'ALL_GROUP_OK' : 'ALL_FRIEND_OK') } }] });
  for (const e of [event(1, false), event(2, true)]) { peer.send(JSON.stringify(e)); peer.send(JSON.stringify(e)); }
  await until(() => sends.length === 2, config.antigravity.timeoutMs * 2 + 10000); await bridge.settled();
  assert.equal(sends[0].params.user_id, '20001'); assert.match(sends[0].params.message[0].data.text, /ALL_FRIEND_OK/);
  assert.equal(sends[1].params.group_id, '30099'); assert.match(sends[1].params.message[0].data.text, /ALL_GROUP_OK/);
  assert.equal(Object.keys(state.data.antigravitySessions).length, 2);
  report.checks.push('all_friends_no_allowlist', 'all_groups_no_mention', 'independent_sessions', 'duplicate_events_send_once');
  const id = Object.keys(state.requests(config.onebot.selfId))[0];
  peer.send(JSON.stringify({ ...event(3, false), user_id: 90001, message: [{ type: 'text', data: { text: '/qq approve ' + id } }] }));
  await until(() => sends.length === 3); await bridge.settled();
  assert.deepEqual(calls.filter(m => m.action.startsWith('set_')).map(m => [m.action, m.params.approve]), [['set_friend_add_request', true]]);
  assert.equal(sends[2].params.user_id, '90001');
  report.checks.push('exact_admin_approval_uses_protocol_once'); report.passed = true;
} catch (error) { report.error = error.code ?? error.message; process.exitCode = 1; }
finally {
  bridge?.pause(); await bridge?.settled(); bot?.close();
  for (const socket of server?.clients ?? []) socket.terminate();
  if (server) await new Promise(resolve => server.close(resolve)); state?.close(); unlock();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, directory: dir }));
}
