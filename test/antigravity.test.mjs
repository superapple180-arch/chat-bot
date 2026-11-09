// Public fixture identities below are generated synthetic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { State } from '../dist/state.js';
import { Bridge } from '../dist/bridge.js';
import { OneBot } from '../dist/onebot.js';
import { readConfig } from '../dist/config.js';
const statesByTest = new WeakMap();
const cleanupByTest = new WeakMap();
function openState(t, file) {
  const state = new State(file);
  const states = statesByTest.get(t) ?? []; states.push(state); statesByTest.set(t, states);
  return state;
}

function folder(t) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('artifacts/test-tmp/antigravity-'));
  t.after(async () => { await cleanupByTest.get(t)?.(); statesByTest.get(t)?.forEach(s => s.close()); fs.rmSync(dir, { recursive: true, force: true }); });
  return dir;
}
const settings = () => ({ executable: process.execPath, timeoutMs: 1000, model: '' });
const event = (i, group = false) => ({ post_type: 'message', self_id: 10000, user_id: 20001, message_id: i, message_type: group ? 'group' : 'private', sub_type: 'friend', ...(group ? { group_id: 30001 } : {}), message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text: `${group ? 'G' : 'P'}-${i}` } }] });
class FakeAgent {
  histories = new Map(); concurrent = 0; peak = 0;
  check() {}
  async run(request) {
    this.concurrent++; this.peak = Math.max(this.peak, this.concurrent);
    try {
      await delay(2);
      const id = request.conversationId ?? randomUUID();
      const history = this.histories.get(id) ?? [];
      history.push(JSON.parse(request.prompt.split('聊天内容（JSON 字符串）：\n')[1]));
      this.histories.set(id, history);
      return { conversationId: id, response: history.join('|') };
    } finally { this.concurrent--; }
  }
}
function transport(t, scenario, extra = {}) {
  const dir = folder(t);
  let child, args, options, written = '';
  const launch = (_exe, a, o) => {
    args = a; options = o; child = new EventEmitter();
    child.proofEnv = o.env;
    child.expectedId = a.includes('--conversation') ? a[a.indexOf('--conversation') + 1] : undefined;
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { queueMicrotask(() => child.emit('close', 1)); return true; };
    child.stdin.on('data', x => { written += x; });
    queueMicrotask(() => scenario(child));
    return child;
  };
  const instance = new AntigravityProcess({ ...settings(), ...extra }, dir, launch);
  return { instance, inspect: () => ({ args, options, written }), dir };
}
const emit = (child, event) => {
  if (event.event === 'init') {
    event.conversation_id ??= child.expectedId ?? randomUUID();
    child.initializedId = event.conversation_id;
    if (!child.noProof) fs.writeFileSync(child.proofEnv.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({ nonce: child.proofEnv.QQ_BRIDGE_HOOK_NONCE, conversationId: event.conversation_id }));
  }
  child.stdout.write(JSON.stringify(event) + '\n');
};
test('CLI transport requires hook attestation before forwarding message, keeps prompt out of arguments and resumes explicit ID', async t => {
  const id = randomUUID();
  const f = transport(t, child => {
    assert.equal(f.inspect().written, '');
    emit(child, { event: 'init', init: { tools: ['run_command'] } });
    assert.equal(JSON.parse(f.inspect().written).message.content, 'synthetic-private-text');
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: id, response: '答复' } });
    child.emit('close', 0);
  });
  assert.deepEqual(await f.instance.run({ prompt: 'synthetic-private-text', conversationId: id }), { conversationId: id, response: '答复' });
  assert.ok(!f.inspect().args.join(' ').includes('synthetic-private-text'));
  assert.ok(f.inspect().args.includes('--conversation')); assert.ok(!f.inspect().args.includes('--continue'));
  assert.equal(f.inspect().options.shell, false);
  assert.ok(!f.inspect().args.includes('--dangerously-skip-permissions'));
  const profile = fs.readFileSync(path.join(f.dir, '.agents/agents/qq-reply/agent.md'), 'utf8');
  assert.ok(profile.includes('tools: []')); assert.ok(profile.includes('subagent: false'));
});
test('synthetic attachment runs require proof that every scoped image was viewed and clean those proofs', async t => {
  const f = transport(t, child => {
    emit(child, { event: 'init', init: { tools: ['view_file'] } });
    const request = JSON.parse(fs.readFileSync(path.join(f.dir, '.hook-request.json'), 'utf8'));
    assert.equal(f.inspect().args[f.inspect().args.indexOf('--agent') + 1], 'qq-attachment');
    for (const file of request.attachments) {
      const proof = path.join(f.dir, `.hook-view-${request.nonce}-${createHash('sha256').update(process.platform === 'win32' ? file.path.toLowerCase() : file.path).digest('hex')}.json`);
      fs.writeFileSync(proof, JSON.stringify({ nonce: request.nonce, conversationId: child.initializedId, sha256: file.sha256, stepIdx: 1, completed: true }));
    }
    emit(child, { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'view_file' } });
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: '合成图片描述' } });
    child.emit('close', 0);
  });
  const image = path.join(f.dir, 'synthetic.png'); fs.writeFileSync(image, 'synthetic-only');
  assert.equal((await f.instance.run({ prompt: 'synthetic only', attachmentFiles: [image] })).response, '合成图片描述');
  assert.equal(fs.readdirSync(f.dir).filter(x => x.startsWith('.hook-view-')).length, 0);
});
test('an attachment answer without per-file viewing proof is never accepted', async t => {
  const f = transport(t, child => {
    emit(child, { event: 'init', init: { tools: ['view_file'] } });
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'guessed image description' } });
  });
  const image = path.join(f.dir, 'synthetic.png'); fs.writeFileSync(image, 'synthetic-only');
  await assert.rejects(f.instance.run({ prompt: 'synthetic only', attachmentFiles: [image] }), { code: 'ANTIGRAVITY_ATTACHMENT_NOT_VIEWED' });
});
test('attachment scopes reject outside files, non-images and resumed conversations before launching', async t => {
  const f = transport(t, () => assert.fail('must not launch'));
  const file = path.join(f.dir, 'synthetic.txt'); fs.writeFileSync(file, 'synthetic-only');
  for (const request of [{ attachmentFiles: [] }, { attachmentFiles: [file] }, { attachmentFiles: [path.resolve('README.md')] }, { attachmentFiles: [file], conversationId: randomUUID() }]) {
    await assert.rejects(f.instance.run({ prompt: 'synthetic only', ...request }), { code: 'INVALID_ATTACHMENT_SCOPE' });
  }
});
test('network compatibility applies only to the model child and preserves other Go settings', async t => {
  const inherited = process.env.GODEBUG;
  process.env.GODEBUG = 'http2client=0';
  try {
    const f = transport(t, child => {
      emit(child, { event: 'init', init: { tools: [] } });
      emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'ok' } });
      child.emit('close', 0);
    }, { proxyUrl: 'http://127.0.0.1:7890', tlsCompatibility: true });
    await f.instance.run({ prompt: 'synthetic' });
    const env = f.inspect().options.env;
    assert.equal(env.HTTP_PROXY, 'http://127.0.0.1:7890');
    assert.equal(env.HTTPS_PROXY, env.HTTP_PROXY);
    assert.equal(env.NO_PROXY, 'localhost,127.0.0.1,::1');
    assert.equal(env.GODEBUG, 'http2client=0,tlsmlkem=0');
    assert.equal(process.env.GODEBUG, 'http2client=0');
  } finally {
    if (inherited === undefined) delete process.env.GODEBUG; else process.env.GODEBUG = inherited;
  }
});

test('missing hook attestation or malformed initialization prevents any QQ content reaching Antigravity', async t => {
  for (const init of [{ tools: ['run_command'] }, {}]) {
    const f = transport(t, child => {
      child.noProof = true; emit(child, { event: 'init', init });
      emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'QQ_INIT_READY' } });
    });
    await assert.rejects(f.instance.run({ prompt: 'must-not-be-sent' }), { code: 'ANTIGRAVITY_TOOLS_NOT_DISABLED' });
    assert.ok(!f.inspect().written.includes('must-not-be-sent'));
  }
});
test('a buffered startup turn can close stdin after matching hook proof without resubmitting the actual prompt', async t => {
  const f = transport(t, child => {
    child.noProof = true; emit(child, { event: 'init', init: { tools: [] } });
    assert.equal(f.inspect().written.trim().split('\n').length, 1);
    setTimeout(() => fs.writeFileSync(child.proofEnv.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({ nonce: child.proofEnv.QQ_BRIDGE_HOOK_NONCE, conversationId: child.initializedId })), 5);
    void (async () => {
      while (!child.stdin.writableEnded) await delay(5);
      const messages = f.inspect().written.trim().split('\n').map(line => JSON.parse(line));
      assert.equal(messages.length, 2); assert.equal(messages[1].message.content, 'actual-synthetic-prompt');
      emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'QQ_INIT_READY' } });
      emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'actual answer' } });
      child.emit('close', 0);
    })();
  });
  assert.equal((await f.instance.run({ prompt: 'actual-synthetic-prompt' })).response, 'actual answer');
  assert.equal(f.inspect().written.trim().split('\n').length, 2);
});
test('only synthetic initialization is sent before PreInvocation proof; QQ data follows matching proof', async t => {
  const f = transport(t, child => {
    child.noProof = true; emit(child, { event: 'init', init: { tools: ['write_file'] } });
    const first = JSON.parse(f.inspect().written.trim());
    assert.ok(first.message.content.includes('QQ_INIT_READY'));
    assert.ok(!f.inspect().written.includes('synthetic-private-message'));
    fs.writeFileSync(child.proofEnv.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({ nonce: child.proofEnv.QQ_BRIDGE_HOOK_NONCE, conversationId: child.initializedId }));
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'QQ_INIT_READY' } });
    assert.equal(JSON.parse(f.inspect().written.trim().split('\n')[1]).message.content, 'synthetic-private-message');
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'ok' } });
    child.emit('close', 0);
  });
  assert.equal((await f.instance.run({ prompt: 'synthetic-private-message' })).response, 'ok');
});

test('successful initialization with matching hook proof does not depend on model wording', async t => {
  const f = transport(t, child => {
    child.noProof = true; emit(child, { event: 'init', init: { tools: ['write_file'] } });
    assert.ok(!f.inspect().written.includes('synthetic-private-message'));
    fs.writeFileSync(child.proofEnv.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({ nonce: child.proofEnv.QQ_BRIDGE_HOOK_NONCE, conversationId: child.initializedId }));
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: '连接正常，可以开始聊天。' } });
    assert.equal(JSON.parse(f.inspect().written.trim().split('\n')[1]).message.content, 'synthetic-private-message');
    emit(child, { event: 'result', result: { status: 'SUCCESS', conversation_id: child.initializedId, response: 'actual-reply' } });
    child.emit('close', 0);
  });
  assert.equal((await f.instance.run({ prompt: 'synthetic-private-message' })).response, 'actual-reply');
});

test('failed, empty, wrong-session or mismatched-proof initialization never forwards QQ content', async t => {
  for (const mode of ['failed', 'empty', 'wrong-session', 'wrong-nonce', 'wrong-proof-session']) {
    const f = transport(t, child => {
      child.noProof = true; emit(child, { event: 'init', init: { tools: ['write_file'] } });
      fs.writeFileSync(child.proofEnv.QQ_BRIDGE_HOOK_PROOF, JSON.stringify({
        nonce: mode === 'wrong-nonce' ? randomUUID() : child.proofEnv.QQ_BRIDGE_HOOK_NONCE,
        conversationId: mode === 'wrong-proof-session' ? randomUUID() : child.initializedId
      }));
      emit(child, { event: 'result', result: {
        status: mode === 'failed' ? 'ERROR' : 'SUCCESS',
        conversation_id: mode === 'wrong-session' ? randomUUID() : child.initializedId,
        response: mode === 'empty' ? ' ' : 'QQ_INIT_READY'
      } });
    });
    await assert.rejects(f.instance.run({ prompt: 'must-not-be-sent' }), { code: 'ANTIGRAVITY_TOOLS_NOT_DISABLED', uncertain: false });
    assert.ok(!f.inspect().written.includes('must-not-be-sent'));
  }
});
test('scoped hook blocks external tools, allows reply finalization and leaves other Antigravity sessions unchanged', t => {
  const dir = folder(t);
  const nonce = randomUUID(), conversationId = randomUUID();
  const env = { ...process.env };
  const hook = path.resolve('scripts/antigravity-tools-hook.mjs');
  fs.writeFileSync(path.join(dir, '.hook-request.json'), JSON.stringify({ nonce }));
  const start = spawnSync(process.execPath, [hook, 'start', dir], { env, input: JSON.stringify({ conversationId, workspacePaths: [dir] }), encoding: 'utf8' });
  assert.equal(start.status, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, `.hook-proof-${nonce}.json`))).conversationId, conversationId);
  for (const name of ['run_command', 'write_file', 'write_to_file', 'read_url_content', 'invoke_subagent', 'schedule', 'call_mcp_tool']) {
    const r = spawnSync(process.execPath, [hook, 'tool', dir], { env, input: JSON.stringify({ conversationId, workspacePaths: [dir], toolCall: { name } }), encoding: 'utf8' });
    assert.equal(r.status, 0); assert.equal(JSON.parse(r.stdout).decision, 'deny');
  }
  const r = spawnSync(process.execPath, [hook, 'tool', dir], { env, input: JSON.stringify({ conversationId, workspacePaths: [dir], toolCall: { name: 'finish' } }), encoding: 'utf8' });
  assert.equal(JSON.parse(r.stdout).decision, 'allow');
  const other = spawnSync(process.execPath, [hook, 'tool', dir], { env, input: '{"toolCall":{"name":"run_command"}}', encoding: 'utf8' });
  assert.equal(JSON.parse(other.stdout).decision, 'allow');
});
test('unrequested tool invocation aborts and never returns reply', async t => {
  const f = transport(t, child => {
    emit(child, { event: 'init', init: { tools: [] } });
    emit(child, { event: 'step_update', step_update: { step_type: 'tool', tool_name: 'run_command' } });
  });
  await assert.rejects(f.instance.run({ prompt: 'synthetic' }), { code: 'ANTIGRAVITY_UNEXPECTED_TOOL', uncertain: true });
});
test('wrong conversation, provider errors, empty replies, duplicate results and failed exits fail closed', async t => {
  const id = randomUUID();
  for (const mode of ['wrong-id', 'empty', 'status', 'duplicate', 'exit']) {
    const f = transport(t, child => {
      emit(child, { event: 'init', init: { tools: [] } });
      const r = { event: 'result', result: { status: mode === 'status' ? 'ERROR' : 'SUCCESS', conversation_id: mode === 'wrong-id' ? randomUUID() : id, response: mode === 'empty' ? '' : 'ok' } };
      emit(child, r); if (mode === 'duplicate') emit(child, r);
      child.emit('close', mode === 'exit' ? 1 : 0);
    });
    await assert.rejects(f.instance.run({ prompt: 'synthetic', conversationId: id }));
  }
});
test('malformed output, timeout and cancellation stop the process without retries', async t => {
  const invalid = transport(t, child => child.stdout.write('not-json\n'));
  await assert.rejects(invalid.instance.run({ prompt: 'x' }), { code: 'ANTIGRAVITY_INVALID_OUTPUT' });
  const timeout = transport(t, child => emit(child, { event: 'init', init: { tools: [] } }), { timeoutMs: 25 });
  await assert.rejects(timeout.instance.run({ prompt: 'x' }), { code: 'ANTIGRAVITY_TIMEOUT', uncertain: true });
  const controller = new AbortController();
  const cancel = transport(t, child => { emit(child, { event: 'init', init: { tools: [] } }); controller.abort(); });
  await assert.rejects(cancel.instance.run({ prompt: 'x', signal: controller.signal }), { code: 'PAUSED', uncertain: true });
});
test('Antigravity settings validated while legacy Gemini config stays compatible', t => {
  const dir = folder(t); const file = path.join(dir, 'config.json');
  const c = JSON.parse(fs.readFileSync('config.antigravity.example.json'));
  c.onebot.selfId = '10000'; c.onebot.accessToken = 'synthetic-token-0123456789';
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(file, JSON.stringify(c)); assert.equal(readConfig(file).provider, 'antigravity');
  for (const patch of [{ timeoutMs: 0 }, { timeoutMs: 300001 }, { executable: 'agy.cmd' }, { model: '--unsafe arg' }, { tlsCompatibility: 'true' }, { proxyUrl: 'http://example.com:7890' }, { proxyUrl: 'https://127.0.0.1:7890' }, { proxyUrl: 'http://user:pass@127.0.0.1:7890' }, { proxyUrl: 'http://127.0.0.1:7890/path' }, { proxyUrl: 'invalid' }]) {
    fs.writeFileSync(file, JSON.stringify({ ...c, antigravity: { ...c.antigravity, ...patch } })); assert.throws(() => readConfig(file));
  }
});
test('persistent Antigravity sessions remain isolated, survive restart and reject cross-target IDs', async t => {
  const file = path.join(folder(t), 'state.json'); const state = openState(t, file); const fake = new FakeAgent();
  let agent = new Antigravity(fake, state);
  assert.equal(await agent.generate('A', 'A-one', ''), 'A-one');
  state.confirmReply('A');
  assert.equal(await agent.generate('B', 'B-one', ''), 'B-one');
  state.confirmReply('B');
  const restored = openState(t, file);
  agent = new Antigravity(fake, restored);
  assert.equal(await agent.generate('A', 'A-two', ''), 'A-one|A-two');
  restored.confirmReply('A');
  const saved = openState(t, file); const bad = { check() {}, async run() { return { conversationId: saved.data.antigravitySessions.A.id, response: 'wrong-target' }; } };
  await assert.rejects(new Antigravity(bad, saved).generate('C', 'x', ''), { code: 'ANTIGRAVITY_SESSION_MISMATCH' });
  await assert.rejects(new Antigravity(fake, saved, 'different-model').generate('A', 'x', ''), { code: 'ANTIGRAVITY_SESSION_MODEL_CHANGED' });
  assert.ok(!fs.readFileSync(file, 'utf8').includes('A-one'));
});
test('full OneBot socket to Antigravity adapter: 10 alternating targets, deduplication, allowlists, original destination', async t => {
  const dir = folder(t); const c = JSON.parse(fs.readFileSync('config.antigravity.example.json'));
  c.onebot.selfId = '10000'; c.onebot.accessToken = 'synthetic-token-0123456789'; c.onebot.timeoutMs = 500;
  c.friends = ['20001']; c.groups = ['30001']; c.realSend = true;
  const state = openState(t, path.join(dir, 'state.json')); const fake = new FakeAgent();
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await new Promise(r => server.on('listening', r));
  c.onebot.url = `ws://127.0.0.1:${server.address().port}`;
  let peer; const sends = [];
  server.on('connection', s => { peer = s; s.on('message', raw => {
    const m = JSON.parse(raw); if (m.action.startsWith('send_')) sends.push(m);
    s.send(JSON.stringify({ echo: m.echo, status: 'ok', retcode: 0, data: m.action === 'get_login_info' ? { user_id: 10000, nickname: '合成昵称甲' } : m.action === 'get_status' ? { online: true } : m.action === 'get_group_member_info' ? { user_id: 10000, group_id: m.params.group_id, card: '合成昵称乙' } : { message_id: sends.length } }));
  }); });
  let bridge;
  const bot = new OneBot(c.onebot, e => bridge.accept(e), () => {}, c.groups);
  bridge = new Bridge(c, state, new Antigravity(fake, state), bot, () => {});
  cleanupByTest.set(t, async () => { bridge.pause(); await bridge.settled(); bot.close(); for (const s of server.clients) s.terminate(); await new Promise(r => server.close(r)); });
  bot.start();
  const until = async fn => { const end = Date.now() + 4000; while (!fn()) { if (Date.now() > end) throw Error('WAIT_TIMEOUT'); await delay(5); } };
  await until(() => bot.ready); await bridge.resume();
  for (let i = 1; i <= 10; i++) { const e = event(i, i % 2 === 0); peer.send(JSON.stringify(e)); peer.send(JSON.stringify(e)); }
  peer.send(JSON.stringify({ ...event(11), user_id: 99999 }));
  peer.send(JSON.stringify({ ...event(12, true), message: [{ type: 'text', data: { text: 'unmentioned' } }] }));
  await until(() => sends.length === 10); await bridge.settled();
  assert.equal(fake.histories.size, 2); assert.equal(fake.peak, 1); assert.equal(sends.length, 10);
  sends.forEach((s, i) => {
    const group = i % 2 === 1;
    assert.equal(s.action, group ? 'send_group_msg' : 'send_private_msg');
    assert.equal(s.params[group ? 'group_id' : 'user_id'], group ? '30001' : '20001');
    assert.ok(s.params.message[0].data.text.split('|').every(x => x.startsWith(group ? 'G-' : 'P-')));
  });
  const keyword = { ...event(13, true), message: [{ type: 'text', data: { text: '合成昵称甲 合成昵称乙 10000 在吗' } }] };
  peer.send(JSON.stringify(keyword)); peer.send(JSON.stringify(keyword));
  await until(() => sends.length === 11); await bridge.settled();
  assert.equal(fake.histories.size, 2); assert.equal(fake.peak, 1);
  assert.equal(sends[10].action, 'send_group_msg'); assert.equal(sends[10].params.group_id, '30001');
  assert.ok(sends[10].params.message[0].data.text.includes('合成昵称甲 合成昵称乙 10000 在吗'));
});
