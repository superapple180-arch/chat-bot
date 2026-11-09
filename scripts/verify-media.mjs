import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { State } from '../dist/state.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { Bridge } from '../dist/bridge.js';
import { Media } from '../dist/media.js';
import { parseChoice } from '../dist/reply.js';
import { Voice } from '../dist/voice.js';
import { filterEvent } from '../dist/filter.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const unlock = acquireLock(), dir = path.resolve('artifacts/media-live-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const report = { at: new Date().toISOString(), passed: false, qqSent: false, generator: 'real-antigravity-cli', network: 'real-public-sources', cases: [] };
const save = () => fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
let state, bridge;
try {
  const local = readConfig('config.local.json');
  if (local.provider !== 'antigravity') throw Error('ANTIGRAVITY_REQUIRED');
  const allCases = [
    { name: 'local-gif', text: '请发一个带晚安文字的表情包，不要语音，随图文字最多十个字', check: r => r.choice.kind === 'sticker' && r.prepared?.file.endsWith('.gif') },
    { name: 'casual-sticker', text: '哈哈哈，我终于把这个超难的游戏通关啦！开心到起飞！', check: r => r.choice.kind === 'sticker' && Boolean(r.prepared) },
    { name: 'online-photo', text: '请联网找一张真实家猫的照片并发送图片，不要表情包，也不要语音', check: r => r.choice.kind === 'image' && r.prepared?.source.includes('commons.wikimedia.org') },
    { name: 'online-sticker', text: '请发一个熊猫头疑惑的表情包，不要改成其他角色', check: r => r.choice.kind === 'sticker' && r.prepared?.source.includes('ChineseBQB') },
    { name: 'not-found', text: '请找图片 QQ_MEDIA_NONEXISTENT_9fc82d，按这个完整名字联网检索，不用其他图替代，没有结果就说明没找到', check: r => r.choice.kind === 'image' && !r.prepared && r.logs.some(log => log.code === 'MEDIA_NOT_FOUND') && /没找到|找不到|无法找到/.test(r.answer) }
  ];
  const cases = process.argv[2] ? allCases.filter(row => row.name === process.argv[2]) : allCases;
  if (!cases.length) throw Error('UNKNOWN_MEDIA_CASE');
  report.selectedCases = cases.map(row => row.name);
  const config = { ...local, realSend: false, replyAll: false, friends: cases.map((_, i) => String(20001 + i)), groups: [], friendAdminId: '',
    media: { enabled: true, online: true }, voice: { enabled: true }, memory: { enabled: false }, qzone: { enabled: false }, attachments: { enabled: false, localRoots: [] }, conversation: { enabled: false },
    replyStyle: '简短自然地回复。轻松开心的闲聊适度用表情包回应，明确索图时找符合要求的图，没有合适素材如实说明。不调用工具，不声称执行成功。' };
  state = new State(path.join(dir, 'events.json'));
  let current;
  const launch = (...args) => {
    const child = spawn(...args); let buffer = '';
    const observe = line => {
      try {
        const event = JSON.parse(line);
        if (!current) return;
        if (event.event === 'init') current.providerInitialized = true;
        if (event.event === 'step_update' && event.step_update?.step_type !== current.lastProviderStep) {
          current.lastProviderStep = event.step_update?.step_type;
          if (current.lastProviderStep === 'user_input') current.providerInputs = (current.providerInputs ?? 0) + 1;
          save();
        }
      } catch { /* The transport remains responsible for validating raw output. */ }
    };
    child.stdout.on('data', chunk => {
      buffer += chunk;
      while (buffer.includes('\n')) { const at = buffer.indexOf('\n'); observe(buffer.slice(0, at)); buffer = buffer.slice(at + 1); }
    });
    child.once('close', () => { if (buffer.trim()) observe(buffer); });
    return child;
  };
  const generator = new Antigravity(new AntigravityProcess(config.antigravity, undefined, launch), state, config.antigravity.model);
  const generate = generator.generate.bind(generator), media = new Media(), prepare = media.prepare.bind(media), clips = new Voice().catalog();
  generator.generate = async (...args) => { const raw = await generate(...args); current.choice = parseChoice(raw, clips, true, true); save(); return raw; };
  media.prepare = async (...args) => {
    const result = await prepare(...args);
    current.prepared = { file: result.file, description: result.description, source: result.source, sha256: createHash('sha256').update(fs.readFileSync(result.file)).digest('hex') };
    save(); return result;
  };
  const forbidden = async () => { report.qqSent = true; throw Error('QQ_SEND_FORBIDDEN_IN_VERIFIER'); };
  const sender = { ready: true, send: forbidden, sendVoice: forbidden, sendImage: forbidden };
  const chat = { capture() {}, put(_a, _target, _role, text) { current.answer = text; }, status() {} };
  bridge = new Bridge(config, state, generator, sender, (category, code) => { current?.logs.push({ category, code }); console.log(category, code); }, undefined, undefined, undefined, chat, undefined, media);
  await bridge.resume();
  for (let i = 0; i < cases.length; i++) {
    const spec = cases[i]; current = { name: spec.name, logs: [] }; report.cases.push(current); save();
    const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: config.onebot.selfId, user_id: config.friends[i], message_id: i + 1, message: [{ type: 'text', data: { text: spec.text } }] };
    bridge.accept(event); await bridge.settled();
    current.status = state.event(filterEvent(event, config, true).eventKey)?.status;
    current.passed = current.status === 'dry-run' && spec.check(current); save();
    console.log('MEDIA_CASE', spec.name, current.passed ? 'PASS' : 'FAIL');
    if (!current.passed) throw Error('MEDIA_VERIFICATION_FAILED: ' + spec.name);
  }
  report.passed = true;
} catch (e) { report.error = e.code ?? e.message; process.exitCode = 1; }
finally {
  bridge?.pause('VERIFICATION_FINISHED'); await bridge?.settled(); state?.close(); unlock(); save();
  console.log(JSON.stringify({ passed: report.passed, qqSent: report.qqSent, report: path.join(dir, 'report.json'), error: report.error }));
}
