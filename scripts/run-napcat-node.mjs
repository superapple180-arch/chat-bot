import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
process.chdir(path.resolve(import.meta.dirname, '..'));
let selfId;
try { selfId = JSON.parse(fs.readFileSync('config.local.json', 'utf8')).onebot.selfId; } catch { throw Error('QQ_ACCOUNT_CONFIG_REQUIRED'); }
if (typeof selfId !== 'string' || !/^[1-9]\d+$/.test(selfId)) throw Error('QQ_ACCOUNT_CONFIG_REQUIRED');
const directory = path.resolve('vendor/NapCat-Node-4.18.41');
const env = { ...process.env, ONEBOT_ACCESS_TOKEN: undefined };
const config = JSON.parse(fs.readFileSync('config.local.json', 'utf8'));
if (config.qzone?.enabled && config.qzone.proxyUrl) env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require="${path.resolve('scripts/napcat-qzone-proxy.cjs').replaceAll('\\', '/')}"`].filter(Boolean).join(' ');
const child = spawn(path.join(directory, 'node.exe'), ['index.js', '-q', selfId], { cwd: directory, stdio: 'inherit', shell: false, env });
child.on('error', () => { console.error('NAPCAT_NODE_START_FAILED'); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
