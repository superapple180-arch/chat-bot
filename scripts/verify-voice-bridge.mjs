import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { OneBot } from '../dist/onebot.js';
import { Bridge } from '../dist/bridge.js';
import { State } from '../dist/state.js';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const unlock = acquireLock();
fs.mkdirSync('artifacts/test-tmp', { recursive: true });
const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/live-voice-'));
const state = new State(path.join(root, 'events.json'));
const config = readConfig('config.local.json');
config.voice = { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' };
config.replyAll = false; config.friends = ['20001']; config.groups = ['30001']; config.realSend = true;
config.conversation = { enabled: false }; config.memory = { enabled: false }; config.attachments = { enabled: false, localRoots: [] };
const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise(r => server.on('listening', r));
config.onebot = { url: `ws://127.0.0.1:${server.address().port}`, accessToken: 'synthetic-voice-validation-00000', selfId: '10000', timeoutMs: 2000 };
const sent = [];
server.on('connection', socket => socket.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.action.startsWith('send_')) {
    const segment = message.params.message[0];
    sent.push({ target: message.params.user_id ?? message.params.group_id, kind: segment.type, bytes: segment.type === 'record' ? fs.statSync(fileURLToPath(segment.data.file)).size : 0 });
  }
  socket.send(JSON.stringify({ echo: message.echo, status: 'ok', retcode: 0, data: message.action === 'get_login_info' ? { user_id: '10000', nickname: '合成验证账号' } : message.action === 'get_status' ? { online: true, good: true } : { message_id: sent.length } }));
}));
let bridge;
const bot = new OneBot(config.onebot, e => bridge.accept(e), () => {});
bridge = new Bridge(config, state, new Antigravity(new AntigravityProcess(config.antigravity), state, config.antigravity.model), bot, (category, code) => console.log(category, code));
try {
  bot.start();
  const deadline = Date.now() + 10000;
  while (!bot.ready) { if (Date.now() > deadline) throw Error('MOCK_ONEBOT_TIMEOUT'); await delay(50); }
  await bridge.resume();
  for (const [index, group] of [false, true].entries()) {
    bridge.accept({ post_type: 'message', message_type: group ? 'group' : 'private', sub_type: 'friend', self_id: '10000', user_id: '20001', ...(group ? { group_id: '30001' } : {}), message_id: index + 1,
      message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text: '请用语音说一句简短的晚安，不要超过20个字。' } }] });
    await bridge.settled();
    if (bridge.paused || sent[index]?.kind !== 'record') throw Error('VOICE_BRIDGE_VALIDATION_FAILED');
  }
  const report = { at: new Date().toISOString(), generator: 'real-antigravity-cli', synthesis: 'real-edge-tts', onebot: 'synthetic-loopback-server', realQQ: false, sent, result: 'passed' };
  fs.writeFileSync('artifacts/voice-bridge-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) { console.error(e.code ?? e.message); process.exitCode = 1; }
finally { bridge.pause(); await bridge.settled(); bot.close(); for (const client of server.clients) client.terminate(); await new Promise(r => server.close(r)); state.close(); fs.rmSync(root, { recursive: true, force: true }); unlock(); }
