import path from 'node:path';
import { spawnSync } from 'node:child_process';
const result = spawnSync(process.execPath, ['node_modules/electron/install.js'], { stdio: 'inherit', env: { ...process.env, electron_config_cache: path.resolve('.cache/electron') }, windowsHide: true });
if (result.status !== 0) process.exit(result.status ?? 1);
