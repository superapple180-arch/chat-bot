import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); process.chdir(root);
const stage = path.resolve('.cache/desktop'); fs.mkdirSync(stage, { recursive: true });
const backend = path.join(stage, 'backend');
if (path.relative(root, fs.realpathSync(stage)).replaceAll('\\', '/') !== '.cache/desktop') throw Error('INVALID_STAGE_ROOT');
for (const directory of [backend, path.join(stage, 'node')]) {
  if (path.dirname(path.resolve(directory)) !== stage || fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) throw Error('INVALID_STAGE_DIRECTORY');
  fs.rmSync(directory, { recursive: true, force: true });
}
fs.mkdirSync(backend, { recursive: true });
for (const directory of ['dist', 'web-dist']) fs.cpSync(directory, path.join(backend, directory), { recursive: true });
const scripts = ['antigravity-tools-hook.mjs', 'understand-attachment.mjs', 'synthesize-voice.py', 'napcat-qzone-proxy.cjs', 'clear-desktop-data.mjs'];
fs.mkdirSync(path.join(backend, 'scripts'), { recursive: true });
for (const file of scripts) fs.copyFileSync(path.join('scripts', file), path.join(backend, 'scripts', file));
for (const file of ['config.antigravity.example.json', 'requirements-voice.txt', 'LICENSE', 'THIRD_PARTY.public.md']) fs.copyFileSync(file, path.join(backend, file));
fs.copyFileSync('web/THIRD_PARTY_LICENSES.txt', path.join(backend, 'WEB_THIRD_PARTY_LICENSES.txt'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
fs.writeFileSync(path.join(backend, 'package.json'), JSON.stringify({ name: 'chat-bot-backend', version: pkg.version, type: 'module', private: true, dependencies: pkg.dependencies }));
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
// Ask npm for the production graph, then copy exactly its installed packages.
const list = spawnSync(npm, ['ls', '--omit=dev', '--all', '--parseable'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 ** 2 });
if (list.status !== 0) throw Error('PRODUCTION_DEPENDENCY_GRAPH_FAILED');
for (const line of list.stdout.trim().split(/\r?\n/).slice(1)) {
  const relative = path.relative(root, line);
  if (!relative.startsWith('node_modules' + path.sep) || relative.includes('..' + path.sep)) throw Error('INVALID_DEPENDENCY_PATH');
  fs.cpSync(line, path.join(backend, relative), { recursive: true, dereference: false, verbatimSymlinks: true });
}
const version = '24.21.0', platform = process.platform, arch = process.arch;
if (!['win32-x64', 'darwin-x64', 'darwin-arm64', 'linux-x64'].includes(`${platform}-${arch}`)) throw Error('UNSUPPORTED_BUILD_PLATFORM');
const name = `node-v${version}-${platform === 'win32' ? 'win' : platform}-${arch}`, extension = platform === 'win32' ? '.zip' : '.tar.gz';
const archive = path.join(stage, name + extension), base = `https://nodejs.org/dist/v${version}/`;
const sumFile = path.join(stage, 'node-SHASUMS256.txt');
const sums = fs.existsSync(sumFile) && fs.statSync(sumFile).size ? fs.readFileSync(sumFile, 'utf8') : await (await fetch(base + 'SHASUMS256.txt')).text();
const localNode = path.resolve('runtime/node.exe');
const localExpected = sums.split('\n').find(line => line.trim().endsWith('  win-x64/node.exe'))?.split(' ')[0];
if (platform === 'win32' && fs.existsSync(localNode) && createHash('sha256').update(fs.readFileSync(localNode)).digest('hex') === localExpected) {
  const nodeRoot = path.join(stage, 'node'); fs.mkdirSync(nodeRoot, { recursive: true });
  fs.copyFileSync(localNode, path.join(nodeRoot, 'node.exe')); fs.copyFileSync('runtime/NODE-LICENSE', path.join(nodeRoot, 'LICENSE'));
  console.log(JSON.stringify({ prepared: true, platform, arch, node: version, verifiedRuntimeReused: true })); process.exit(0);
}
const expected = sums.split('\n').find(line => line.endsWith('  ' + name + extension))?.split(' ')[0];
if (!expected || !/^[a-f0-9]{64}$/.test(expected)) throw Error('NODE_CHECKSUM_MISSING');
if (!fs.existsSync(archive) || createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== expected) {
  const response = await fetch(base + name + extension); if (!response.ok) throw Error('NODE_DOWNLOAD_FAILED');
  fs.writeFileSync(archive, Buffer.from(await response.arrayBuffer()));
  if (createHash('sha256').update(fs.readFileSync(archive)).digest('hex') !== expected) throw Error('NODE_CHECKSUM_MISMATCH');
}
const unpack = path.join(stage, 'node-unpack'); fs.mkdirSync(unpack, { recursive: true });
const extracted = spawnSync('tar', ['-xf', archive, '-C', unpack], { stdio: 'ignore', windowsHide: true }); if (extracted.status !== 0) throw Error('NODE_EXTRACT_FAILED');
const nodeRoot = path.join(stage, 'node'); fs.mkdirSync(nodeRoot, { recursive: true });
if (platform === 'win32') fs.copyFileSync(path.join(unpack, name, 'node.exe'), path.join(nodeRoot, 'node.exe'));
else { fs.mkdirSync(path.join(nodeRoot, 'bin'), { recursive: true }); fs.copyFileSync(path.join(unpack, name, 'bin/node'), path.join(nodeRoot, 'bin/node')); fs.chmodSync(path.join(nodeRoot, 'bin/node'), 0o755); }
fs.copyFileSync(path.join(unpack, name, 'LICENSE'), path.join(nodeRoot, 'LICENSE'));
console.log(JSON.stringify({ prepared: true, platform, arch, node: version }));
