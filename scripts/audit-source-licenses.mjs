import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { inventory, sourceExclusions, forbiddenPublicFile } from './release-privacy.mjs';
import { fixtureBuffers } from './synthetic-fixtures.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const evidence = file => ({ file: file.replaceAll('\\', '/'), sha256: hash(fs.readFileSync(file)) });
const reviewedStatuses = ['distribution-inspected', 'upstream-license-inspected', 'publisher-declared-source-only'];
function assessment(license, status) {
  if (!reviewedStatuses.includes(status)) return { compatibility: 'unresolved', obligations: ['Verify the exact package publisher grant and its license terms before publication'] };
  if (license === '(MIT OR GPL-3.0-or-later)') return { compatibility: 'MIT-option', obligations: ['Choose MIT; retain copyright and license'] };
  if (/LGPL|Lesser General/i.test(license ?? '')) return { compatibility: 'component-obligations', obligations: ['Keep LGPL notices, corresponding source and applicable replacement/relinking rights for any future binary distribution'] };
  if (/GPL/i.test(license ?? '')) return { compatibility: 'unresolved', obligations: ['Resolve combined-work licensing before publication; do not relabel GPL code as MIT'] };
  if (/MPL/i.test(license ?? '')) return { compatibility: 'component-obligations', obligations: ['Keep MPL notices and make covered modified files available under MPL if distributed'] };
  if (/MIT|ISC|BSD|Apache|BlueOak|Python|PSF|WTFPL|0BSD|CC0|Unlicense/i.test(license ?? '')) return { compatibility: 'permissive-with-notices', obligations: ['Retain applicable copyright, license, attribution and NOTICE; satisfy every AND branch'] };
  return { compatibility: 'unresolved', obligations: ['License interpretation required'] };
}
function licenseFiles(directory, insideLicenseDirectory = false) {
  const files = [];
  if (!fs.existsSync(directory)) return files;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isFile() && (insideLicenseDirectory || /^(?:LICEN[CS]E|COPYING|NOTICE)(?:[._-]|$)/i.test(entry.name))) files.push(evidence(file));
    else if (entry.isFile() && /^readme(?:\.|$)/i.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/permission is hereby granted[\s\S]+free of charge/i.test(text) && /copyright notice and this permission notice/i.test(text) && /provided\s+["']AS IS["']/i.test(text)) files.push(evidence(file));
    }
    else if (entry.isDirectory() && /^licenses?$/i.test(entry.name)) files.push(...licenseFiles(file, true));
  }
  return files;
}
export function verifyUpstreamGrant(directory, upstream, version, integrity, license) {
  if (upstream?.version !== version || upstream?.integrity !== integrity || !/^[a-f0-9]{40}$/.test(upstream?.commit ?? '') || !upstream.files?.length) return false;
  return upstream.files.every(entry => {
    const file = path.join(directory, entry.file);
    if (!entry.file.startsWith('licenses/') || entry.file.includes('..') || !fs.existsSync(file)) return false;
    const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
    if (hash(bytes) !== entry.sha256) return false;
    if (/LGPL/.test(license ?? '')) return /GNU LESSER GENERAL PUBLIC LICENSE/.test(text);
    if (license === 'MIT') return /permission is hereby granted[\s\S]+free of charge/i.test(text) && /copyright notice and this permission notice/i.test(text);
    if (license === 'Apache-2.0') return /Apache License[\s\S]+Version 2\.0/i.test(text);
    if (license === 'WTFPL') return /do what the fuck you want to/i.test(text);
    return false;
  });
}
function publisherDeclaration(directory, name, item) {
  if (!['MIT', 'WTFPL'].includes(item.license)) return undefined;
  const file = path.join(directory, 'publisher-declaration.json');
  if (!fs.existsSync(file)) return undefined;
  const record = JSON.parse(fs.readFileSync(file, 'utf8'));
  const manifestBytes = fs.readFileSync(path.join(directory, 'package.json'));
  const metadataBytes = fs.readFileSync(path.join(directory, 'publisher-registry.json'));
  const termsBytes = fs.readFileSync(path.join(directory, 'declared-license.txt'));
  const manifest = JSON.parse(manifestBytes), published = JSON.parse(metadataBytes);
  if ([record, manifest, published].some(value => value.name !== name || value.version !== item.version || value.license !== item.license)) return undefined;
  if (record.integrity !== item.integrity || published.dist?.integrity !== item.integrity) return undefined;
  if (record.registry !== `https://registry.npmjs.org/${name}/${item.version}` || record.terms !== `https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/${item.license}.txt`) return undefined;
  if (record.manifestSha256 !== hash(manifestBytes) || record.metadataSha256 !== hash(metadataBytes) || record.termsSha256 !== hash(termsBytes)) return undefined;
  const integrity = createHash('sha512').update(fs.readFileSync(path.join(directory, 'package.tgz'))).digest('base64');
  return item.integrity === `sha512-${integrity}` ? record : undefined;
}
export async function auditSourceLicenses(root = '.') {
  const project = path.resolve(root), previous = process.cwd(); process.chdir(project);
  try {
    const dependencies = [], blockers = [], binaryBlockers = [], inputs = [];
    for (const lock of ['package-lock.json', 'desktop-app/package-lock.json']) {
      inputs.push(evidence(lock));
      for (const [location, item] of Object.entries(JSON.parse(fs.readFileSync(lock)).packages)) {
        if (!location) continue;
        let directory = path.join(path.dirname(lock), location);
        const cache = path.join('.cache/license-evidence', hash(item.integrity ?? ''));
        if (licenseFiles(directory).length === 0 || !fs.existsSync(path.join(directory, 'package.json')) || JSON.parse(fs.readFileSync(path.join(directory, 'package.json'))).version !== item.version) {
          const verified = path.join(cache, 'verified-integrity.txt');
          if (fs.existsSync(verified) && fs.readFileSync(verified, 'utf8') === item.integrity) directory = cache;
        }
        const manifest = path.join(directory, 'package.json');
        const installed = fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest)) : undefined;
        const licenses = licenseFiles(directory);
        let actual = installed?.license ?? item.license ?? null;
        // Resolve these two ambiguous/missing manifest labels against their actual distributions.
        if (licenses.length && location.endsWith('/parse-cache-control')) actual = 'BSD-3-Clause';
        if (licenses.length && location.endsWith('/duck')) actual = 'BSD-2-Clause';
        const upstreamFile = path.join(directory, 'upstream-evidence.json');
        const upstream = fs.existsSync(upstreamFile) ? JSON.parse(fs.readFileSync(upstreamFile, 'utf8')) : undefined;
        const upstreamValid = verifyUpstreamGrant(directory, upstream, item.version, item.integrity, actual);
        const bundledLicenses = licenses.filter(entry => !path.basename(entry.file).startsWith('UPSTREAM-'));
        const name = location.split('node_modules/').at(-1);
        const publisher = !bundledLicenses.length && !upstreamValid ? publisherDeclaration(directory, name, item) : undefined;
        const status = installed?.version !== item.version ? 'evidence-incomplete' : bundledLicenses.length ? 'distribution-inspected' : upstreamValid ? 'upstream-license-inspected' : publisher ? 'publisher-declared-source-only' : 'evidence-incomplete';
        const licenseAssessment = assessment(actual, status);
        if (name === 'ffmpeg-static' && actual === 'GPL-3.0-or-later' && status === 'distribution-inspected') {
          licenseAssessment.compatibility = 'gpl-compatible-source-only';
          licenseAssessment.obligations = ['The original MIT source is GPLv3-compatible. The source export excludes the GPL package and binary. Distribution of a covered combination requires GPL terms and Corresponding Source.'];
          binaryBlockers.push({ code: 'GPL_COMBINED_DISTRIBUTION_REVIEW_REQUIRED', package: name });
        }
        dependencies.push({ ecosystem: 'npm', lock, package: location, version: item.version, integrity: item.integrity ?? null, declaredLicense: item.license ?? null, reviewedLicense: actual, dev: Boolean(item.dev), optional: Boolean(item.optional), status, upstream: upstreamValid ? upstream : undefined, publisher, ...licenseAssessment, evidence: licenses });
      }
    }
    inputs.push(evidence('requirements-voice.txt'));
    const site = 'runtime/voice-venv/Lib/site-packages';
    for (const requirement of fs.readFileSync('requirements-voice.txt', 'utf8').trim().split(/\r?\n/)) {
      const [name, version] = requirement.split('=='), normalized = name.replaceAll('-', '_');
      const directory = path.join(site, `${normalized}-${version}.dist-info`), metadata = path.join(directory, 'METADATA');
      const text = fs.existsSync(metadata) ? fs.readFileSync(metadata, 'utf8').split(/\r?\n\r?\n/)[0] : '';
      const licenses = licenseFiles(directory);
      const label = text.match(/^License-Expression: (.+)$/m)?.[1] ?? text.match(/^License: (.+)$/m)?.[1] ?? [...text.matchAll(/^Classifier: License :: (.+)$/gm)].map(m => m[1]).join('; ');
      const status = text && licenses.length ? 'distribution-inspected' : 'evidence-incomplete';
      dependencies.push({ ecosystem: 'python', package: name, version, reviewedLicense: label || null, status, ...assessment(label, status), evidence: licenses });
    }
    const incomplete = dependencies.filter(item => !reviewedStatuses.includes(item.status));
    if (incomplete.length) blockers.push({ code: 'DEPENDENCY_LICENSE_EVIDENCE_INCOMPLETE', packages: incomplete.length });
    const unresolved = dependencies.filter(item => reviewedStatuses.includes(item.status) && item.compatibility === 'unresolved');
    if (unresolved.length) blockers.push({ code: 'DEPENDENCY_LICENSE_COMPATIBILITY_UNRESOLVED', packages: unresolved.length });
    const publisherOnly = dependencies.filter(item => item.status === 'publisher-declared-source-only');
    if (publisherOnly.length) binaryBlockers.push({ code: 'DEPENDENCY_DISTRIBUTION_NOTICE_REVIEW_REQUIRED', packages: publisherOnly.length });
    const resources = [], fixtures = await fixtureBuffers();
    const files = inventory('.', [], sourceExclusions).files;
    const svg = fs.readFileSync('scripts/create-desktop-icon.mjs', 'utf8').match(/const svg = '([^']+)';/)?.[1];
    const iconHash = svg ? hash(await sharp(Buffer.from(svg)).png().toBuffer()) : undefined;
    for (const { file, sha256 } of files.filter(item => item.kind !== 'text' || /\.(?:png|jpe?g|gif|webp|svg|ico|bmp|tiff?|avif|heic|mp3|wav|ogg|flac|aac|opus|m4a|ttf|otf|eot|woff2?|mp4|mov|mkv|webm|pdf|docx)$/i.test(item.file))) {
      let decision = 'exclude', basis = 'No verified redistribution grant';
      if (file === 'desktop-app/icon.png' && sha256 === iconHash) { decision = 'include'; basis = 'Byte-identical to project-authored SVG generator; MIT'; }
      // Public document fixtures are regenerated by export-release, never copied from the working tree.
      if (/^test\/fixtures\/attachment\.(?:pdf|docx)$/.test(file)) {
        resources.push({ file, sha256: hash(fixtures[path.basename(file)]), decision: 'include', basis: 'Regenerated by scripts/synthetic-fixtures.mjs; text only, no embedded font binary' });
        continue;
      }
      resources.push({ file, sha256, decision, basis });
    }
    for (const kind of ['media', 'voice']) {
      if (!fs.existsSync(`assets/${kind}/index.json`)) blockers.push({ code: 'EMPTY_PUBLIC_MEDIA_INDEX_REQUIRED', kind });
    }
    const reviewedFiles = new Set(['LICENSE', 'README.public.md', 'THIRD_PARTY.public.md', 'docs/DESKTOP_APP.md', 'docs/PUBLIC_SOURCE_AUDIT.md', 'package.json', 'tsconfig.json', '.gitignore', '.env.example', 'config.example.json', 'config.antigravity.example.json', 'electron-builder.config.cjs']);
    for (const { file } of files) if (/^(?:src|test|web|desktop|desktop-app|scripts|\.githooks|\.github)\//.test(file) && !file.startsWith('test/fixtures/') && file !== 'scripts/send-completion.mjs' && !forbiddenPublicFile(file)) reviewedFiles.add(file);
    inputs.push(...[...reviewedFiles].sort().map(evidence));
    const report = { schema: 1, target: 'source-only', originalLicense: 'MIT', inputs, dependencies, resources, externalComponents: [
      { name: 'NapCatQQ', version: '4.18.41', distributed: false, license: 'Limited Redistribution License', source: 'https://github.com/NapNeko/NapCatQQ/blob/v4.18.41/LICENSE', restriction: 'Non-commercial; do not relabel as MIT' },
      { name: 'Antigravity CLI', distributed: false, license: 'External proprietary service terms; not represented as open source' }
    ], blockers, binaryBlockers, uploadAllowed: blockers.length === 0 };
    return report;
  } finally { process.chdir(previous); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = await auditSourceLicenses(process.argv[2] ?? '.');
  const file = path.resolve(process.argv[2] ?? '.', 'docs/PUBLIC_SOURCE_AUDIT.json');
  fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ npm: report.dependencies.filter(d => d.ecosystem === 'npm').length, python: report.dependencies.filter(d => d.ecosystem === 'python').length, resources: report.resources.length, blockers: report.blockers, uploaded: false }));
}
