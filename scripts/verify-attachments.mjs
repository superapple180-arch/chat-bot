import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';
import ffmpeg from 'ffmpeg-static';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { State } from '../dist/state.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { Bridge } from '../dist/bridge.js';
import { filterEvent } from '../dist/filter.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const unlock = acquireLock();
const dir = path.resolve('artifacts/attachments-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const report = { at: new Date().toISOString(), passed: false, qqSent: false, cases: [] };
let state, bridge;
try {
  const local = readConfig('config.local.json');
  if (local.provider !== 'antigravity') throw Error('ANTIGRAVITY_REQUIRED');
  const image = path.join(dir, 'synthetic.png');
  await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="white"/><circle cx="100" cy="100" r="60" fill="red"/><rect x="240" y="50" width="100" height="100" fill="blue"/></svg>')).png().toFile(image);
  const video = path.join(dir, 'synthetic.mp4');
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x120:r=1:d=10', '-f', 'lavfi', '-i', 'color=c=green:s=160x120:r=1:d=10', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=1:d=10', '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0', '-c:v', 'libx264', '-y', video], { windowsHide: true, timeout: 15000 });
  const cases = [
    { kind: 'image', file: image, name: 'synthetic.png', question: '请说明附件左侧与右侧各是什么颜色和形状', check: answer => /红|red/i.test(answer) && /蓝|blue/i.test(answer) && /圆|circle/i.test(answer) },
    { kind: 'file', file: path.resolve('test/fixtures/attachment.docx'), name: 'synthetic.docx', question: '请复述文件中的英文标记', check: answer => answer.includes('ATTACHMENT_DOCX_SAMPLE') },
    { kind: 'file', file: path.resolve('test/fixtures/attachment.pdf'), name: 'synthetic.pdf', question: '请复述文件中的英文标记', check: answer => answer.includes('ATTACHMENT_PDF_SAMPLE') },
    { kind: 'video', file: video, name: 'synthetic.mp4', question: '请说出视频抽样画面依次出现的三种颜色，并说明你是否听到了声音', check: answer => /红|red/i.test(answer) && /绿|green/i.test(answer) && /蓝|blue/i.test(answer) && /无|没|不含|未|不能/.test(answer) },
  ];
  const config = { ...local, realSend: false, memory: { enabled: false }, friends: cases.map((_, i) => String(20001 + i)), groups: [], friendAdminId: '',
    conversation: { enabled: true, groupReplyProbability: 0 }, attachments: { enabled: true, localRoots: [dir, path.resolve('test/fixtures')] },
    replyStyle: '用简短准确的中文回答本轮问题，不要调用工具或输出表情。' };
  state = new State(path.join(dir, 'state.json'));
  const transport = new AntigravityProcess(config.antigravity, path.join(dir, 'reply-workspace'));
  const generator = new Antigravity(transport, state, config.antigravity.model);
  let answer = '', current;
  const original = generator.generate.bind(generator);
  generator.generate = async (...args) => {
    report.generationInput = args[4];
    try { answer = await original(...args); return answer; }
    catch (error) { report.generationFailure = { type: error.name, code: error.code, message: error.message }; throw error; }
  };
  const sender = { ready: true, async send() { report.qqSent = true; throw Error('QQ_SEND_FORBIDDEN_IN_VERIFIER'); }, async attachment() { return { file: current.file, file_name: current.name, file_size: String(fs.statSync(current.file).size) }; } };
  bridge = new Bridge(config, state, generator, sender, (category, code) => console.log(category + ' ' + code));
  await bridge.resume();
  for (let i = 0; i < cases.length; i++) {
    current = cases[i]; answer = '';
    const event = { post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: config.onebot.selfId, user_id: config.friends[i], message_id: i + 1,
      message: [{ type: 'text', data: { text: current.question } }, { type: current.kind, data: { file: 'a'.repeat(32), name: current.name } }] };
    bridge.accept(event); await bridge.settled();
    const status = state.event(filterEvent(event, config, true).eventKey)?.status;
    const passed = status === 'dry-run' && current.check(answer);
    report.cases.push({ kind: current.kind, name: current.name, status, passed, answer });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log('ATTACHMENT_CASE ' + current.name + ' ' + (passed ? 'PASS' : 'FAIL'));
    if (!passed) throw Error('ATTACHMENT_VERIFICATION_FAILED');
  }
  report.passed = true;
} catch (error) { report.error = error.code ?? error.message; process.exitCode = 1; }
finally {
  bridge?.pause('VERIFICATION_FINISHED'); await bridge?.settled(); state?.close(); unlock();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, qqSent: report.qqSent, report: path.join(dir, 'report.json'), error: report.error }));
}
