import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
const target = path.resolve(process.argv[2] ?? ''), expected = path.resolve(process.argv[3] ?? '');
if (target !== expected || target === path.parse(target).root || path.basename(target).toLowerCase() !== 'chat-bot') throw Error('INVALID_DATA_ROOT');
await delay(3000);
fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 1000 });
