import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

// Download exact locked distributions; extract evidence to stdout, never trust archive paths as destinations.
const audit = JSON.parse(fs.readFileSync('docs/PUBLIC_SOURCE_AUDIT.json'));
const pending = audit.dependencies.filter(d => d.ecosystem === 'npm' && d.status === 'evidence-incomplete');
const locks = new Map(['package-lock.json', 'desktop-app/package-lock.json'].map(file => [file, JSON.parse(fs.readFileSync(file)).packages]));
const queue = [...new Map(pending.map(d => [locks.get(d.lock)[d.package].integrity, d])).values()];
let verified = 0, failed = 0, downloadedBytes = 0;
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
async function collect(entry) {
  try {
    const item = locks.get(entry.lock)[entry.package], [algorithm, expected] = item.integrity.split('-');
    if (algorithm !== 'sha512' || !expected) throw Error('INTEGRITY_REQUIRED');
    const key = createHash('sha256').update(item.integrity).digest('hex');
    const directory = path.resolve('.cache/license-evidence', key); fs.mkdirSync(directory, { recursive: true });
    const archive = path.join(directory, 'package.tgz');
    let bytes = fs.existsSync(archive) ? fs.readFileSync(archive) : undefined;
    if (!bytes || createHash(algorithm).update(bytes).digest('base64') !== expected) {
      const name = entry.package.split('node_modules/').at(-1);
      const metadata = await fetch(`https://registry.npmjs.org/${name}/${entry.version}`, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!metadata.ok) throw Error('METADATA_DOWNLOAD_FAILED');
      const tarball = new URL((await metadata.json()).dist.tarball);
      if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org') throw Error('UNEXPECTED_TARBALL_ORIGIN');
      const response = await fetch(tarball, { signal: AbortSignal.timeout(90000), redirect: 'error' });
      if (!response.ok) throw Error('PACKAGE_DOWNLOAD_FAILED');
      bytes = Buffer.from(await response.arrayBuffer()); downloadedBytes += bytes.length;
      if (createHash(algorithm).update(bytes).digest('base64') !== expected) throw Error('PACKAGE_INTEGRITY_MISMATCH');
      fs.writeFileSync(archive, bytes);
    }
    const list = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 16 * 1024 ** 2, windowsHide: true });
    if (list.status !== 0) throw Error('PACKAGE_LIST_FAILED');
    const names = list.stdout.split(/\r?\n/).filter(name => /^[a-zA-Z0-9@._-]+\/(?:package\.json|(?:LICEN[CS]E|COPYING|NOTICE|README)(?:[._-][a-zA-Z0-9._-]+)?|licenses?\/[a-zA-Z0-9._-]+)$/i.test(name));
    for (const name of names) {
      const result = spawnSync('tar', ['-xOzf', archive, name], { maxBuffer: 16 * 1024 ** 2, windowsHide: true });
      if (result.status !== 0 || !result.stdout.length) continue;
      const destination = path.join(directory, name.slice(name.indexOf('/') + 1));
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, result.stdout);
    }
    // Bind cached evidence to the verified archive, including its metadata.
    fs.writeFileSync(path.join(directory, 'verified-integrity.txt'), item.integrity);
    const manifestBytes = fs.readFileSync(path.join(directory, 'package.json'));
    const manifest = JSON.parse(manifestBytes);
    const name = entry.package.split('node_modules/').at(-1);
    if (manifest.name !== name || manifest.version !== entry.version) throw Error('PUBLISHER_PACKAGE_MISMATCH');
    if (['MIT', 'WTFPL'].includes(manifest.license) && manifest.license === item.license) {
      const registry = `https://registry.npmjs.org/${name}/${entry.version}`;
      const response = await fetch(registry, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw Error('PUBLISHER_DECLARATION_UNAVAILABLE');
      const metadataBytes = Buffer.from(await response.arrayBuffer());
      const published = JSON.parse(metadataBytes);
      if (published.name !== name || published.version !== entry.version || published.license !== manifest.license || published.dist?.integrity !== item.integrity) throw Error('PUBLISHER_DECLARATION_MISMATCH');
      const terms = `https://raw.githubusercontent.com/spdx/license-list-data/v3.26.0/text/${manifest.license}.txt`;
      const licenseResponse = await fetch(terms, { signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!licenseResponse.ok) throw Error('STANDARD_LICENSE_TEXT_UNAVAILABLE');
      const licenseBytes = Buffer.from(await licenseResponse.arrayBuffer());
      fs.writeFileSync(path.join(directory, 'publisher-registry.json'), metadataBytes);
      fs.writeFileSync(path.join(directory, 'declared-license.txt'), licenseBytes);
      fs.writeFileSync(path.join(directory, 'publisher-declaration.json'), JSON.stringify({ name, version: entry.version, license: manifest.license, integrity: item.integrity, registry, metadataSha256: sha256(metadataBytes), manifestSha256: sha256(manifestBytes), terms, termsSha256: sha256(licenseBytes) }, null, 2));
    }
    verified++;
  } catch { failed++; }
}
await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const entry = queue.shift(); if (!entry) return; await collect(entry); } }));
console.log(JSON.stringify({ verified, failed, downloadedBytes, evidenceDirectory: '.cache/license-evidence' }));
if (failed) process.exitCode = 1;
