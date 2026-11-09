import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, localProtectedValues, sourceExclusions } from './release-privacy.mjs';
import { extractRelease } from './extract-release.mjs';
import { reviewPayload } from './review-payload.mjs';
import { checkSourcePublication } from './source-publication-gate.mjs';

const source = path.resolve(process.argv[2] ?? '.'), artifacts = path.resolve(process.argv[3] ?? 'artifacts/desktop');
checkSourcePublication(source, { binary: true });
const cache = path.resolve('.cache'); fs.mkdirSync(cache, { recursive: true });
const extracted = path.join(cache, 'release-unpacked-' + Date.now());
const sourceScan = inventory(source, localProtectedValues(process.cwd()), sourceExclusions);
if (sourceScan.findings.length) { console.log(JSON.stringify({ findings: sourceScan.findings })); throw Error('SOURCE_PRIVACY_REVIEW_NOT_PASSED'); }
const files = await extractRelease(artifacts, extracted);
const payloadScan = reviewPayload(extracted, localProtectedValues(process.cwd()));
const reviewFile = path.resolve(process.env.CHAT_BOT_REVIEW_FILE ?? '.cache/release-review.json');
const checks = ['realNames', 'privateEmails', 'computerUsernames', 'syntheticTestData', 'screenshotsAndMetadata', 'gitIdentities', 'thirdPartyAttribution', 'binaryProvenance'];
const required = { sourceDigest: sourceScan.digest, artifacts: files, checks: Object.fromEntries(checks.map(key => [key, false])) };
fs.writeFileSync(path.join(cache, 'release-review-required.json'), JSON.stringify(required, null, 2));
if (payloadScan.findings.length) { console.log(JSON.stringify({ findings: payloadScan.findings })); throw Error('PAYLOAD_PRIVACY_REVIEW_NOT_PASSED'); }
if (!fs.existsSync(reviewFile)) throw Error('MANUAL_RELEASE_REVIEW_REQUIRED');
const review = JSON.parse(fs.readFileSync(reviewFile, 'utf8'));
if (review.sourceDigest !== sourceScan.digest || checks.some(key => review.checks?.[key] !== true) || JSON.stringify(review.artifacts) !== JSON.stringify(files)) throw Error('RELEASE_REVIEW_MISSING_OR_STALE');
for (const payload of [source, extracted]) {
  const result = spawnSync(process.execPath, [path.resolve('scripts/release-guardian.mjs'), source, payload], { stdio: 'inherit', env: process.env, windowsHide: true });
  if (result.status !== 0) throw Error('GITGUARDIAN_RELEASE_GATE_NOT_PASSED');
}
fs.writeFileSync(path.join(artifacts, 'release-safety.json'), JSON.stringify({ passed: true, sourceDigest: sourceScan.digest, artifacts: files }, null, 2));
console.log(JSON.stringify({ releaseGate: 'passed', artifacts: files.length }));
