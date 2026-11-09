import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { inventory, sourceExclusions, localProtectedValues } from './release-privacy.mjs';

export function checkSourcePublication(root, { binary = false } = {}) {
  const reportFile = path.join(root, 'docs/PUBLIC_SOURCE_AUDIT.json');
  if (!fs.existsSync(reportFile)) throw Error('SOURCE_LICENSE_AUDIT_REQUIRED');
  const report = JSON.parse(fs.readFileSync(reportFile, 'utf8'));
  if (report.schema !== 1 || report.target !== 'source-only' || !Array.isArray(report.inputs) || !report.inputs.length || !Array.isArray(report.dependencies) || !report.dependencies.length || !Array.isArray(report.resources) || !Array.isArray(report.blockers)) throw Error('INVALID_SOURCE_LICENSE_AUDIT');
  for (const input of report.inputs) {
    const file = path.resolve(root, input.file), relative = path.relative(path.resolve(root), file);
    if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.existsSync(file) || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== input.sha256) throw Error('SOURCE_LICENSE_AUDIT_STALE');
  }
  const scan = inventory(root, localProtectedValues(process.cwd()), sourceExclusions);
  if (scan.findings.length) throw Error('SOURCE_PRIVACY_REVIEW_NOT_PASSED');
  for (const item of scan.files.filter(f => f.kind !== 'text' || /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|heic|mp3|wav|ogg|flac|aac|opus|m4a|ttf|otf|eot|woff2?|mp4|mov|mkv|webm|pdf|docx)$/i.test(f.file))) {
    if (!report.resources.some(r => r.file === item.file && r.sha256 === item.sha256 && r.decision === 'include')) throw Error('STATIC_RESOURCE_AUTHORIZATION_REQUIRED');
  }
  for (const kind of ['media', 'voice']) if (JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, `assets/${kind}/index.json`)))) !== '[]') throw Error('EMPTY_PUBLIC_MEDIA_INDEX_REQUIRED');
  if (report.uploadAllowed !== true || report.blockers.length || report.dependencies.some(d => !['distribution-inspected', 'upstream-license-inspected', 'publisher-declared-source-only'].includes(d.status) || !['MIT-option', 'component-obligations', 'permissive-with-notices', 'gpl-compatible-source-only'].includes(d.compatibility))) throw Error('SOURCE_LICENSE_REVIEW_NOT_PASSED');
  if (binary && (!Array.isArray(report.binaryBlockers) || report.binaryBlockers.length || report.dependencies.some(d => d.status === 'publisher-declared-source-only' || d.compatibility === 'gpl-compatible-source-only'))) throw Error('BINARY_LICENSE_REVIEW_NOT_PASSED');
  return { sourcePublicationGate: 'passed', digest: scan.digest };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(checkSourcePublication(path.resolve(process.argv[2] ?? '.')))); }
  catch (error) { console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'SOURCE_PUBLICATION_CHECK_FAILED'); process.exitCode = 1; }
}
