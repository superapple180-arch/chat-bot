import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { isReleaseFile } from './release-files.mjs';
import { assertPackagedDependencies } from './assert-packaged-dependencies.mjs';
const require = createRequire(import.meta.url);
process.env.ELECTRON_BUILDER_CACHE ??= path.resolve('.cache/electron-builder');
const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js');
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, windowsHide: true, stdio: 'pipe', timeout: 600000, maxBuffer: 8 * 1024 ** 2 }); if (result.error || result.status !== 0) throw Error('INSTALLER_EXTRACTION_FAILED'); }
function list(root) { return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? list(path.join(root, entry.name)) : entry.isFile() ? [path.join(root, entry.name)] : []); }
export async function extractRelease(directory, destination) {
  const releaseFiles = fs.readdirSync(directory).filter(isReleaseFile);
  const archives = releaseFiles.filter(file => /\.(?:exe|dmg|zip|deb|AppImage)$/.test(file));
  if (!archives.length || fs.existsSync(destination)) throw Error('FRESH_EXTRACTION_AND_INSTALLERS_REQUIRED');
  fs.mkdirSync(destination, { recursive: true }); const results = [];
  for (const name of archives) {
    const file = path.resolve(directory, name), output = path.join(destination, name + '.contents'); fs.mkdirSync(output);
    if (process.env.CHAT_BOT_FORMAL === '1' && name.endsWith('.exe')) {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "if ((Get-AuthenticodeSignature -LiteralPath $env:CHAT_BOT_INSTALLER).Status -ne 'Valid') { exit 1 }"], { env: { ...process.env, CHAT_BOT_INSTALLER: file }, stdio: 'pipe', windowsHide: true });
      if (result.status !== 0) throw Error('WINDOWS_SIGNATURE_NOT_VALID');
    }
    if (name.endsWith('.exe')) run(await getPath7za(), ['x', file, '-o' + output, '-y']);
    else if (name.endsWith('.dmg')) {
      if (process.platform !== 'darwin') throw Error('DMG_REQUIRES_MACOS');
      const mount = path.join(destination, name + '.mount'); fs.mkdirSync(mount);
      run('hdiutil', ['attach', '-nobrowse', '-readonly', '-mountpoint', mount, file]);
      try { for (const entry of fs.readdirSync(mount)) if (entry.endsWith('.app')) fs.cpSync(path.join(mount, entry), path.join(output, entry), { recursive: true, verbatimSymlinks: true }); }
      finally { run('hdiutil', ['detach', mount]); }
    } else if (name.endsWith('.deb')) {
      run('ar', ['x', file], output);
      const data = fs.readdirSync(output).find(entry => /^data\.tar/.test(entry)); if (!data) throw Error('DEB_PAYLOAD_MISSING');
      run('tar', ['-xf', path.join(output, data), '-C', output]);
    } else if (name.endsWith('.AppImage')) {
      if (process.platform !== 'linux') throw Error('APPIMAGE_REQUIRES_LINUX'); fs.chmodSync(file, 0o755); run(file, ['--appimage-extract'], output);
    } else run('tar', ['-xf', file, '-C', output]);
    for (let round = 0; round < 3; round++) {
      const nested = list(output).filter(entry => entry.endsWith('.7z') && !fs.existsSync(entry + '.contents'));
      if (!nested.length) break;
      for (const archive of nested) run(await getPath7za(), ['x', archive, '-o' + archive + '.contents', '-y']);
    }
    const asars = list(output).filter(entry => entry.endsWith('app.asar'));
    if (process.env.CHAT_BOT_FORMAL === '1' && process.platform === 'darwin') {
      const bundles = fs.readdirSync(output).filter(entry => entry.endsWith('.app'));
      if (!bundles.length) throw Error('MAC_APP_BUNDLE_MISSING');
      for (const bundle of bundles) { run('codesign', ['--verify', '--deep', '--strict', path.join(output, bundle)]); run('spctl', ['--assess', '--type', 'execute', path.join(output, bundle)]); }
    }
    if (!asars.length || !list(output).some(entry => entry.endsWith(path.join('dist', 'desktop-service.js')))) throw Error('INCOMPLETE_INSTALLER_EXTRACTION');
    for (const entry of list(output).filter(file => file.endsWith(path.join('dist', 'desktop-service.js')))) assertPackagedDependencies(path.dirname(path.dirname(entry)));
    const { extractAll } = await import('@electron/asar');
    for (const asar of asars) await extractAll(asar, asar + '.contents');
    results.push({ file: name, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
  }
  const metadata = path.join(destination, 'release-metadata'); fs.mkdirSync(metadata);
  for (const name of releaseFiles.filter(file => !archives.includes(file))) {
    fs.copyFileSync(path.join(directory, name), path.join(metadata, name));
    results.push({ file: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') });
  }
  return results.sort((a, b) => a.file.localeCompare(b.file));
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await extractRelease(path.resolve(process.argv[2]), path.resolve(process.argv[3]))));
