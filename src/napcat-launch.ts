import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { codePath, componentPath } from './paths.js';
import type { Config } from './config.js';

export function napcatLaunch(root: string, config: Config) {
  const desktop = Boolean(process.env.QQ_BOT_COMPONENT_ROOT);
  const directory = desktop ? componentPath('napcat') : path.join(root, 'vendor/NapCat-Node-4.18.41');
  const env: NodeJS.ProcessEnv = { ...process.env, ONEBOT_ACCESS_TOKEN: undefined, QQ_BOT_CONFIG_FILE: path.join(root, 'config.local.json') };
  if (config.qzone?.enabled && config.qzone.proxyUrl) env.NODE_OPTIONS = [env.NODE_OPTIONS, `--require="${codePath('scripts/napcat-qzone-proxy.cjs').replaceAll('\\', '/')}"`].filter(Boolean).join(' ');
  if (process.platform === 'darwin' && desktop) {
    return { command: '/Applications/QQ.app/Contents/MacOS/QQ', args: ['--no-sandbox', '-q', config.onebot.selfId], cwd: os.homedir(), env };
  }
  if (process.platform === 'linux' && desktop) {
    return { command: path.join(directory, 'NapCat.AppImage'), args: ['--appimage-extract-and-run', '-q', config.onebot.selfId], cwd: directory, env };
  }
  return { command: path.join(directory, 'node.exe'), args: ['index.js', '-q', config.onebot.selfId], cwd: directory, env };
}

export function requireNapcat(command: string) { if (!fs.existsSync(command)) throw Error('NAPCAT_NOT_INSTALLED'); }
