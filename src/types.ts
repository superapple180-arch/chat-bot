export type View = {
  url: string; mode: string; busy: boolean; hasDraft: boolean; fingerprint: string;
  userCount: number; responseCount: number; minimized: boolean;
  text: string; marker: string; submitted: boolean;
};
export type Cursor = Pick<View, 'url' | 'mode' | 'fingerprint'>;
export type Session = { url: string; mode: string };
export type Attachment = { kind: 'image' | 'video' | 'file'; fileId: string; name: string };
export type Target = { kind: 'private' | 'group'; id: string; key: string; text: string; eventKey: string; userId?: string; messageId?: string; at?: number; mentioned?: boolean; adminCommand?: boolean; approvalCommand?: boolean; managedFriend?: boolean; senderName?: string; replyTo?: string; atUsers?: string[]; conversationContext?: string; attachments?: Attachment[] };
export class BridgeError extends Error {
  constructor(public code: string, public category = 'GENERATION_FAILED', public uncertain = false) { super(code); }
}
export type ContactRequest = { selfId: string; kind: 'friend' | 'group'; flag: string; userId: string; groupId?: string; subType?: 'add' | 'invite'; comment: string; at: string; status: 'pending' | 'processing' | 'approved' | 'rejected' | 'uncertain' | 'failed' };
export type QzonePost = { at: string; status: 'generating' | 'sending' | 'sent' | 'dry-run' | 'failed' | 'uncertain'; text?: string; tid?: string; code?: string };
export interface Desktop {
  call(input: Record<string, unknown>, signal?: AbortSignal): Promise<View>;
}
export interface ReplyGenerator {
  ready(adopt?: boolean): Promise<unknown>;
  verify(signal?: AbortSignal): Promise<void>;
  generate(key: string, text: string, style: string, signal?: AbortSignal, memory?: string): Promise<string>;
}
