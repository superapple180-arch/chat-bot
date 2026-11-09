import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Voice, parseReply, runVoiceProcess } from '../dist/voice.js';
import { Bridge } from '../dist/bridge.js';
import { BridgeError } from '../dist/types.js';
import { State } from '../dist/state.js';
import { ChatStore } from '../dist/chat.js';
import { readConfig } from '../dist/config.js';
import { publicConfig, saveWebConfig } from '../dist/web-config.js';

function fixture(t, cleanup = true) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/voice-'));
  fs.mkdirSync(path.join(root, 'assets/voice'), { recursive: true });
  fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const clip = { id: 'night', file: 'night.wav', text: '晚安', description: '道晚安' };
function catalog(root, clips = [clip]) { fs.writeFileSync(path.join(root, 'assets/voice/index.json'), JSON.stringify(clips)); }
function wav(seconds = 1) {
  const data = Buffer.alloc(44 + 48000 * seconds);
  data.write('RIFF'); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8); data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22); data.writeUInt32LE(24000, 24); data.writeUInt32LE(48000, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(data.length - 44, 40);
  return data;
}
function configuration() {
  const c = JSON.parse(fs.readFileSync('config.example.json'));
  return { ...c, voice: { enabled: true }, friends: ['20001'], groups: ['30001'], onebot: { ...c.onebot, selfId: '10000', accessToken: 'synthetic-voice-token-00000' }, realSend: true };
}
function event(id = 1, group = false) {
  return { post_type: 'message', message_type: group ? 'group' : 'private', sub_type: 'friend', self_id: '10000', user_id: '20001', message_id: id,
    ...(group ? { group_id: '30001' } : {}), message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text: '晚安' } }] };
}

test('reply choices keep plain text compatible, parse fenced JSON, use actual clip text and reject invalid envelopes', () => {
  assert.deepEqual(parseReply('普通文字', []), { kind: 'text', text: '普通文字' });
  assert.deepEqual(parseReply('```json\n{"kind":"tts","text":"你好"}\n```', []), { kind: 'tts', text: '你好' });
  assert.deepEqual(parseReply('{"kind":"text","text":"文字"}', []), { kind: 'text', text: '文字' });
  assert.deepEqual(parseReply('{"kind":"clip","clipId":"night"}', [clip]), { kind: 'clip', text: '晚安', clip });
  for (const bad of ['{', '{"kind":"tts","text":""}', '{"kind":"other","text":"x"}', '{"kind":"clip","clipId":"unknown"}', '{"kind":"tts","text":"x","file":"C:/secret"}', '{"kind":"clip","clipId":"night","text":"伪造"}']) assert.throws(() => parseReply(bad, [clip]), { code: 'INVALID_REPLY_CHOICE' });
});

test('catalog excludes paths from model input and rejects duplicate or malformed entries', t => {
  const root = fixture(t), service = new Voice(root);
  assert.deepEqual(service.catalog(), []); catalog(root);
  assert.deepEqual(service.catalog(), [clip]);
  const prompt = service.prompt(service.catalog());
  assert.ok(prompt.includes('night')); assert.ok(!prompt.includes('night.wav'));
  for (const rows of [[clip, clip], [{ ...clip, text: '' }], [{ ...clip, id: '../escape' }], {}, Array(101).fill(clip)]) {
    catalog(root, rows); assert.throws(() => service.catalog(), { code: 'INVALID_VOICE_CATALOG' });
  }
});

test('audio library is normalized locally, never modified, validates duration and cleans only owned jobs', async t => {
  const root = fixture(t), service = new Voice(root), original = wav();
  fs.writeFileSync(path.join(root, 'assets/voice/night.wav'), original);
  const prepared = await service.prepare({ kind: 'clip', text: clip.text, clip }, { enabled: true });
  assert.ok(fs.existsSync(prepared.file)); assert.deepEqual(fs.readFileSync(path.join(root, 'assets/voice/night.wav')), original);
  prepared.dispose(true); assert.ok(fs.existsSync(prepared.file));
  const job = path.dirname(prepared.file); fs.utimesSync(job, new Date(0), new Date(0));
  const unrelated = path.join(root, 'state/voice/keep-me'); fs.mkdirSync(unrelated);
  service.cleanup(); assert.ok(!fs.existsSync(job)); assert.ok(fs.existsSync(unrelated));
  fs.writeFileSync(path.join(root, 'assets/voice/night.wav'), wav(61));
  await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip }, { enabled: true }), { code: 'VOICE_DURATION_INVALID' });
});

test('voice preparation blocks path escapes, absolute paths, URLs, oversized files, redacted clips and long synthesis before execution', async t => {
  const root = fixture(t); let runs = 0;
  const service = new Voice(root, async () => { runs++; return ''; });
  fs.writeFileSync(path.join(root, 'secret.wav'), wav());
  for (const file of ['../../secret.wav', path.join(root, 'secret.wav'), 'https://example.com/voice.mp3']) {
    await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip: { ...clip, file } }, { enabled: true }), { code: 'VOICE_PATH_DENIED' });
  }
  const big = path.join(root, 'assets/voice/night.wav'); fs.writeFileSync(big, Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip }, { enabled: true }), { code: 'VOICE_FILE_TOO_LARGE' });
  await assert.rejects(service.prepare({ kind: 'clip', text: '＊＊＊', clip }, { enabled: true }), { code: 'VOICE_CLIP_REDACTED' });
  await assert.rejects(service.prepare({ kind: 'tts', text: '啊'.repeat(201) }, { enabled: true }), { code: 'VOICE_TEXT_TOO_LONG' });
  assert.equal(runs, 0); assert.deepEqual(fs.readdirSync(path.join(root, 'state/voice')), []);
});

test('corrupt audio and absent library files fail before a voice can be sent; cancelled synthesis removes temporary files', async t => {
  const root = fixture(t), service = new Voice(root);
  await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip }, { enabled: true }), { code: 'VOICE_PREPARE_FAILED' });
  fs.writeFileSync(path.join(root, 'assets/voice/night.wav'), 'invalid audio');
  await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip }, { enabled: true }), { code: 'VOICE_PROCESS_FAILED' });
  const controller = new AbortController();
  const cancelling = new Voice(root, async () => { controller.abort(); throw Error('stopped'); });
  await assert.rejects(cancelling.prepare({ kind: 'tts', text: '你好' }, { enabled: true }, controller.signal), { code: 'PAUSED' });
  assert.deepEqual(fs.readdirSync(path.join(root, 'state/voice')), []);
  await assert.rejects(runVoiceProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], '', controller.signal), { code: 'PAUSED' });
});

test('directory links cannot escape the library and cancelling a running subprocess settles promptly', async t => {
  const root = fixture(t), outside = path.join(root, 'outside'), service = new Voice(root);
  fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.wav'), wav());
  fs.symlinkSync(outside, path.join(root, 'assets/voice/escape'), 'junction');
  await assert.rejects(service.prepare({ kind: 'clip', text: clip.text, clip: { ...clip, file: 'escape/secret.wav' } }, { enabled: true }), { code: 'VOICE_PATH_DENIED' });
  const controller = new AbortController(), start = Date.now();
  const task = runVoiceProcess(process.execPath, ['-e', 'setTimeout(()=>{},30000)'], '', controller.signal);
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(task, { code: 'PAUSED' }); assert.ok(Date.now() - start < 3000);
});

function bridgeFixture(t, raw) {
  const root = fixture(t, false), state = new State(path.join(root, 'state/events.json')), chat = new ChatStore(path.join(root, 'state/chat.sqlite'));
  const c = configuration(), sent = [], logs = [], requests = [], answers = [], statuses = [], prepared = [];
  const service = new Voice(root);
  service.prepare = async (choice, config, signal) => { prepared.push({ choice, config, signal }); return { file: 'synthetic.wav', dispose: uncertain => { prepared.at(-1).uncertain = uncertain; } }; };
  const sender = { ready: true, async send(t, text, face) { sent.push({ kind: 'text', target: t.id, text, face }); return 'text-id'; }, async sendVoice(t, file) { sent.push({ kind: 'voice', target: t.id, file }); return 'voice-id'; } };
  const generator = { async ready() {}, async verify() {}, async generate(...args) { requests.push(args); return raw; } };
  const memory = { store: { capture() {}, recall() {}, answer(a, target, text) { answers.push(text); }, status(a, key, status) { statuses.push(status); } } };
  const bridge = new Bridge(c, state, generator, sender, (...r) => logs.push(r), memory, undefined, undefined, chat, service);
  t.after(async () => { bridge.pause(); await bridge.settled(); chat.close(); state.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, state, c, sent, logs, requests, answers, statuses, prepared, sender, generator, service, bridge, chat };
}

for (const group of [false, true]) test(`AI synthesis sends one voice, retains only sanitized actual text and confirms memory (${group ? 'group' : 'private'})`, async t => {
  const f = bridgeFixture(t, '{"kind":"tts","text":"你好 synthetic-voice-token-00000"}');
  f.c.conversation = { enabled: true };
  await f.bridge.resume(); f.bridge.accept(event(1, group)); await f.bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'voice'); assert.equal(f.sent[0].target, group ? '30001' : '20001');
  assert.equal(f.requests.length, 1); assert.ok(f.requests[0][2].includes('本轮输出协议'));
  assert.equal(f.prepared[0].choice.text, '你好 ＊＊＊'); assert.equal(f.prepared[0].uncertain, false);
  assert.deepEqual(f.answers, ['你好 ＊＊＊']); assert.equal(f.statuses.at(-1), 'sent');
  const rows = f.chat.messages('10000', group ? 'group' : 'private', group ? '30001' : '20001');
  assert.equal(rows.find(r => r.source === 'ai').body, '你好 ＊＊＊');
  assert.equal(f.bridge.paused, false);
});

test('AI clip selection uses registered content in memory and chat, with no path in the model prompt', async t => {
  const f = bridgeFixture(t, '{"kind":"clip","clipId":"night"}'); catalog(f.root);
  await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(f.sent[0].kind, 'voice'); assert.deepEqual(f.answers, ['晚安']);
  assert.ok(!f.requests[0][2].includes('night.wav')); assert.equal(f.prepared[0].choice.clip.id, 'night');
});

test('pre-send synthesis failures fall back to exactly one sanitized text; dry runs do not synthesize or send', async t => {
  for (const dry of [false, true]) {
    const f = bridgeFixture(t, '{"kind":"tts","text":"你好"}'); f.c.realSend = !dry;
    let attempts = 0; f.service.prepare = async () => { attempts++; throw new BridgeError('VOICE_PROCESS_FAILED', 'VOICE'); };
    await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
    assert.equal(attempts, dry ? 0 : 1); assert.equal(f.sent.length, dry ? 0 : 1);
    if (!dry) assert.equal(f.sent[0].text, '你好');
    assert.equal(f.bridge.paused, false); assert.equal(f.statuses.at(-1), dry ? 'dry-run' : 'sent');
  }
});

for (const uncertain of [false, true]) test(`voice send failure never falls back or retries, and persists ${uncertain ? 'uncertain' : 'failed'}`, async t => {
  const f = bridgeFixture(t, '{"kind":"tts","text":"你好"}');
  f.sender.sendVoice = async () => { f.sent.push({ kind: 'voice' }); throw new BridgeError(uncertain ? 'QQ_SEND_UNCERTAIN' : 'QQ_SEND_REJECTED', 'QQ_SEND_FAILED', uncertain); };
  await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'voice'); assert.equal(f.bridge.paused, true);
  assert.equal(f.prepared[0].uncertain, uncertain); assert.equal(f.statuses.at(-1), uncertain ? 'uncertain' : 'failed');
  await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled(); assert.equal(f.sent.length, 1);
});

test('pause during preparation suppresses both late voice and text fallback', async t => {
  const f = bridgeFixture(t, '{"kind":"tts","text":"你好"}');
  f.service.prepare = async () => { f.bridge.pause(); return { file: 'late.wav', dispose() {} }; };
  await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(f.sent.length, 0); assert.equal(f.bridge.paused, true); assert.equal(f.statuses.at(-1), 'failed');
});

test('text selection and plain text stay text; invalid choices pause; manual sending never enters voice protocol', async t => {
  for (const raw of ['纯文字', '{"kind":"text","text":"纯文字"}', '{"kind":"clip","clipId":"missing"}']) {
    const f = bridgeFixture(t, raw);
    await f.bridge.resume(); f.bridge.accept(event()); await f.bridge.settled();
    const invalid = raw.includes('missing'); assert.equal(f.sent.length, invalid ? 0 : 1);
    if (!invalid) assert.equal(f.sent[0].text, '纯文字');
    assert.equal(f.bridge.paused, invalid); assert.equal(f.prepared.length, 0);
  }
  const f = bridgeFixture(t, 'unused'); await f.bridge.resume();
  f.chat.capture('10000', { kind: 'private', id: '20001', eventKey: 'known', text: 'x' });
  await f.bridge.manualSend('private', '20001', '{"kind":"tts","text":"人工文字"}', 'manual-request-00001'); await f.bridge.settled();
  assert.equal(f.requests.length, 0); assert.equal(f.sent[0].kind, 'text'); assert.equal(f.prepared.length, 0);
});

test('voice configuration validates and survives management saves without requiring a connection restart', t => {
  const root = fixture(t), file = path.join(root, 'config.local.json'), c = configuration();
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(file, JSON.stringify(c));
  const current = publicConfig(root); current.config.voice = { enabled: true, voice: 'zh-CN-XiaoxiaoNeural' };
  assert.equal(saveWebConfig(root, current).restartRequired, false); assert.equal(readConfig(file).voice.voice, 'zh-CN-XiaoxiaoNeural');
  for (const voice of [null, { enabled: 'yes' }, { enabled: true, voice: 'x --command' }, { enabled: true, voice: 3 }]) {
    fs.writeFileSync(file, JSON.stringify({ ...c, voice })); assert.throws(() => readConfig(file), { code: 'INVALID_VOICE_CONFIG' });
  }
  const { voice: _voice, ...legacy } = c; fs.writeFileSync(file, JSON.stringify(legacy)); assert.equal(readConfig(file).voice, undefined);
});
