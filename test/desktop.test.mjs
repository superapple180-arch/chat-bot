import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dailySchedule } from '../dist/daily-schedule.js';
import { AntigravityProcess } from '../dist/antigravity.js';
import { State } from '../dist/state.js';
import { Bridge } from '../dist/bridge.js';
import { BridgeError } from '../dist/types.js';
import { privacyFindings, readableText, inventory } from '../scripts/release-privacy.mjs';
import { validateGuardianReport } from '../scripts/release-guardian-lib.mjs';
import { isReleaseFile } from '../scripts/release-files.mjs';
import { publicConfig, saveWebConfig } from '../dist/web-config.js';
import { assertPackagedDependencies } from '../scripts/assert-packaged-dependencies.mjs';

function folder(t, cleanup = () => {}) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/desktop space-'));
  t.after(() => { cleanup(); fs.rmSync(root, { recursive: true, force: true }); }); return root;
}
test('daily schedule follows Beijing time, persists one attempt, never catches up or retries a skipped minute', t => {
  const file = path.join(folder(t), 'schedule.json'); let calls = 0;
  const tick = (time, ready = true) => dailySchedule(file, new Date(time), true, ready, () => calls++);
  tick('2026-11-04T09:59:59Z'); assert.equal(calls, 0);
  tick('2026-11-04T10:00:01Z'); tick('2026-11-04T10:00:30Z'); assert.equal(calls, 1);
  tick('2026-11-05T10:00:01Z', false); tick('2026-11-05T10:00:20Z'); assert.equal(calls, 1);
  tick('2026-11-06T10:01:00Z'); assert.equal(calls, 1);
  tick('2026-11-07T10:00:00Z'); assert.equal(calls, 2);
});
test('generated hook command really executes with whitespace paths and attests the exact workspace', t => {
  const workspace = folder(t), nonce = randomUUID(), id = randomUUID();
  new AntigravityProcess({ executable: process.execPath, timeoutMs: 1000, model: '' }, workspace).check();
  fs.writeFileSync(path.join(workspace, '.hook-request.json'), JSON.stringify({ nonce }));
  const hooks = JSON.parse(fs.readFileSync(path.join(workspace, '.agents/hooks.json')));
  const command = hooks['qq-text-only'].PreInvocation[0].command;
  const result = spawnSync(command, { shell: true, cwd: workspace, input: JSON.stringify({ workspacePaths: [workspace], conversationId: id }), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace, `.hook-proof-${nonce}.json`))), { nonce, conversationId: id });
});
for (const uncertain of [false, true]) test(`graceful exit drains an in-flight send without replay and restores only confirmed state (uncertain=${uncertain})`, async t => {
  let state; const root = folder(t, () => state.close()); state = new State(path.join(root, 'state.json'));
  const config = JSON.parse(fs.readFileSync('config.antigravity.example.json'));
  Object.assign(config, { friends: ['900000002'], realSend: true }); config.onebot.selfId = '900000001';
  let release, entered; const started = new Promise(resolve => entered = resolve), waiting = new Promise(resolve => release = resolve);
  const sent = [], generator = { async ready() {}, async verify() {}, async generate() { entered(); await waiting; return '合成回答'; } };
  const sender = { ready: true, async send(target) { sent.push(target.eventKey); if (uncertain) throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true); return 'synthetic-receipt'; } };
  const bridge = new Bridge(config, state, generator, sender, () => {}); await bridge.resume();
  const event = id => ({ post_type: 'message', message_type: 'private', sub_type: 'friend', self_id: 900000001, user_id: 900000002, message_id: id, message: [{ type: 'text', data: { text: '合成输入' } }] });
  bridge.accept(event(1)); await started;
  let finished = false; const stopping = bridge.finishAndPause().then(result => { finished = true; return result; });
  bridge.accept(event(2)); assert.equal(finished, false); release();
  const result = await stopping; assert.equal(result.restore, !uncertain); assert.equal(bridge.paused, true); assert.equal(sent.length, 1);
});
test('privacy review detects personal identities and credentials without returning matching values', () => {
  const email = ['private.person', 'mail.invalid-domain.com'].join('@');
  const secret = 'sk-' + 'a'.repeat(40);
  const findings = privacyFindings(email + ' ' + secret + ' private-identity', ['private-identity']);
  assert.deepEqual(new Set(findings), new Set(['email-review', 'credential-pattern', 'protected-identity-or-secret']));
  assert.ok(!JSON.stringify(findings).includes(email)); assert.ok(!JSON.stringify(findings).includes(secret));
  assert.deepEqual(privacyFindings('person@example.invalid'), []);
});
test('GitGuardian must report every expected chunk exactly once and no nested errors or incidents', () => {
  const report = { type: 'path_scan', total_incidents: 0, entities_with_incidents: [{ filename: '0.txt', incidents: [], total_incidents: 0 }] };
  validateGuardianReport(report, ['0.txt']);
  assert.throws(() => validateGuardianReport(report, ['0.txt', '1.txt']), /INCOMPLETE_COVERAGE/);
  assert.throws(() => validateGuardianReport({ ...report, entities_with_incidents: [...report.entities_with_incidents, ...report.entities_with_incidents] }, ['0.txt']), /INCOMPLETE_COVERAGE/);
  assert.throws(() => validateGuardianReport({ ...report, scans: [{ errors: [{ message: 'synthetic failure' }] }] }, ['0.txt']), /FINDING_OR_ERROR/);
  assert.throws(() => validateGuardianReport({}, ['0.txt']), /INVALID_REPORT/);
});
test('release scanner without a GitGuardian credential fails before executing or uploading anything', t => {
  const root = folder(t), env = { ...process.env }; delete env.GITGUARDIAN_API_KEY;
  const result = spawnSync(process.execPath, [path.resolve('scripts/release-guardian.mjs'), root], { env, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /GITGUARDIAN_API_KEY_REQUIRED/);
});
test('only installers and platform update metadata may be uploaded, never builder debug logs', () => {
  for (const name of ['chat-bot-0.2.0-win-x64.exe', 'chat-bot-0.2.0-mac-arm64.zip.blockmap', 'latest-win32-x64.yml', 'latest-darwin-arm64-mac.yml', 'latest-linux-x64-linux.yml']) assert.equal(isReleaseFile(name), true);
  for (const name of ['builder-debug.yml', 'builder-effective-config.yaml', 'config.local.json', 'chat-bot-0.2.0-x64.nsis.7z', '../chat-bot-0.2.0-win-x64.exe']) assert.equal(isReleaseFile(name), false);
});
test('both UTF-16 byte orders remain scannable and sensitive filenames are redacted', t => {
  const value = ['private.person', 'mail.invalid-domain.com'].join('@');
  const little = Buffer.from('\ufeff' + value, 'utf16le'), big = Buffer.from(little); big.swap16();
  assert.ok(readableText(little).includes(value)); assert.ok(readableText(big).includes(value));
  const root = folder(t), identity = ['synthetic', 'identity'].join('-');
  fs.writeFileSync(path.join(root, identity + '.txt'), 'safe');
  const report = inventory(root, [identity]); assert.equal(report.findings[0].categories[0], 'sensitive-filename');
  assert.ok(!JSON.stringify(report.findings).includes(identity));
});
for (const binary of [false, true]) test(`a protected identity cannot be waived as an upstream false positive (binary=${binary})`, t => {
  const root = folder(t), identity = ['synthetic', 'protected'].join('-');
  const file = path.join(root, 'node_modules/synthetic', binary ? 'sample.bin' : 'sample.txt'); fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([binary ? Buffer.from([0]) : Buffer.alloc(0), Buffer.from(identity)]));
  let called = false;
  const report = inventory(root, [identity], [], () => { called = true; return 'upstream'; });
  assert.equal(called, false); assert.equal(report.vendorReviewed.length, 0);
  assert.ok(report.findings[0].categories.includes('protected-identity-or-secret'));
});
test('desktop config cannot switch into the legacy Windows-only provider through the API', t => {
  const root = folder(t), config = JSON.parse(fs.readFileSync('config.antigravity.example.json'));
  config.onebot.selfId = '900000001'; config.onebot.accessToken = 'synthetic-desktop-config-token';
  fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + config.onebot.accessToken + '\n');
  const file = path.join(root, 'config.local.json'); fs.writeFileSync(file, JSON.stringify(config)); const before = fs.readFileSync(file, 'utf8');
  const input = publicConfig(root); input.config.provider = 'gemini';
  const old = process.env.QQ_BOT_DESKTOP; process.env.QQ_BOT_DESKTOP = '1';
  try { assert.throws(() => saveWebConfig(root, input), { code: 'DESKTOP_PROVIDER_NOT_SUPPORTED' }); assert.equal(fs.readFileSync(file, 'utf8'), before); }
  finally { if (old === undefined) delete process.env.QQ_BOT_DESKTOP; else process.env.QQ_BOT_DESKTOP = old; }
});
test('a configured GitGuardian credential still cannot send unreviewed private source to the service', t => {
  const root = folder(t); fs.writeFileSync(path.join(root, 'sample.txt'), 'sk-' + 'a'.repeat(40));
  const result = spawnSync(process.execPath, [path.resolve('scripts/release-guardian.mjs'), root], { env: { ...process.env, GITGUARDIAN_API_KEY: 'synthetic-not-a-real-token' }, encoding: 'utf8', windowsHide: true });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /LOCAL_SOURCE_PRIVACY_REVIEW_REQUIRED/);
});

test('packaging rejects dependencies borrowed from a development ancestor and accepts only bundled entries', t => {
  const root = folder(t);
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { fastify: '*' } }));
  assert.throws(() => assertPackagedDependencies(root), /PACKAGED_DEPENDENCY_OUTSIDE_APPLICATION/);
  const bundled = folder(t);
  fs.writeFileSync(path.join(bundled, 'package.json'), JSON.stringify({ dependencies: { fastify: '*' } }));
  const dependency = path.join(bundled, 'node_modules/fastify'); fs.mkdirSync(dependency, { recursive: true });
  fs.writeFileSync(path.join(dependency, 'package.json'), JSON.stringify({ main: 'index.cjs' }));
  fs.writeFileSync(path.join(dependency, 'index.cjs'), 'module.exports = {};');
  assert.equal(assertPackagedDependencies(bundled), 1);
});
