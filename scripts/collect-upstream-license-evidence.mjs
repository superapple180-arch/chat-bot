import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const audit = JSON.parse(fs.readFileSync('docs/PUBLIC_SOURCE_AUDIT.json'));
const pending = [...new Map(audit.dependencies.filter(d => d.ecosystem === 'npm' && d.status === 'evidence-incomplete').map(d => [d.integrity, d])).values()];
const hash = value => createHash('sha256').update(value).digest('hex');
const outcomes = [];
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
  return response.ok ? response.text() : undefined;
}
async function collect(entry) {
  const name = entry.package.split('node_modules/').at(-1), directory = path.resolve('.cache/license-evidence', hash(entry.integrity));
  try {
    const archive = fs.readFileSync(path.join(directory, 'package.tgz'));
    if ('sha512-' + createHash('sha512').update(archive).digest('base64') !== entry.integrity) throw Error('ARCHIVE_INTEGRITY_MISMATCH');
    const metadataText = await get(`https://registry.npmjs.org/${name}/${entry.version}`);
    const metadata = JSON.parse(metadataText), repository = typeof metadata.repository === 'string' ? metadata.repository : metadata.repository.url;
    const repo = repository.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1];
    if (!repo) throw Error('UPSTREAM_REPOSITORY_REQUIRED');
    let commit = metadata.gitHead;
    let parentRelease;
    if (!commit && name.startsWith('@napi-rs/canvas-')) {
      const parentText = await get(`https://registry.npmjs.org/@napi-rs/canvas/${entry.version}`);
      const parent = JSON.parse(parentText);
      if (parent.version === entry.version && parent.repository?.url === repository) {
        commit = parent.gitHead;
        parentRelease = { package: '@napi-rs/canvas', version: parent.version, gitHead: parent.gitHead, metadataSha256: hash(parentText) };
      }
    }
    if (!/^[a-f0-9]{40}$/.test(commit ?? '')) {
      const tags = [`v${entry.version}`, entry.version, `${name}@${entry.version}`];
      const result = spawnSync('git', ['ls-remote', `https://github.com/${repo}.git`, ...tags.flatMap(tag => [`refs/tags/${tag}`, `refs/tags/${tag}^{}`])], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
      if (result.status !== 0) throw Error('VERSION_TAG_REQUIRED');
      const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
      commit = (lines.find(line => line.endsWith('^{}')) ?? lines[0])?.split(/\s/)[0];
      if (!/^[a-f0-9]{40}$/.test(commit ?? '')) throw Error('VERSION_TAG_REQUIRED');
      // Without npm gitHead, verify that the tag really contains this release version.
      const subdirectory = metadata.repository.directory;
      const candidates = [...new Set([subdirectory && `${subdirectory}/package.json`, 'package.json'].filter(Boolean))];
      let matched = false;
      for (const file of candidates) {
        const text = await get(`https://raw.githubusercontent.com/${repo}/${commit}/${file}`);
        if (text && JSON.parse(text).version === entry.version) matched = true;
      }
      if (!matched) throw Error('UPSTREAM_VERSION_NOT_CONFIRMED');
    }
    const files = [];
    let buildSource;
    if (name.startsWith('@img/sharp-libvips-')) {
      const manifestUrl = `https://raw.githubusercontent.com/${repo}/${commit}/versions.properties`;
      const manifest = await get(manifestUrl), vipsVersion = manifest?.match(/^VERSION_VIPS=(.+)$/m)?.[1];
      if (!vipsVersion || !/^\d+\.\d+\.\d+$/.test(vipsVersion)) throw Error('LIBVIPS_BUILD_VERSION_REQUIRED');
      const tag = spawnSync('git', ['ls-remote', 'https://github.com/libvips/libvips.git', `refs/tags/v${vipsVersion}`, `refs/tags/v${vipsVersion}^{}`], { encoding: 'utf8', timeout: 30000, windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' } });
      const lines = tag.stdout.trim().split(/\r?\n/).filter(Boolean), vipsCommit = (lines.find(l => l.endsWith('^{}')) ?? lines[0])?.split(/\s/)[0];
      if (tag.status !== 0 || !/^[a-f0-9]{40}$/.test(vipsCommit ?? '')) throw Error('LIBVIPS_SOURCE_COMMIT_REQUIRED');
      const url = `https://raw.githubusercontent.com/libvips/libvips/${vipsCommit}/LICENSE`, text = await get(url);
      const declarationFile = fs.readdirSync(directory).find(f => /^readme\./i.test(f));
      const declaration = declarationFile && fs.readFileSync(path.join(directory, declarationFile), 'utf8');
      if (!text || !/GNU LESSER GENERAL PUBLIC LICENSE/.test(text) || !declaration || !/any later version/.test(declaration) || !/LGPLv3/.test(declaration)) throw Error('LIBVIPS_LGPL_GRANT_REQUIRED');
      fs.mkdirSync(path.join(directory, 'licenses'), { recursive: true });
      const file = 'licenses/UPSTREAM-0-LIBVIPS.txt'; fs.writeFileSync(path.join(directory, file), text);
      files.push({ file, url, sha256: hash(text) });
      buildSource = { vipsVersion, vipsCommit, buildManifest: { url: manifestUrl, sha256: hash(manifest) }, publisherDeclaration: { file: declarationFile, sha256: hash(declaration) }, laterVersionElection: 'LGPL-3.0-or-later' };
    }
    const prefixes = [...new Set([metadata.repository.directory && metadata.repository.directory + '/', ''].filter(p => p !== undefined))];
    for (const prefix of files.length ? [] : prefixes) for (const leaf of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'license.md', 'LICENCE', 'COPYING', 'UNLICENSE']) {
      const sourcePath = prefix + leaf, url = `https://raw.githubusercontent.com/${repo}/${commit}/${sourcePath}`;
      const text = await get(url);
      if (!text || !/(?:permission|redistribut|general public license|apache license|do what the fuck|public domain)/i.test(text)) continue;
      if (/LGPL/.test(entry.reviewedLicense ?? '') && !/GNU LESSER GENERAL PUBLIC LICENSE|LGPL/i.test(text)) continue;
      const file = `UPSTREAM-${files.length}-${leaf.replaceAll('.', '-')}.txt`;
      fs.mkdirSync(path.join(directory, 'licenses'), { recursive: true }); fs.writeFileSync(path.join(directory, 'licenses', file), text);
      files.push({ file: 'licenses/' + file, url, sha256: hash(text) });
      break;
    }
    if (!files.length) throw Error('UPSTREAM_LICENSE_TEXT_MISSING');
    fs.writeFileSync(path.join(directory, 'upstream-evidence.json'), JSON.stringify({ package: name, version: entry.version, integrity: entry.integrity, repository: repo, commit, parentRelease, buildSource, registryMetadataSha256: hash(metadataText), files }, null, 2));
    outcomes.push({ package: name, result: 'upstream-evidence-collected', commit });
  } catch (error) { outcomes.push({ package: name, result: /^[A-Z_]+$/.test(error.message) ? error.message : 'UPSTREAM_EVIDENCE_UNAVAILABLE' }); }
}
const queue = [...pending];
await Promise.all(Array.from({ length: 4 }, async () => { for (;;) { const entry = queue.shift(); if (!entry) return; await collect(entry); } }));
fs.writeFileSync('.cache/upstream-license-collection.json', JSON.stringify(outcomes, null, 2));
console.log(JSON.stringify({ collected: outcomes.filter(o => o.result === 'upstream-evidence-collected').length, unresolved: outcomes.filter(o => o.result !== 'upstream-evidence-collected').length }));
