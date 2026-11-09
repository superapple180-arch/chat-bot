import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { State } from './state.js';
import { UiaDesktop } from './desktop.js';
import { Gemini } from './gemini.js';
import { BridgeError } from './types.js';
import { acquireLock } from './lock.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
fs.mkdirSync('artifacts', { recursive: true });
acquireLock();
const run = randomUUID();
const codes = { A: 'BLUE_' + randomUUID().replaceAll('-', ''), B: 'WHITE_' + randomUUID().replaceAll('-', '') };
const directory = JSON.parse(fs.readFileSync(fs.existsSync('config.local.json') ? 'config.local.json' : 'config.example.json', 'utf8')).gemini.directory;
const state = new State(`artifacts/gemini-${run}.state.json`);
const gemini = new Gemini(new UiaDesktop(directory), state, 120000);
const result: { at: string; test: string; rounds: object[]; result: string; reason?: string } = { at: new Date().toISOString(), test: 'real Gemini, synthetic QQ content, no QQ connection', rounds: [], result: 'running' };
const file = 'artifacts/gemini-verification.json';
if (fs.existsSync(file)) fs.copyFileSync(file, `artifacts/gemini-verification-before-${run}.json`);
try {
  await gemini.ready();
  for (let i = 1; i <= 10; i++) {
    const who: 'A' | 'B' = i % 2 ? 'A' : 'B';
    const token = `QQ_VERIFY_${who}_${i}_${run.slice(0, 8)}`;
    const message = i <= 2
      ? `无私人信息的测试。请记住本对话的专用代号 ${codes[who]}。本轮只回复 ${token}。`
      : `无私人信息的测试。请回忆本对话最开始记住的专用代号，只回复 代号|${token}。代号应来自本对话先前的消息。`;
    const expected = i <= 2 ? token : codes[who] + '|' + token;
    const answer = await gemini.generate(who, message, '严格按测试要求回复，保留本对话上下文');
    await gemini.verify();
    if (answer.trim() !== expected) throw new BridgeError('SYNTHETIC_ANSWER_OR_CONTEXT_MISMATCH', 'READ_FAILED');
    state.confirmReply(who);
    result.rounds.push({ round: i, target: who, matched: true, contextRecall: i > 2 });
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ round: i, target: who, matched: true }));
  }
  if (state.data.sessions.A.url === state.data.sessions.B.url) throw new BridgeError('SESSION_ISOLATION_FAILED');
  // Restart the wrapper and restore both dedicated conversations.
  state.close();
  const restored = new State(`artifacts/gemini-${run}.state.json`);
  const restarted = new Gemini(new UiaDesktop(directory), restored, 120000);
  await restarted.ready();
  const answer = await restarted.generate('A', '无私人信息的重启测试。请回忆本对话最开始记住的专用代号，只回复 代号|QQ_RESTART_OK。', '只回复测试要求的内容');
  if (answer.trim() !== codes.A + '|QQ_RESTART_OK') throw new BridgeError('RESTART_RESTORE_FAILED');
  restored.confirmReply('A'); restored.close();
  result.rounds.push({ round: 11, target: 'A', restartRestore: true }); result.result = 'passed';
} catch (e) { result.result = 'failed'; result.reason = e instanceof BridgeError ? e.code : 'VERIFY_FAILED'; process.exitCode = 1; }
fs.writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ result: result.result, reason: result.reason }));
