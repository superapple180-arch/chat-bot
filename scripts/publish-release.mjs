import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { inventory, sourceExclusions, localProtectedValues } from './release-privacy.mjs';
import { isReleaseFile } from './release-files.mjs';
import { checkSourcePublication } from './source-publication-gate.mjs';

checkSourcePublication(process.cwd(), { binary: true });

const directory = path.resolve(process.argv[2] ?? '.cache/candidates');
const reports = fs.readdirSync(directory, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => ({ directory: path.join(directory, item.name), report: JSON.parse(fs.readFileSync(path.join(directory, item.name, 'build-platform.json'), 'utf8')) }));
const expected = new Set(['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64']);
const source = inventory(process.cwd(), localProtectedValues(process.cwd()), sourceExclusions);
if (source.findings.length) throw Error('SOURCE_PRIVACY_REVIEW_NOT_PASSED');
const files = [], names = new Set();
for (const { directory: folder, report } of reports) {
  const key = `${report.platform}-${report.arch}`;
  if (!expected.delete(key) || report.formal !== true || report.privacyAndGuardianPassed !== true || report.sourceCommit !== process.env.CHAT_BOT_RELEASE_COMMIT || String(report.runId) !== process.env.CHAT_BOT_RELEASE_RUN_ID || report.sourceDigest !== source.digest) throw Error('UNVERIFIED_RELEASE_CANDIDATE');
  for (const entry of report.files) {
    if (!isReleaseFile(entry.file) || path.basename(entry.file) !== entry.file || names.has(entry.file)) throw Error('INVALID_OR_DUPLICATE_RELEASE_FILE');
    const file = path.join(folder, entry.file);
    if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== entry.sha256) throw Error('CANDIDATE_HASH_MISMATCH');
    files.push({ file: entry.file, sha256: entry.sha256, absolute: file }); names.add(entry.file);
  }
}
if (expected.size || files.length < 8) throw Error('RELEASE_PLATFORMS_INCOMPLETE');
files.sort((a, b) => a.file.localeCompare(b.file));
const hashes = files.map(({ file, sha256 }) => ({ file, sha256 }));
fs.mkdirSync('.cache', { recursive: true });
const checks = ['realNames', 'privateEmails', 'computerUsernames', 'syntheticTestData', 'screenshotsAndMetadata', 'gitIdentities', 'thirdPartyAttribution', 'binaryProvenance', 'platformLiveAcceptance', 'correspondingSources'];
fs.writeFileSync('.cache/final-review-required.json', JSON.stringify({ sourceDigest: source.digest, artifacts: hashes, checks: Object.fromEntries(checks.map(key => [key, false])) }, null, 2));
let review; try { review = JSON.parse(process.env.CHAT_BOT_RELEASE_REVIEW ?? ''); } catch { throw Error('MANUAL_RELEASE_REVIEW_REQUIRED'); }
if (review.sourceDigest !== source.digest || checks.some(key => review.checks?.[key] !== true) || JSON.stringify(review.artifacts) !== JSON.stringify(hashes)) throw Error('FINAL_REVIEW_MISSING_OR_STALE');
if (!process.env.GH_TOKEN || !process.env.GITGUARDIAN_API_KEY) throw Error('RELEASE_CREDENTIALS_REQUIRED');
const scan = spawnSync(process.execPath, ['scripts/release-guardian.mjs', '.', '.'], { stdio: 'inherit', windowsHide: true });
if (scan.status !== 0) throw Error('GITGUARDIAN_RELEASE_GATE_NOT_PASSED');
const version = JSON.parse(fs.readFileSync('package.json')).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('STABLE_VERSION_REQUIRED');
const repository = 'superapple180-arch/chat-bot', tag = 'v' + version;
async function api(endpoint, method, body) {
  const response = await fetch('https://api.github.com/repos/' + repository + endpoint, { method, headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw Error('GITHUB_RELEASE_REQUEST_FAILED'); return response.status === 204 ? undefined : response.json();
}
// Create only after all checks. A failed upload leaves a draft, never a partial update feed.
const release = await api('/releases', 'POST', { tag_name: tag, target_commitish: process.env.CHAT_BOT_RELEASE_COMMIT, name: 'chat-bot ' + version, draft: true, prerelease: false, body: 'Windows x64、macOS Intel/Apple Silicon、Ubuntu x64 安装包\n\n已完成本版本隐私复核、GitGuardian 扫描与平台验收 首版免费非商业使用' });
for (const entry of files) {
  const response = await fetch(release.upload_url.replace('{?name,label}', '') + '?name=' + encodeURIComponent(entry.file), { method: 'POST', headers: { Authorization: 'Bearer ' + process.env.GH_TOKEN, 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(entry.absolute) });
  if (!response.ok) throw Error('GITHUB_RELEASE_UPLOAD_FAILED_DRAFT_RETAINED');
}
await api('/releases/' + release.id, 'PATCH', { draft: false });
console.log(JSON.stringify({ published: true, tag, files: files.length }));
