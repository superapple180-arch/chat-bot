import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = fs.realpathSync(process.cwd()), cache = path.join(root, '.cache');
fs.mkdirSync(cache, { recursive: true });
// Downloaded builder utilities are CommonJS, independent of our ESM project.
fs.writeFileSync(path.join(cache, 'package.json'), '{"private":true,"type":"commonjs"}\n');
const output = path.join(root, 'artifacts/desktop');
if (path.relative(root, output).replaceAll('\\', '/') !== 'artifacts/desktop' || fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw Error('INVALID_BUILD_OUTPUT');
fs.rmSync(output, { recursive: true, force: true });
const privateLog = process.env.CI === 'true' ? fs.openSync(path.join(cache, 'desktop-build.log'), 'w', 0o600) : undefined;
const result = spawnSync(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--config', 'electron-builder.config.cjs', '--publish', 'never', ...process.argv.slice(2)], { stdio: privateLog === undefined ? 'inherit' : ['ignore', privateLog, privateLog], env: { ...process.env, ELECTRON_BUILDER_CACHE: path.join(cache, 'electron-builder') }, windowsHide: true });
if (privateLog !== undefined) { fs.closeSync(privateLog); console.log(result.status === 0 ? 'DESKTOP_BUILD_PASSED' : 'DESKTOP_BUILD_FAILED_PRIVATE_LOG_RETAINED'); }
if (result.status !== 0) process.exit(result.status ?? 1);
