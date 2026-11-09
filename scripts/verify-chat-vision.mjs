import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { State } from '../dist/state.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { Conversation } from '../dist/conversation.js';
import { parseAttachment } from '../dist/attachments.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
// This verifier has no OneBot connection or sender. Keep the same lock as production.
const unlock = acquireLock();
const dir = fs.mkdtempSync(path.resolve('artifacts/chat-vision-'));
const report = { at: new Date().toISOString(), passed: false, qqSent: false, cases: [] };
let state;
try {
  const config = readConfig('config.local.json');
  if (config.provider !== 'antigravity') throw Error('ANTIGRAVITY_REQUIRED');
  const short = path.join(dir, 'motion.mp4'), gif = path.join(dir, 'motion.gif'), long = path.join(dir, 'clip.mp4');
  for (const [file, first, last, rate] of [[short, 1, 1, 10], [long, 62, 3, 1]]) {
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', `color=c=red:s=160x120:r=${rate}:d=${first}`, '-f', 'lavfi', '-i', `color=c=blue:s=160x120:r=${rate}:d=${last}`, '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0', '-c:v', 'libx264', '-y', file], { windowsHide: true, timeout: 15000 });
  }
  execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-i', short, '-y', gif], { windowsHide: true, timeout: 15000 });
  state = new State(path.join(dir, 'state.json'));
  const conversation = new Conversation(state);
  const generator = new Antigravity(new AntigravityProcess(config.antigravity, path.join(dir, 'reply-workspace')), state, config.antigravity.model);
  const cases = [
    { id: 'meme-ocr-tone', kind: 'image', file: path.resolve('assets/media/okay.png'), text: '这张表情包的配字是什么 大概是什么语气', check: a => /改方案/.test(a) && /假笑|无奈|反话|敷衍|勉强/.test(a) },
    { id: 'gif-ending', kind: 'image', file: gif, text: '这张动图开头和结尾分别是什么颜色', check: a => /红/.test(a) && /蓝/.test(a) },
    { id: 'short-video', kind: 'video', file: short, text: '这段视频开头和结尾分别是什么颜色', check: a => /红/.test(a) && /蓝/.test(a) },
    { id: 'long-video-ending-silent', kind: 'video', file: long, text: '视频开头和结尾分别什么颜色 你听到什么声音了吗', check: a => /红/.test(a) && /蓝/.test(a) && /没有|未提供|没听|无法|不能|无声|不含/.test(a) },
    { id: 'casual-chat', text: '今天方案被来回改了五遍 人都麻了', check: a => a.length <= 200 && !/首先|其次|综上|还有什么可以|作为.{0,10}AI/.test(a) },
    { id: 'uncaptioned-meme', kind: 'image', file: path.resolve('assets/media/okay.png'), text: '[收到附件，未附文字]', check: a => a.length <= 200 && !/画面事实|表情包语气|图片中有|这张图展示/.test(a) },
  ];
  for (const item of cases) {
    const start = Date.now();
    const material = item.file ? await parseAttachment(item.file, item.kind, path.basename(item.file), undefined, config.antigravity, item.text) : '';
    const target = { kind: 'private', id: '20001', key: item.id, eventKey: item.id, text: item.text };
    const answer = await generator.generate(item.id, item.text, conversation.style(target, config, config.replyStyle), undefined, material);
    state.discardReply(item.id);
    const passed = item.check(answer);
    report.cases.push({ id: item.id, passed, elapsedMs: Date.now() - start, material, answer });
    fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
    console.log(item.id + ' ' + (passed ? 'PASS' : 'FAIL'));
  }
  report.passed = report.cases.every(item => item.passed);
  if (!report.passed) process.exitCode = 1;
} catch (error) {
  report.error = error.code ?? error.message; process.exitCode = 1;
} finally {
  state?.close(); unlock();
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.passed, qqSent: false, report: path.join(dir, 'report.json'), error: report.error }));
}
