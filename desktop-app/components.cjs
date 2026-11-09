const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const agyBase = 'https://storage.googleapis.com/antigravity-public/antigravity-cli/1.5.0-5269980577660928/';
const specs = {
  'win32-x64': {
    agy: ['windows-x64/cli_windows_x64.exe', '9877ace806be37a3b8a8165ce1f61016d07955ec4306219051f90f4749a38727d61ef2d1a6441270684cea7fd2733c8a8524170ec9ff301b1b6a6b9c543d864e'],
    napcat: ['https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.41/NapCat.Shell.Windows.Node.zip', '51fbb10e7bcd56b0c2a6de86c37811e7518330e48a137ac689ab1e4d8627d3f0'],
    uv: ['uv-x86_64-pc-windows-msvc.zip', '0cdc5b38fe5a8168ed6a25814f5ba43c21d313dd3187314fccb37b7cec46e021']
  },
  'darwin-arm64': {
    agy: ['darwin-arm/cli_mac_arm64.tar.gz', '833a0a18a418f70b9fb8b2b1a4c4dc571f1b168b5104aa30379463695946ccc0201cd48f9cfd30231eb668ae6d07efe1b49a619ccaa14f7ee2861f9e049ee2be'],
    uv: ['uv-aarch64-apple-darwin.tar.gz', '81b811b57e4624df7ed3aac148e0359100d9962f3d9dce00aec533dc2e086731']
  },
  'darwin-x64': {
    agy: ['darwin-x64/cli_mac_x64.tar.gz', '00525e7fd227dd3dd258cf43a2f9adff73d6fe2afe5ca1c1fb1f0b0624cbd4af4b2891b8281868d4dc7c33b4f5f509e96d2e9d319657c56a147a55de5d411272'],
    uv: ['uv-x86_64-apple-darwin.tar.gz', '20c47e4c1f630b8abaff8c291fa9b9aa300fef92c4fbff95adf198b55287cda7']
  },
  'linux-x64': {
    agy: ['linux-x64/cli_linux_x64.tar.gz', 'e6031f850929210705d8c2393a5665b82b8c3b19684a6d3c556cafa31f26f77acbf164dfee96ca84a5ae7670ac0cc238a974c981c517b269194bdccff271cbd5'],
    napcat: ['https://github.com/NapNeko/NapCatAppImageBuild/releases/download/v4.18.41/QQ-53644_NapCat-v4.18.41-amd64.AppImage', '512288997fd0f7dcde71df9b65b7238b3f8dd93bc4910f583ea62e718fc0da66'],
    uv: ['uv-x86_64-unknown-linux-gnu.tar.gz', 'c5221ff41b7892bfc223543883600125f6a47fe845093e0f5bdff4f359196d83']
  }
};
const macInstaller = ['https://github.com/NapNeko/NapCat-Mac-Installer/releases/download/v1.7/NapCatInstaller_arm64.amd64.zip', '93537837ae2a5d645393fbe67a758fbaebe93ca2b8cad3a608582c4be12a92a4'];
async function download(url, file, digest, fetcher = fetch) {
  if (fs.existsSync(file) && createHash(digest.length === 128 ? 'sha512' : 'sha256').update(fs.readFileSync(file)).digest('hex') === digest) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const response = await fetcher(url, { signal: AbortSignal.timeout(600000) });
  if (!response.ok || !response.body) throw Error('COMPONENT_DOWNLOAD_FAILED');
  const output = fs.createWriteStream(file + '.part', { mode: 0o600 });
  const hash = createHash(digest.length === 128 ? 'sha512' : 'sha256'); let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length; if (size > 1024 ** 3) throw Error('COMPONENT_TOO_LARGE');
      hash.update(chunk); if (!output.write(Buffer.from(chunk))) await new Promise((resolve, reject) => { output.once('drain', resolve); output.once('error', reject); });
    }
    await new Promise((resolve, reject) => { output.once('error', reject); output.end(resolve); });
    if (hash.digest('hex') !== digest) throw Error('COMPONENT_HASH_MISMATCH');
    fs.renameSync(file + '.part', file);
  } catch (e) { output.destroy(); fs.rmSync(file + '.part', { force: true }); throw e; }
}
async function extract(file, destination) {
  fs.mkdirSync(destination, { recursive: true });
  const { stdout } = await run('tar', ['-tf', file], { windowsHide: true, maxBuffer: 8 * 1024 ** 2 });
  if (stdout.split(/\r?\n/).filter(Boolean).some(name => path.isAbsolute(name) || name.replaceAll('\\', '/').split('/').includes('..'))) throw Error('UNSAFE_ARCHIVE');
  await run('tar', ['-xf', file, '-C', destination], { windowsHide: true });
}
function find(root, name) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isFile() && entry.name === name) return file;
    if (entry.isDirectory()) { const hit = find(file, name); if (hit) return hit; }
  }
}
async function prepare(root, codeRoot, progress, fetcher = fetch) {
  const spec = specs[`${process.platform}-${process.arch}`]; if (!spec) throw Error('PLATFORM_NOT_SUPPORTED');
  const cache = path.join(root, 'downloads');
  progress('正在准备模型组件');
  const agy = path.join(root, 'antigravity', process.platform === 'win32' ? 'agy.exe' : 'agy');
  if (!fs.existsSync(agy)) {
    const archive = path.join(cache, path.basename(spec.agy[0]));
    await download(agyBase + spec.agy[0], archive, spec.agy[1], fetcher);
    fs.mkdirSync(path.dirname(agy), { recursive: true });
    if (process.platform === 'win32') fs.copyFileSync(archive, agy);
    else { const unpacked = path.join(root, 'antigravity/unpacked'); await extract(archive, unpacked); const entry = path.join(unpacked, 'antigravity'); if (!fs.existsSync(entry)) throw Error('ANTIGRAVITY_ENTRY_MISSING'); fs.copyFileSync(entry, agy); fs.chmodSync(agy, 0o755); }
  }
  progress('正在准备 QQ 接入组件');
  const qqRoot = path.join(root, 'napcat'); fs.mkdirSync(qqRoot, { recursive: true });
  if (process.platform === 'darwin') {
    const archive = path.join(cache, 'NapCatInstaller.zip'); await download(macInstaller[0], archive, macInstaller[1], fetcher);
    if (!fs.existsSync(path.join(qqRoot, 'installer'))) await extract(archive, path.join(qqRoot, 'installer'));
  } else if (process.platform === 'win32' && !fs.existsSync(path.join(qqRoot, 'node.exe'))) {
    const archive = path.join(cache, 'NapCat.zip'); await download(spec.napcat[0], archive, spec.napcat[1], fetcher); await extract(archive, qqRoot);
  } else if (process.platform === 'linux') {
    await download(spec.napcat[0], path.join(qqRoot, 'NapCat.AppImage'), spec.napcat[1], fetcher); fs.chmodSync(path.join(qqRoot, 'NapCat.AppImage'), 0o755);
  }
  progress('正在准备语音环境');
  const python = path.join(root, 'runtime/voice-venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  if (!fs.existsSync(path.join(root, 'voice-ready.json')) || !fs.existsSync(python)) {
    const archive = path.join(cache, spec.uv[0]); await download('https://github.com/astral-sh/uv/releases/download/0.13.7/' + spec.uv[0], archive, spec.uv[1], fetcher);
    const uvRoot = path.join(root, 'uv'); await extract(archive, uvRoot);
    const uv = find(uvRoot, process.platform === 'win32' ? 'uv.exe' : 'uv'); if (!uv) throw Error('UV_ENTRY_MISSING');
    if (process.platform !== 'win32') fs.chmodSync(uv, 0o755);
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(root, 'python'), UV_CACHE_DIR: path.join(root, 'uv-cache'), UV_PYTHON_CACHE_DIR: path.join(root, 'python-cache'), UV_NO_PROGRESS: '1' };
    const options = { env, windowsHide: true, timeout: 600000, maxBuffer: 1024 ** 2 };
    await run(uv, ['python', 'install', '3.12.12', '--no-bin', '--no-registry'], options);
    await run(uv, ['venv', '--python', '3.12.12', '--managed-python', path.dirname(path.dirname(python))], options);
    await run(uv, ['pip', 'sync', '--python', python, path.join(codeRoot, 'requirements-voice.txt')], options);
    fs.writeFileSync(path.join(root, 'voice-ready.json'), JSON.stringify({ uv: '0.13.7', python: '3.12.12' }));
  }
  progress('组件已准备好');
  return { agy, python, macInstaller: process.platform === 'darwin' ? find(path.join(qqRoot, 'installer'), 'NapCatInstaller') : null };
}
module.exports = { specs, download, extract, prepare, find };
