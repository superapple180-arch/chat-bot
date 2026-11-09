import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, sourceExclusions, readableText, localProtectedValues, privacyFindings, forbiddenPublicFile } from './release-privacy.mjs';
import { validateGuardianReport } from './release-guardian-lib.mjs';

// Raw scanner output can contain private commit metadata. Never forward it to CI logs.
const repository = path.resolve(process.argv[2] ?? '.');
const payload = path.resolve(process.argv[3] ?? repository);
if (!process.env.GITGUARDIAN_API_KEY) throw Error('GITGUARDIAN_API_KEY_REQUIRED');
if (process.env.GITGUARDIAN_EXIT_ZERO || process.env.GITGUARDIAN_NO_FAIL_ON_SERVER_ERROR) throw Error('UNSAFE_GITGUARDIAN_OVERRIDE');
const protectedValues = localProtectedValues(process.cwd());
if (inventory(repository, protectedValues, sourceExclusions).findings.length) throw Error('LOCAL_SOURCE_PRIVACY_REVIEW_REQUIRED');
if (payload !== repository) {
  const { reviewPayload } = await import('./review-payload.mjs');
  if (reviewPayload(payload, protectedValues).findings.length) throw Error('LOCAL_PAYLOAD_PRIVACY_REVIEW_REQUIRED');
}
const metadata = spawnSync('git', ['-C', repository, 'log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B'], { encoding: 'utf8' });
if (metadata.status !== 0 || privacyFindings(metadata.stdout, protectedValues).length) throw Error('LOCAL_HISTORY_PRIVACY_REVIEW_REQUIRED');
fs.mkdirSync('.cache', { recursive: true });
const temporary = fs.mkdtempSync(path.resolve('.cache/guardian-'));
try {
  const config = path.join(temporary, 'config.yaml');
  fs.writeFileSync(config, 'version: 2\nexit_zero: false\ninsecure: false\nverbose: false\ndebug: false\nsecret:\n  show_secrets: false\n  fail_on_server_error: true\n  filename_only: true\n  ignore_known_secrets: false\n  all_secrets: true\n  ignored_paths: []\n  ignored_matches: []\n  ignored_detectors: []\n', { mode: 0o600 });
  const env = { ...process.env, GGSHIELD_NO_ENDPOINT_REGISTRATION: '1' };
  for (const key of Object.keys(env)) if (/^(GITGUARDIAN_|GGSHIELD_)/.test(key) && !['GITGUARDIAN_API_KEY', 'GGSHIELD_NO_ENDPOINT_REGISTRATION'].includes(key)) delete env[key];
  const executable = process.env.CHAT_BOT_GGSHIELD ?? 'ggshield';
  function scan(args, label, expected, cwd) {
    const output = path.join(temporary, `${label}.json`);
    const result = spawnSync(executable, ['--config-path', config, 'secret', 'scan', ...args, '--all-secrets', '--json', '--filename-only', '--no-check-for-updates', '--output', output], { cwd, env, stdio: 'ignore', timeout: 1800000, windowsHide: true });
    if (result.error || result.status !== 0) throw Error('GITGUARDIAN_' + label.toUpperCase() + '_NOT_PASSED');
    let report; try { report = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { throw Error('GITGUARDIAN_INVALID_REPORT'); }
    validateGuardianReport(report, expected);
  }
  const shallow = spawnSync('git', ['-C', repository, 'rev-parse', '--is-shallow-repository'], { encoding: 'utf8' });
  if (shallow.status !== 0 || shallow.stdout.trim() !== 'false') throw Error('COMPLETE_PUBLIC_GIT_HISTORY_REQUIRED');
  const tracked = spawnSync('git', ['-C', repository, 'ls-files', '-z'], { encoding: 'utf8' });
  if (tracked.status !== 0 || tracked.stdout.split('\0').some(file => forbiddenPublicFile(file) || sourceExclusions.some(prefix => file === prefix || file.startsWith(prefix + '/')))) throw Error('PRIVATE_OR_GENERATED_FILES_TRACKED');
  const inputs = path.join(temporary, 'texts'); fs.mkdirSync(inputs);
  const manifest = inventory(payload, [], payload === repository ? sourceExclusions : []);
  let chunks = 0;
  function addText(content) {
    // Stay below API document limits, overlap boundaries so a split cannot hide a key.
    const points = [...content];
    for (let offset = 0; offset < points.length; offset += 180000) fs.writeFileSync(path.join(inputs, `${chunks++}.txt`), points.slice(offset, offset + 181024).join(''));
  }
  for (const entry of manifest.files.filter(f => f.kind === 'text')) {
    const data = fs.readFileSync(path.join(payload, entry.file));
    const text = readableText(data); if (text === null) throw Error('SCAN_INPUT_CHANGED_OR_UNREADABLE'); addText(text);
  }
  // Explicitly scan every reachable historical text blob too, including files
  // the repository scanner might otherwise skip because of its size limits.
  const objects = spawnSync('git', ['-C', repository, 'rev-list', '--objects', '--all'], { encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
  if (objects.status !== 0) throw Error('HISTORY_ENUMERATION_FAILED');
  const ids = [...new Set(objects.stdout.split('\n').filter(Boolean).map(line => line.split(' ')[0]))];
  const objectPaths = new Map(objects.stdout.split('\n').filter(Boolean).map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)]));
  const types = spawnSync('git', ['-C', repository, 'cat-file', '--batch-check=%(objectname) %(objecttype) %(objectsize)'], { input: ids.join('\n') + '\n', encoding: 'utf8', maxBuffer: 32 * 1024 ** 2 });
  if (types.status !== 0) throw Error('HISTORY_ENUMERATION_FAILED');
  for (const line of types.stdout.trim().split('\n')) {
    const [id, type, size] = line.split(' '); if (type !== 'blob') continue;
    if (Number(size) > 64 * 1024 ** 2) throw Error('HISTORICAL_OBJECT_REQUIRES_REVIEW');
    const blob = spawnSync('git', ['-C', repository, 'cat-file', 'blob', id], { maxBuffer: 64 * 1024 ** 2 });
    if (blob.status !== 0) throw Error('HISTORY_READ_FAILED');
    const text = readableText(blob.stdout);
    if (text !== null) {
      const name = objectPaths.get(id) ?? '';
      if (privacyFindings(text, protectedValues, /(?:LICENSE|LICENCE|THIRD_PARTY)/i.test(name)).length) throw Error('LOCAL_HISTORICAL_CONTENT_REQUIRES_REVIEW');
      addText(text);
    }
  }
  if (!chunks) throw Error('NO_SCAN_INPUT');
  scan(['repo', '.'], 'history', undefined, repository);
  // A path rooted at the working copy inherits its .cache ignore rule.
  scan(['path', '-r', '-y', '.'], 'payload', Array.from({ length: chunks }, (_, i) => `${i}.txt`), inputs);
  console.log(JSON.stringify({ gitguardian: 'passed', payloadDigest: manifest.digest, textFiles: manifest.files.filter(f => f.kind === 'text').length, chunks, binariesRequireReview: manifest.files.filter(f => f.kind !== 'text').length }));
} finally {
  const resolved = path.resolve(temporary), parent = path.resolve('.cache');
  if (path.dirname(resolved) !== parent) throw Error('INVALID_SCANNER_TEMP_ROOT');
  fs.rmSync(resolved, { recursive: true, force: true });
}
