import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';
import { BridgeError } from './types.js';
import { acquireLock } from './lock.js';

export function validateToken(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length < 16 || value.includes('REPLACE') || /[\r\n\0]/.test(value))
    throw new BridgeError('ACCESS_TOKEN_REQUIRED_MIN_16', 'CONFIG');
}
function environmentFile(root: string) {
  try { return parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8')); }
  catch (error: any) { if (error.code === 'ENOENT') return {}; throw new BridgeError('ENV_READ_FAILED', 'CONFIG'); }
}
export function readOneBotToken(root: string): string {
  const token = configuredOneBotToken(root);
  validateToken(token); return token;
}
export function configuredOneBotToken(root: string): string | undefined {
  const token = process.env.ONEBOT_ACCESS_TOKEN ?? environmentFile(root).ONEBOT_ACCESS_TOKEN;
  if (token !== undefined) validateToken(token);
  return token;
}
export function atomicPrivateWrite(file: string, text: string) {
  const temporary = file + '.' + randomUUID() + '.tmp';
  try { fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' }); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
}
export function saveOneBotToken(root: string, token: string) {
  validateToken(token);
  if (process.env.ONEBOT_ACCESS_TOKEN !== undefined) {
    if (process.env.ONEBOT_ACCESS_TOKEN !== token) throw new BridgeError('TOKEN_MANAGED_BY_ENVIRONMENT', 'CONFIG');
    return;
  }
  const values = { ...environmentFile(root), ONEBOT_ACCESS_TOKEN: token };
  const text = Object.entries(values).map(([key, value]) => {
    const encoded = [`"${value}"`, `'${value}'`, value].find(candidate => parseEnv(`${key}=${candidate}\n`)[key] === value);
    if (encoded === undefined) throw new BridgeError('ENV_VALUE_REQUIRES_PROCESS_ENVIRONMENT', 'CONFIG');
    return `${key}=${encoded}\n`;
  }).join('');
  atomicPrivateWrite(path.join(root, '.env'), text);
  if (readOneBotToken(root) !== token) throw new BridgeError('ENV_TOKEN_VERIFICATION_FAILED', 'CONFIG');
}
export function withoutToken<T extends { onebot: { accessToken?: string } }>(config: T): T {
  return { ...config, onebot: { ...config.onebot, accessToken: '' } };
}
// Explicit migration only. Reading a config never falls back to its old token.
export function migrateLegacyConfig(file: string) {
  const body = fs.readFileSync(file, 'utf8'), config = JSON.parse(body), token = config.onebot?.accessToken;
  if (!token) return false;
  validateToken(token);
  const root = path.dirname(path.resolve(file));
  const unlock = acquireLock(path.join(root, 'state/bridge.lock'));
  try {
    const configured = process.env.ONEBOT_ACCESS_TOKEN ?? environmentFile(root).ONEBOT_ACCESS_TOKEN;
    if (configured !== undefined && configured !== token) throw new BridgeError('LEGACY_TOKEN_ENVIRONMENT_MISMATCH', 'CONFIG');
    saveOneBotToken(root, token);
    if (readOneBotToken(root) !== token || fs.readFileSync(file, 'utf8') !== body) throw new BridgeError('CONFIG_CHANGED_EXTERNALLY', 'CONFIG');
    const backup = path.join(root, 'state/config.local.backup.json');
    if (fs.existsSync(backup)) atomicPrivateWrite(backup, JSON.stringify(withoutToken(JSON.parse(fs.readFileSync(backup, 'utf8'))), null, 2) + '\n');
    atomicPrivateWrite(file, JSON.stringify(withoutToken(config), null, 2) + '\n');
    return true;
  } finally { unlock(); }
}
