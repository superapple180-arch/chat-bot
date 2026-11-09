import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BridgeError } from './types.js';

export function acquireLock(file = 'state/bridge.lock') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const guard = new DatabaseSync(file + '.sqlite');
  let owned = false, released = false;
  try {
    try { guard.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;'); }
    catch (e: any) {
      if (e.errcode === 5) throw new BridgeError('BRIDGE_ALREADY_RUNNING', 'STARTUP');
      throw e;
    }
    if (fs.existsSync(file)) {
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid < 1) throw new BridgeError('INVALID_LOCK_FILE', 'STARTUP');
      let alive = true;
      try { process.kill(pid, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; }
      if (alive) throw new BridgeError('BRIDGE_ALREADY_RUNNING', 'STARTUP');
      fs.rmSync(file);
    }
    fs.writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 }); owned = true;
  } catch (e) { guard.close(); throw e; }
  const release = () => {
    if (released) return; released = true;
    try { if (owned && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === String(process.pid)) fs.rmSync(file); }
    finally { guard.close(); process.removeListener('exit', release); }
  };
  process.once('exit', release);
  return release;
}
