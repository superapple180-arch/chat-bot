import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { readConfig } from '../dist/config.js';
import { migrateLegacyConfig } from '../dist/secrets.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
const nodeMode = process.argv.includes('--node');
const directory = nodeMode ? 'vendor/NapCat-Node-4.18.41/napcat/config' : 'vendor/NapCat-4.18.41/config';
if (!fs.existsSync(directory)) throw new Error('Download and verify official NapCat first');
migrateLegacyConfig('config.local.json');
const config = readConfig('config.local.json');
const onebot = {
  network: { httpServers: [], httpClients: [], websocketServers: [{ name: 'QQGeminiLocal', enable: true, host: '127.0.0.1', port: 3001, messagePostFormat: 'array', reportSelfMessage: false, token: config.onebot.accessToken, enableForcePushEvent: true, debug: false, heartInterval: 30000 }], websocketClients: [] },
  musicSignUrl: '', enableLocalFile2Url: false, parseMultMsg: false
};
// Only create defaults. Never overwrite an existing account-specific configuration.
const writeNew = (file, value) => { if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); };
writeNew(`${directory}/onebot11.json`, onebot);
if (nodeMode && /^[1-9]\d+$/.test(config.onebot.selfId)) writeNew(`${directory}/onebot11_${config.onebot.selfId}.json`, onebot);
writeNew(`${directory}/webui.json`, { host: '127.0.0.1', port: 6099, token: crypto.randomBytes(32).toString('hex'), loginRate: 3 });
console.log('NapCat defaults prepared: loopback only, authenticated, array messages. No credentials printed.');
