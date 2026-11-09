import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import { createHash } from 'node:crypto';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { readOneBotToken, saveOneBotToken, migrateLegacyConfig, withoutToken } from '../dist/secrets.js';
import { publicConfig, saveWebConfig } from '../dist/web-config.js';
import { forbiddenPublicFile, privacyFindings } from '../scripts/release-privacy.mjs';
import { checkSourcePublication } from '../scripts/source-publication-gate.mjs';

const token = 'synthetic-env-token-0123456789';
function fixture(t, legacy = false) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/secrets-'));
  const original = process.env.ONEBOT_ACCESS_TOKEN; delete process.env.ONEBOT_ACCESS_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.ONEBOT_ACCESS_TOKEN; else process.env.ONEBOT_ACCESS_TOKEN = original; fs.rmSync(root, { recursive: true, force: true }); });
  const config = JSON.parse(fs.readFileSync('config.example.json')); config.onebot.selfId = '900000001'; config.onebot.accessToken = legacy ? token : '';
  const file = path.join(root, 'config.local.json'); fs.writeFileSync(file, JSON.stringify(config));
  return { root, file, config, env: path.join(root, '.env') };
}
test('JSON credentials are ignored; config-directory env works from another cwd and process environment wins', t => {
  const f = fixture(t, true);
  assert.throws(() => readConfig(f.file), { code: 'ACCESS_TOKEN_REQUIRED_MIN_16' });
  fs.writeFileSync(f.env, `ONEBOT_ACCESS_TOKEN=${token}\n`);
  assert.equal(readConfig(f.file).onebot.accessToken, token);
  process.env.ONEBOT_ACCESS_TOKEN = 'synthetic-process-token-0123456';
  assert.equal(readConfig(f.file).onebot.accessToken, process.env.ONEBOT_ACCESS_TOKEN);
  process.env.ONEBOT_ACCESS_TOKEN = '';
  assert.throws(() => readConfig(f.file), { code: 'ACCESS_TOKEN_REQUIRED_MIN_16' });
});
test('missing, placeholder, multiline and NUL credentials fail closed without printing values', t => {
  const f = fixture(t);
  for (const value of ['', 'short', 'REPLACE_WITH_REAL_TOKEN', 'synthetic-line\nunsafe', 'synthetic-token\0unsafe']) {
    process.env.ONEBOT_ACCESS_TOKEN = value;
    assert.throws(() => readConfig(f.file), error => error.code === 'ACCESS_TOKEN_REQUIRED_MIN_16' && !error.message.includes('unsafe'));
  }
});
test('local env serialization preserves other values and tokens containing dotenv metacharacters', t => {
  const f = fixture(t); fs.writeFileSync(f.env, 'OTHER_VALUE="keep # and spaces"\n');
  const special = 'synthetic-token # with spaces and "quote"';
  saveOneBotToken(f.root, special); assert.equal(readOneBotToken(f.root), special);
  assert.equal(parseEnv(fs.readFileSync(f.env, 'utf8')).OTHER_VALUE, 'keep # and spaces');
});
test('migration verifies the same token before removing JSON credentials and redacts the known config backup', t => {
  const f = fixture(t, true); fs.mkdirSync(path.join(f.root, 'state'));
  const backup = path.join(f.root, 'state/config.local.backup.json'); fs.copyFileSync(f.file, backup);
  assert.equal(migrateLegacyConfig(f.file), true);
  assert.equal(readConfig(f.file).onebot.accessToken, token);
  for (const file of [f.file, backup]) assert.ok(!fs.readFileSync(file, 'utf8').includes(token));
  assert.equal(migrateLegacyConfig(f.file), false);
});
test('a conflicting environment or unwritable env destination preserves the legacy configuration', t => {
  const f = fixture(t, true), before = fs.readFileSync(f.file, 'utf8');
  process.env.ONEBOT_ACCESS_TOKEN = 'synthetic-conflicting-token-0000';
  assert.throws(() => migrateLegacyConfig(f.file), { code: 'LEGACY_TOKEN_ENVIRONMENT_MISMATCH' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before);
  delete process.env.ONEBOT_ACCESS_TOKEN; fs.mkdirSync(f.env);
  assert.throws(() => migrateLegacyConfig(f.file)); assert.equal(fs.readFileSync(f.file, 'utf8'), before);
});
test('migration refuses to change credentials while the bridge owns its account lock', t => {
  const f = fixture(t, true), before = fs.readFileSync(f.file, 'utf8');
  const unlock = acquireLock(path.join(f.root, 'state/bridge.lock'));
  try { assert.throws(() => migrateLegacyConfig(f.file), { code: 'BRIDGE_ALREADY_RUNNING' }); }
  finally { unlock(); }
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(fs.existsSync(f.env), false);
});
test('web saves move tokens only to env, redact config and backup, and do not echo credentials', t => {
  const f = fixture(t, true); saveOneBotToken(f.root, token);
  const input = publicConfig(f.root), replacement = 'synthetic-replacement-token-0000';
  input.config.onebot.accessToken = replacement; input.config.replyStyle = 'updated';
  const result = saveWebConfig(f.root, input);
  assert.equal(result.restartRequired, true); assert.equal(result.config.onebot.accessToken, '');
  assert.equal(readConfig(f.file).onebot.accessToken, replacement);
  for (const file of [f.file, path.join(f.root, 'state/config.local.backup.json')]) {
    const text = fs.readFileSync(file, 'utf8'); assert.ok(!text.includes(token)); assert.ok(!text.includes(replacement));
  }
  assert.ok(!JSON.stringify(result).includes(replacement));
});
test('invalid web updates and process-managed token changes leave config and env untouched', t => {
  const f = fixture(t); saveOneBotToken(f.root, token);
  const before = fs.readFileSync(f.file, 'utf8'), envBefore = fs.readFileSync(f.env, 'utf8');
  const input = publicConfig(f.root); input.config.onebot.accessToken = 'synthetic-replacement-token-0000'; input.config.maxQueue = -1;
  assert.throws(() => saveWebConfig(f.root, input), { code: 'INVALID_LIMIT' });
  input.config.maxQueue = 50; process.env.ONEBOT_ACCESS_TOKEN = token;
  assert.throws(() => saveWebConfig(f.root, input), { code: 'TOKEN_MANAGED_BY_ENVIRONMENT' });
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(fs.readFileSync(f.env, 'utf8'), envBefore);
});
test('a failed web config replacement rolls back an env credential change', t => {
  const f = fixture(t); saveOneBotToken(f.root, token);
  fs.mkdirSync(path.join(f.root, 'state/config.local.backup.json'), { recursive: true });
  const before = fs.readFileSync(f.file, 'utf8'), envBefore = fs.readFileSync(f.env, 'utf8'), input = publicConfig(f.root);
  input.config.onebot.accessToken = 'synthetic-replacement-token-0000';
  assert.throws(() => saveWebConfig(f.root, input));
  assert.equal(fs.readFileSync(f.file, 'utf8'), before); assert.equal(fs.readFileSync(f.env, 'utf8'), envBefore);
});
test('publication rejects env and key files in any directory while allowing the empty example', () => {
  for (const file of ['.env', '.env.local', 'nested/.env.production', 'nested/private.key', 'nested/key.pem', 'certificate.pfx', 'id_ed25519', 'config.local.backup.json']) assert.equal(forbiddenPublicFile(file), true);
  for (const file of ['.env.example', 'nested/.env.example', 'config.example.json']) assert.equal(forbiddenPublicFile(file), false);
  const findings = privacyFindings(['postgresql://', 'user', ':', 'credential', '@db.invalid/database'].join(''));
  assert.ok(findings.includes('database-credential-url')); assert.ok(!JSON.stringify(findings).includes('credential@'));
});
test('source gate blocks missing authorization, stale reviews and unresolved license findings', t => {
  const f = fixture(t); fs.writeFileSync(f.file, JSON.stringify(withoutToken(f.config))); fs.renameSync(f.file, path.join(f.root, 'config.example.json'));
  fs.mkdirSync(path.join(f.root, 'docs'));
  for (const kind of ['media', 'voice']) { fs.mkdirSync(path.join(f.root, 'assets', kind), { recursive: true }); fs.writeFileSync(path.join(f.root, 'assets', kind, 'index.json'), '[]\n'); }
  const input = { file: 'config.example.json', sha256: createHash('sha256').update(fs.readFileSync(path.join(f.root, 'config.example.json'))).digest('hex') };
  const report = { schema: 1, target: 'source-only', inputs: [input], dependencies: [{ status: 'distribution-inspected', compatibility: 'permissive-with-notices' }], resources: [], blockers: [{ code: 'SYNTHETIC_UNRESOLVED_LICENSE' }], uploadAllowed: false };
  const audit = path.join(f.root, 'docs/PUBLIC_SOURCE_AUDIT.json'), save = () => fs.writeFileSync(audit, JSON.stringify(report)); save();
  assert.throws(() => checkSourcePublication(f.root), /SOURCE_LICENSE_REVIEW_NOT_PASSED/);
  report.blockers = []; report.uploadAllowed = true; save(); assert.equal(checkSourcePublication(f.root).sourcePublicationGate, 'passed');
  report.binaryBlockers = [{ code: 'GPL_COMBINED_DISTRIBUTION_REVIEW_REQUIRED' }];
  report.dependencies[0].compatibility = 'gpl-compatible-source-only'; save();
  assert.equal(checkSourcePublication(f.root).sourcePublicationGate, 'passed');
  assert.throws(() => checkSourcePublication(f.root, { binary: true }), /BINARY_LICENSE_REVIEW_NOT_PASSED/);
  fs.writeFileSync(path.join(f.root, 'unknown.png'), 'synthetic-unlicensed-resource');
  assert.throws(() => checkSourcePublication(f.root), /STATIC_RESOURCE_AUTHORIZATION_REQUIRED/);
  fs.rmSync(path.join(f.root, 'unknown.png')); fs.appendFileSync(path.join(f.root, 'config.example.json'), '\n');
  assert.throws(() => checkSourcePublication(f.root), /SOURCE_LICENSE_AUDIT_STALE/);
});
