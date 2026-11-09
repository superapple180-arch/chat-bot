import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { State } from '../dist/state.js';
import { OneBot } from '../dist/onebot.js';
import { Bridge } from '../dist/bridge.js';
import { acquireLock } from '../dist/lock.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
const unlock = acquireLock();
const run = randomUUID();
const file = `artifacts/antigravity-bridge-${run}.json`;
const config = JSON.parse(fs.readFileSync('config.local.json', 'utf8'));
config.onebot = { url: '', selfId: '10000', accessToken: 'synthetic-only-' + run, timeoutMs: 2000 };
config.friends = ['20001']; config.groups = ['30001']; config.realSend = true;
const state = new State(`artifacts/antigravity-bridge-${run}.state.json`);
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => server.on('listening', r));
config.onebot.url = `ws://127.0.0.1:${server.address().port}`;
let peer; const sends = [];
server.on('connection', socket => {
  peer = socket;
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    if (message.action.startsWith('send_')) sends.push(message);
    socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: message.action === 'get_login_info' ? { user_id: 10000 } : message.action === 'get_status' ? { online: true, good: true } : { message_id: sends.length } }));
  });
});
let bridge;
const bot = new OneBot(config.onebot, event => bridge.accept(event), () => {});
bridge = new Bridge(config, state, new Antigravity(new AntigravityProcess(config.antigravity), state, config.antigravity.model), bot, () => {});
const report = { at: new Date().toISOString(), provider: 'real-antigravity-cli', onebot: 'synthetic-loopback-server', realQQ: false, result: 'running' };
async function until(fn, timeout) { const end = Date.now() + timeout; while (!fn()) { if (Date.now() > end || bridge.paused && state.data.pauseReason) throw Error(state.data.pauseReason || 'TEST_TIMEOUT'); await delay(50); } }
try {
  bot.start();
  await new Promise((resolve, reject) => { const end = Date.now() + 5000; const interval = setInterval(() => { if (bot.ready) { clearInterval(interval); resolve(); } else if (Date.now() > end) { clearInterval(interval); reject(Error('SYNTHETIC_CONNECTION_TIMEOUT')); } }, 20); });
  await bridge.resume();
  const make = (id, group) => ({ post_type: 'message', self_id: 10000, user_id: 20001, message_id: id, message_type: group ? 'group' : 'private', sub_type: 'friend', ...(group ? { group_id: 30001 } : {}), message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text: `合成连通性测试。请只回复 QQ_REAL_BRIDGE_${group ? 'GROUP' : 'PRIVATE'}_OK` } }] });
  const first = make(1, false), second = make(2, true);
  for (const event of [first, first, second, second]) peer.send(JSON.stringify(event));
  await until(() => sends.length === 2, config.antigravity.timeoutMs * 2 + 10000);
  await bridge.settled();
  const matched = sends[0].action === 'send_private_msg' && sends[0].params.user_id === '20001' && sends[0].params.message[0].data.text.trim() === 'QQ_REAL_BRIDGE_PRIVATE_OK' && sends[1].action === 'send_group_msg' && sends[1].params.group_id === '30001' && sends[1].params.message[0].data.text.trim() === 'QQ_REAL_BRIDGE_GROUP_OK';
  if (!matched || Object.keys(state.data.antigravitySessions).length !== 2) throw Error('SYNTHETIC_ROUTE_OR_REPLY_MISMATCH');
  Object.assign(report, { result: 'passed', generatedReplies: 2, duplicateEvents: 2, independentSessions: 2, originalTargetsMatched: true });
} catch (error) { Object.assign(report, { result: 'failed', reason: error.message }); process.exitCode = 1; }
finally {
  bridge.pause(); await bridge.settled(); bot.close();
  for (const socket of server.clients) socket.terminate();
  await new Promise(r => server.close(r));
  state.close(); unlock();
}
fs.writeFileSync(file, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ ...report, report: file }));
