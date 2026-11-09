import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { acquireLock } from '../dist/lock.js';
acquireLock();
const directory = JSON.parse(fs.readFileSync('config.local.json', 'utf8')).gemini.directory;
function call(input) {
  const p = spawnSync('bin/GeminiDriver.exe', [], { input: JSON.stringify({ directory, ...input }), encoding: 'utf8', windowsHide: true, timeout: 160000 });
  let result; try { result = JSON.parse(p.stdout.trim()); } catch { throw new Error('DRIVER_NO_RESULT'); }
  if (result.error) throw Object.assign(new Error(result.error), result);
  return result;
}
const rounds = Number(process.argv[2] ?? 10);
const file = 'artifacts/driver-smoke.json';
if (fs.existsSync(file)) fs.copyFileSync(file, `artifacts/driver-smoke-before-${randomUUID()}.json`);
const evidence = { at: new Date().toISOString(), realGemini: true, realQQ: false, rounds: [], sessions: {}, result: 'running' };
function save() { fs.writeFileSync(file, JSON.stringify(evidence, null, 2)); }
try {
  let v = call({ action: 'observe' });
  if (v.hasDraft || v.busy || v.minimized) throw new Error('USER_PREPARATION_REQUIRED');
  const sessions = {};
  for (let i = 0; i < rounds; i++) {
    const who = i % 2 ? 'B' : 'A';
    if (!sessions[who]) v = call({ action: 'new', mode: v.mode, fingerprint: v.fingerprint });
    const marker = 'QQBRIDGE_' + randomUUID().replaceAll('-', '');
    const token = `QQ_SYNTHETIC_${who}_${i + 1}`;
    const text = `这是一次软件联调测试。请原样回复这一行文本：${token}\n末尾是程序关联编号，无需回复：${marker}`;
    v = call({ action: 'send', url: sessions[who] ?? v.url, mode: v.mode, fingerprint: v.fingerprint, marker, text, timeoutMs: 120000 });
    if (v.marker !== marker || !v.submitted || !v.text.trim() || v.busy || v.hasDraft) { evidence.mismatch = { expected: token, actual: v.text }; throw new Error('ROUND_OWNERSHIP_MISMATCH'); }
    sessions[who] = v.url;
    evidence.sessions[who] = createHash('sha256').update(v.url).digest('hex');
    evidence.rounds.push({ round: i + 1, target: who, mode: v.mode, submitted: v.submitted, expected: token, actual: v.text, exactEcho: v.text.trim() === token, ownershipConfirmed: true, passed: true });
    save(); console.log(JSON.stringify({ round: i + 1, target: who, passed: true }));
  }
  evidence.result = 'passed'; save();
} catch (e) { evidence.result = 'failed'; evidence.error = e.message; evidence.category = e.category; evidence.submitted = e.submitted; evidence.diagnosticType = e.diagnosticType; evidence.diagnosticStack = e.diagnosticStack; save(); console.log(JSON.stringify({ result: 'failed', code: e.message, category: e.category, submitted: e.submitted, diagnosticType: e.diagnosticType, diagnosticStack: e.diagnosticStack })); process.exitCode = 1; }
