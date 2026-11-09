import fs from 'node:fs';
import path from 'node:path';
import { beijingDate } from './qzone.js';

export function dailySchedule(file: string, now: Date, enabled: boolean, ready: boolean, trigger: () => void) {
  if (!enabled) return;
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
  if (time !== '18:00') return;
  const date = beijingDate(now);
  if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, 'utf8')).date === date) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify({ date, status: ready ? 'requested' : 'skipped' }), { mode: 0o600 });
  fs.renameSync(file + '.tmp', file);
  if (ready) trigger();
}
