import type { ReplyChoice, VoiceClip } from './voice.js';
import { BridgeError } from './types.js';

export type MediaChoice = { kind: 'image' | 'sticker'; text: string; mediaId?: string; query?: string };
export type Choice = ReplyChoice | MediaChoice;
function parseData(raw: string): any {
  const value = raw.trim().replace(/^```(?:json)?\s*(?=\{)([\s\S]*?)\s*```$/i, '$1');
  if (!value.startsWith('{')) return;
  try { return JSON.parse(value); } catch { throw new BridgeError('INVALID_REPLY_CHOICE', 'READ_FAILED'); }
}
function voiceChoice(raw: string, clips: VoiceClip[], data: any): ReplyChoice {
  if (data === undefined) return { kind: 'text', text: raw };
  if (data && ['text', 'tts'].includes(data.kind) && typeof data.text === 'string' && data.text.trim() && Object.keys(data).every(k => ['kind', 'text'].includes(k))) return { kind: data.kind, text: data.text };
  if (data?.kind === 'clip' && typeof data.clipId === 'string' && Object.keys(data).every(k => ['kind', 'clipId'].includes(k))) {
    const clip = clips.find(c => c.id === data.clipId);
    if (clip) return { kind: 'clip', text: clip.text, clip };
  }
  throw new BridgeError('INVALID_REPLY_CHOICE', 'READ_FAILED');
}
export function parseReply(raw: string, clips: VoiceClip[]): ReplyChoice {
  return voiceChoice(raw, clips, parseData(raw));
}
export function parseChoice(raw: string, clips: VoiceClip[], voice: boolean, media: boolean): Choice {
  const data = parseData(raw);
  if (media && ['image', 'sticker'].includes(data?.kind)) {
    if (typeof data.text !== 'string' || data.text.length > 20000 || Object.keys(data).some(k => !['kind', 'text', 'mediaId', 'query'].includes(k)) ||
      Boolean(data.mediaId) === Boolean(data.query) || data.mediaId !== undefined && (typeof data.mediaId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(data.mediaId)) ||
      data.query !== undefined && (typeof data.query !== 'string' || !data.query.trim() || data.query.length > 80 || /[\r\n/:\\]/.test(data.query))) throw new BridgeError('INVALID_REPLY_CHOICE', 'READ_FAILED');
    return data;
  }
  const choice = voiceChoice(raw, clips, data);
  if (!voice && choice.kind !== 'text') throw new BridgeError('INVALID_REPLY_CHOICE', 'READ_FAILED');
  return choice;
}
