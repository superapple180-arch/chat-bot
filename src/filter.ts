import { createHash } from 'node:crypto';
import type { Config } from './config.js';
import type { Attachment, Target } from './types.js';
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
function matchesIdentity(text: string, names: readonly string[]): boolean {
  const normalized = text.normalize('NFKC').toLowerCase();
  return names.some(value => {
    const name = value.normalize('NFKC').trim().toLowerCase();
    if (!name) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundary = /^\d+$/.test(name) ? '[0-9]' : /^[a-z0-9_]+$/.test(name) ? '[a-z0-9_]' : undefined;
    return boundary ? new RegExp(`(?<!${boundary})${escaped}(?!${boundary})`).test(normalized) : normalized.includes(name);
  });
}
export function filterEvent(e: any, c: Config, capture = false, identityNames: readonly string[] = []): Target | undefined {
  if (!e || e.post_type !== 'message' || String(e.self_id) !== c.onebot.selfId || String(e.user_id) === c.onebot.selfId) return;
  if (!(typeof e.message_id === 'number' && Number.isSafeInteger(e.message_id) || typeof e.message_id === 'string' && /^-?\d+$/.test(e.message_id))) return;
  const user = String(e.user_id); if (!/^[1-9]\d*$/.test(user)) return;
  const kind = e.message_type; let id: string;
  if (kind === 'private' && e.sub_type === 'friend' && (c.replyAll || c.friends.includes(user))) id = user;
  else if (kind === 'group' && /^[1-9]\d*$/.test(String(e.group_id)) && (c.replyAll || c.groups.includes(String(e.group_id)))) id = String(e.group_id);
  else return;
  // Require the standard array representation. Never interpret CQ codes as commands.
  if (!Array.isArray(e.message) || e.message.length > 100) return;
  let mentioned = false, replyTo: string | undefined; const text: string[] = [], plainText: string[] = [], atUsers: string[] = [], attachments: Attachment[] = [];
  for (const segment of e.message) {
    if (segment?.type === 'text' && typeof segment.data?.text === 'string') { text.push(segment.data.text); plainText.push(segment.data.text); }
    else if (segment?.type === 'at' && kind === 'group' && /^(?:all|[1-9]\d*)$/.test(String(segment.data?.qq))) {
      plainText.push('\0'); // A rendered @ target is context, never an identity keyword.
      atUsers.push(String(segment.data.qq));
      if (String(segment.data.qq) === c.onebot.selfId) mentioned = true;
      else text.push(` @${segment.data.qq} `);
    }
    else if (c.conversation?.enabled && segment?.type === 'reply' && replyTo === undefined && /^-?\d{1,20}$/.test(String(segment.data?.id))) {
      replyTo = String(segment.data.id); plainText.push('\0');
    }
    else if (c.attachments?.enabled && ['image', 'video', 'file'].includes(segment?.type)) {
      const fileId = segment.data?.file_id ?? segment.data?.file;
      if (typeof fileId !== 'string' || !/^[a-f0-9]{32}(?:\.[a-z0-9]{1,10})?$/i.test(fileId) || attachments.length >= 3) return;
      attachments.push({ kind: segment.type, fileId, name: typeof segment.data?.name === 'string' ? segment.data.name.slice(0, 150) : segment.type === 'image' ? 'image' : segment.type === 'video' ? 'video.mp4' : 'file' });
      plainText.push('\0');
    }
    else return; // Other media and tool messages are outside the text bridge.
  }
  const body = text.join('').trim() || (attachments.length ? '[收到附件，未附文字]' : '');
  if (!body || body.length > c.maxMessageChars) return;
  if (kind === 'group' && !c.replyAll && !mentioned && !capture && !matchesIdentity(plainText.join(''), [c.onebot.selfId, ...(c.groupAliases ?? []), ...identityNames])) return;
  const key = digest(`${c.onebot.selfId}:${kind}:${id}`);
  const name = e.sender?.card || e.sender?.nickname;
  return { kind, id, key, text: body, eventKey: digest(`${c.onebot.selfId}:${kind}:${id}:${e.message_id}`), userId: user, messageId: String(e.message_id), at: Date.now(), mentioned,
    ...(c.conversation?.enabled ? { replyTo, atUsers, senderName: typeof name === 'string' ? name.slice(0, 80) : user } : {}), ...(attachments.length ? { attachments } : {}) };
}
