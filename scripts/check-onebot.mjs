import fs from 'node:fs';
import path from 'node:path';
import { OneBot } from '../dist/onebot.js';
import { readConfig } from '../dist/config.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
const config = readConfig('config.local.json');
const result = await new Promise(resolve => {
  let settled = false, lastReason = 'NOT_CONNECTED';
  const bot = new OneBot(config.onebot, () => {}, (ready, reason) => {
    lastReason = reason;
    if (ready) finish({ ready: true, accountMatched: true, code: 'CONNECTED' });
  });
  const timer = setTimeout(() => finish({ ready: false, accountMatched: false, code: lastReason }), 10000);
  function finish(value) { if (settled) return; settled = true; clearTimeout(timer); bot.close(); resolve(value); }
  bot.start();
});
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/onebot-readiness.json', JSON.stringify({ at: new Date().toISOString(), ...result }, null, 2));
console.log(JSON.stringify(result));
if (!result.ready) process.exitCode = 1;
