import fs from 'node:fs';
import path from 'node:path';
import { readOneBotToken, validateToken } from './secrets.js';
import { BridgeError } from './types.js';
export type Config = {
  provider?: 'gemini' | 'antigravity';
  memory?: { enabled: boolean };
  qzone?: { enabled: boolean; proxyUrl?: string };
  antigravity?: { executable: string; timeoutMs: number; model: string; proxyUrl?: string; tlsCompatibility?: boolean };
  onebot: { url: string; accessToken: string; selfId: string; timeoutMs: number };
  gemini: { directory: string; timeoutMs: number };
  friends: string[]; groups: string[]; replyStyle: string; realSend: boolean;
  replyAll?: boolean;
  groupAliases?: string[];
  friendAdminId?: string;
  conversation?: { enabled: boolean; groupReplyProbability?: number; personas?: Record<string, string>; redact?: string[]; faceProbability?: number; peakFaceProbability?: number };
  attachments?: { enabled: boolean; localRoots: string[] };
  voice?: { enabled: boolean; voice?: string };
  media?: { enabled: boolean; online: boolean };
  maxQueue: number; maxMessageChars: number; maxReplyChars: number;
};
export function localUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new BridgeError('INVALID_ONEBOT_URL', 'CONFIG'); }
  if (url.protocol !== 'ws:' || !['127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash)
    throw new BridgeError('ONEBOT_MUST_USE_LITERAL_LOOPBACK_WS', 'CONFIG');
  return url;
}
export function readConfig(file: string): Config {
  let c: Config;
  try { c = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new BridgeError('CONFIG_READ_FAILED', 'CONFIG'); }
  c.onebot = { ...c.onebot, accessToken: readOneBotToken(path.dirname(path.resolve(file))) };
  return validateConfig(c);
}
export function validateConfig(c: Config): Config {
  localUrl(c.onebot?.url);
  if (c.replyAll !== undefined && typeof c.replyAll !== 'boolean') throw new BridgeError('INVALID_REPLY_ALL', 'CONFIG');
  validateToken(c.onebot.accessToken);
  if (!/^\d+$/.test(c.onebot.selfId)) throw new BridgeError('SELF_ID_REQUIRED', 'CONFIG');
  for (const list of [c.friends, c.groups]) if (!Array.isArray(list) || list.some(x => typeof x !== 'string' || !/^[1-9]\d*$/.test(x))) throw new BridgeError('INVALID_ALLOWLIST', 'CONFIG');
  if (c.groupAliases !== undefined && (!Array.isArray(c.groupAliases) || c.groupAliases.some(x => typeof x !== 'string' || !x.normalize('NFKC').trim()))) throw new BridgeError('INVALID_GROUP_ALIASES', 'CONFIG');
  if (c.conversation !== undefined) {
    const p = c.conversation;
    if (!p || typeof p.enabled !== 'boolean') throw new BridgeError('INVALID_CONVERSATION_CONFIG', 'CONFIG');
    for (const value of [p.groupReplyProbability, p.faceProbability, p.peakFaceProbability])
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1)) throw new BridgeError('INVALID_CONVERSATION_PROBABILITY', 'CONFIG');
    if (p.personas !== undefined && (!p.personas || typeof p.personas !== 'object' || Array.isArray(p.personas) || Object.entries(p.personas).some(([key, note]) => !/^(private|group):[1-9]\d*$/.test(key) || typeof note !== 'string' || note.length > 2000))) throw new BridgeError('INVALID_SESSION_PERSONAS', 'CONFIG');
    if (p.redact !== undefined && (!Array.isArray(p.redact) || p.redact.length > 100 || p.redact.some(x => typeof x !== 'string' || !x.trim() || x.length > 1000))) throw new BridgeError('INVALID_REDACTION', 'CONFIG');
  }
  if (c.attachments !== undefined && (!c.attachments || typeof c.attachments.enabled !== 'boolean' || !Array.isArray(c.attachments.localRoots) || c.attachments.localRoots.some(x => typeof x !== 'string' || !x.trim()))) throw new BridgeError('INVALID_ATTACHMENTS_CONFIG', 'CONFIG');
  if (c.voice !== undefined && (!c.voice || typeof c.voice.enabled !== 'boolean' || c.voice.voice !== undefined && (typeof c.voice.voice !== 'string' || !/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z]+Neural$/.test(c.voice.voice)))) throw new BridgeError('INVALID_VOICE_CONFIG', 'CONFIG');
  if (c.media !== undefined && (!c.media || typeof c.media.enabled !== 'boolean' || typeof c.media.online !== 'boolean' || Object.keys(c.media).some(k => !['enabled', 'online'].includes(k)) || c.media.enabled && c.media.online && c.provider !== 'antigravity')) throw new BridgeError('INVALID_MEDIA_CONFIG', 'CONFIG');
  if (c.provider !== undefined && !['gemini', 'antigravity'].includes(c.provider)) throw new BridgeError('INVALID_PROVIDER', 'CONFIG');
  if (c.friendAdminId !== undefined && (typeof c.friendAdminId !== 'string' || c.friendAdminId !== '' && (!/^[1-9]\d*$/.test(c.friendAdminId) || c.friendAdminId === c.onebot.selfId || c.provider !== 'antigravity'))) throw new BridgeError('INVALID_FRIEND_ADMIN', 'CONFIG');
  if (c.memory !== undefined && (typeof c.memory?.enabled !== 'boolean' || c.memory.enabled && c.provider !== 'antigravity')) throw new BridgeError('INVALID_MEMORY_CONFIG', 'CONFIG');
  if (c.qzone !== undefined && (!c.qzone || typeof c.qzone.enabled !== 'boolean' || c.qzone.enabled && c.provider !== 'antigravity')) throw new BridgeError('INVALID_QZONE_CONFIG', 'CONFIG');
  if (c.qzone?.proxyUrl !== undefined) {
    let proxy: URL;
    try { proxy = new URL(c.qzone.proxyUrl); } catch { throw new BridgeError('INVALID_QZONE_PROXY', 'CONFIG'); }
    if (proxy.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(proxy.hostname) || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new BridgeError('INVALID_QZONE_PROXY', 'CONFIG');
  }
  if (c.provider === 'antigravity') {
    const a = c.antigravity;
    if (!a || typeof a.executable !== 'string' || !a.executable.trim() || /[\r\n\0]/.test(a.executable) || process.platform === 'win32' && !/\.exe$/i.test(a.executable) || typeof a.model !== 'string' || !/^[a-zA-Z0-9._-]*$/.test(a.model)) throw new BridgeError('INVALID_ANTIGRAVITY_CONFIG', 'CONFIG');
    if (!Number.isSafeInteger(a.timeoutMs) || a.timeoutMs < 1000 || a.timeoutMs > 300000) throw new BridgeError('INVALID_ANTIGRAVITY_TIMEOUT', 'CONFIG');
    if (a.tlsCompatibility !== undefined && typeof a.tlsCompatibility !== 'boolean') throw new BridgeError('INVALID_ANTIGRAVITY_TLS_COMPATIBILITY', 'CONFIG');
    if (a.proxyUrl !== undefined) {
      let proxy: URL;
      try { proxy = new URL(a.proxyUrl); } catch { throw new BridgeError('INVALID_ANTIGRAVITY_PROXY', 'CONFIG'); }
      if (proxy.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(proxy.hostname) || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw new BridgeError('INVALID_ANTIGRAVITY_PROXY', 'CONFIG');
    }
  }
  if (c.provider !== 'antigravity' && (!c.gemini?.directory || typeof c.gemini.directory !== 'string')) throw new BridgeError('GEMINI_DIRECTORY_REQUIRED', 'CONFIG');
  const generationTimeout = c.provider === 'antigravity' ? c.antigravity!.timeoutMs : c.gemini.timeoutMs;
  for (const value of [c.onebot.timeoutMs, generationTimeout, c.maxQueue, c.maxMessageChars, c.maxReplyChars])
    if (!Number.isSafeInteger(value) || value < 1) throw new BridgeError('INVALID_LIMIT', 'CONFIG');
  if (generationTimeout > 300000 || c.onebot.timeoutMs > 60000 || c.maxQueue > 500 || c.maxMessageChars > 20000 || c.maxReplyChars > 20000)
    throw new BridgeError('LIMIT_TOO_LARGE', 'CONFIG');
  if (c.memory?.enabled && c.maxMessageChars > 12000) throw new BridgeError('MEMORY_MESSAGE_LIMIT_MAX_12000','CONFIG');
  if (typeof c.realSend !== 'boolean' || typeof c.replyStyle !== 'string' || c.replyStyle.length > 2000) throw new BridgeError('INVALID_REPLY_CONFIG', 'CONFIG');
  return c;
}
