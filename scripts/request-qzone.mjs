import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from '../dist/config.js';
import { beijingDate } from '../dist/qzone.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
try {
  if (process.argv.length > 3 || process.argv[2] !== undefined && process.argv[2] !== '--status') throw Error('INVALID_ARGUMENT');
  const c = readConfig('config.local.json'), date = beijingDate();
  if (!c.qzone?.enabled) throw Error('QZONE_NOT_ENABLED');
  const state = JSON.parse(fs.readFileSync('state/antigravity.json', 'utf8'));
  const job = state.qzonePosts?.[`${c.realSend ? '' : 'dry-run:'}${c.onebot.selfId}:${date}`];
  if (job) console.log(JSON.stringify({ date, status: job.status, tid: job.tid, code: job.code }));
  else if (process.argv[2] === '--status') console.log(JSON.stringify({ date, status: fs.existsSync('state/qzone-request.json') ? 'queued' : 'not-requested' }));
  else {
    const temp = `state/qzone-request.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify({ selfId: c.onebot.selfId, date })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, 'state/qzone-request.json');
    console.log(JSON.stringify({ date, status: 'queued', paused: Boolean(state.pauseReason) }));
  }
} catch (error) { console.error(JSON.stringify({ status: 'error', code: error.code ?? error.message ?? 'QZONE_REQUEST_FAILED' })); process.exitCode = 1; }
