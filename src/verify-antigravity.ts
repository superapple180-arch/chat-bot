import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Antigravity, AntigravityProcess } from './antigravity.js';
import { State } from './state.js';
import { BridgeError } from './types.js';
import { acquireLock } from './lock.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
fs.mkdirSync('artifacts', { recursive: true });
acquireLock();
const c = JSON.parse(fs.readFileSync(fs.existsSync('config.local.json') ? 'config.local.json' : 'config.antigravity.example.json', 'utf8'));
if (!c.antigravity) throw new Error('ANTIGRAVITY_CONFIG_REQUIRED');
const run = randomUUID();
const file = `artifacts/antigravity-${run}.json`;
const stateFile = `artifacts/antigravity-${run}.state.json`;
const result: { at: string; provider: string; realQQ: boolean; rounds: object[]; result: string; reason?: string } = { at: new Date().toISOString(), provider: 'antigravity-cli', realQQ: false, rounds: [], result: 'running' };
const state = new State(stateFile);
const agent = new Antigravity(new AntigravityProcess(c.antigravity), state, c.antigravity.model);
const codes = { A: 'BLUE_' + randomUUID().replaceAll('-', ''), B: 'WHITE_' + randomUUID().replaceAll('-', '') };
try {
  await agent.ready();
  for (let i = 1; i <= 10; i++) {
    const target: 'A' | 'B' = i % 2 ? 'A' : 'B';
    const token = `QQ_TEST_${i}_${run.slice(0, 8)}`;
    const message = i <= 2 ? `请记住代号 ${codes[target]}，本轮只回复 ${token}` : `请回忆最初记住的代号，只回复 代号|${token}。`;
    const expected = i <= 2 ? token : codes[target] + '|' + token;
    const response = await agent.generate(target, message, '这是合成数据的连通性测试，请严格按要求回复');
    if (response.trim() !== expected) throw new BridgeError('ANTIGRAVITY_CONTEXT_TEST_FAILED', 'READ_FAILED');
    state.confirmReply(target);
    result.rounds.push({ round: i, target, matched: true });
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ round: i, target, matched: true }));
  }
  state.close();
  const restored = new State(stateFile);
  const restarted = new Antigravity(new AntigravityProcess(c.antigravity), restored, c.antigravity.model);
  if ((await restarted.generate('A', '请只回复最初记住的代号', '严格按要求回复')).trim() !== codes.A) throw new BridgeError('ANTIGRAVITY_RESTORE_TEST_FAILED');
  restored.confirmReply('A'); restored.close();
  result.rounds.push({ round: 11, restartRestore: true }); result.result = 'passed';
} catch (e) { result.result = 'failed'; result.reason = e instanceof BridgeError ? e.code : 'VERIFY_FAILED'; process.exitCode = 1; }
fs.writeFileSync(file, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ result: result.result, reason: result.reason, report: file }));
