import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { localUrl, type Config } from './config.js';
import { BridgeError, type Attachment, type ContactRequest, type Target } from './types.js';
import { imageFormat, insideMedia, maxImageBytes } from './media-file.js';
type Pending = { resolve: (v: any) => void; reject: (e: BridgeError) => void; timer: NodeJS.Timeout; send: boolean };
export type Friend = { userId: string; nickname: string; remark: string };
export interface Sender {
  ready: boolean;
  send(target: Target, text: string, faceId?: string): Promise<void | string>;
  sendVoice?(target: Target, file: string): Promise<string>;
  sendImage?(target: Target, file: string, text?: string, signal?: AbortSignal): Promise<string>;
  refreshIdentity?(groups: readonly string[]): Promise<void>;
  groupIdentity?(groupId: string): readonly string[];
  friendList?(): Promise<Friend[]>;
  handleRequest?(request: ContactRequest, approve: boolean): Promise<void>;
  publishQzone?(text: string): Promise<string>;
  attachment?(item: Attachment): Promise<{ file?: string; url?: string; file_name?: string; file_size?: string }>;
}
export class OneBot implements Sender {
  ready = false;
  private socket?: WebSocket;
  private pending = new Map<string, Pending>();
  private reconnect?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private stopped = false;
  private pong = true;
  private failures = 0;
  private nickname = '';
  private cards = new Map<string, string>();
  private identityEpoch = 0;
  constructor(private config: Config['onebot'], private onEvent: (e: unknown) => void, private onState: (ready: boolean, reason: string) => void, private groups: readonly string[] = [], private identityWarning: (code: string) => void = () => {}) { localUrl(config.url); }
  groupIdentity(groupId: string): readonly string[] {
    return this.groups.includes(groupId) ? [this.nickname, this.cards.get(groupId) ?? ''].filter(Boolean) : [];
  }
  async refreshIdentity(groups: readonly string[] = this.groups, loginInfo?: { user_id?: unknown; nickname?: unknown }) {
    this.groups = [...groups]; this.nickname = ''; this.cards.clear();
    const epoch = ++this.identityEpoch, socket = this.socket;
    const current = () => !this.stopped && epoch === this.identityEpoch && socket === this.socket && socket?.readyState === WebSocket.OPEN;
    if (!current()) return;
    try {
      const info = loginInfo ?? await this.rpc('get_login_info', {});
      if (!current()) return;
      if (String(info?.user_id) !== this.config.selfId) {
        this.ready = false; socket!.terminate(); throw new BridgeError('QQ_ACCOUNT_MISMATCH', 'CONNECTION');
      }
      if (typeof info.nickname === 'string' && info.nickname.trim()) this.nickname = info.nickname;
      else this.identityWarning('IDENTITY_NICKNAME_UNAVAILABLE');
      for (const group of this.groups) {
        try {
          const member = await this.rpc('get_group_member_info', { group_id: group, user_id: this.config.selfId, no_cache: true });
          if (!current()) return;
          if (String(member?.user_id) !== this.config.selfId || String(member?.group_id) !== group || typeof member.card !== 'string') throw new BridgeError('IDENTITY_GROUP_INVALID');
          if (member.card.trim()) this.cards.set(group, member.card);
        } catch {
          if (!current()) return;
          this.identityWarning('IDENTITY_GROUP_UNAVAILABLE');
        }
      }
    } catch (e) {
      if (e instanceof BridgeError && e.code === 'QQ_ACCOUNT_MISMATCH') throw e;
      if (current()) this.identityWarning('IDENTITY_REFRESH_FAILED');
    }
  }
  start() { this.stopped = false; this.connect(); }
  close() {
    this.stopped = true; clearTimeout(this.reconnect); clearInterval(this.heartbeat);
    this.socket?.terminate(); this.disconnect('STOPPED');
  }
  private disconnect(reason: string) {
    this.identityEpoch++; this.nickname = ''; this.cards.clear();
    this.ready = false; this.onState(false, reason);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new BridgeError(p.send ? 'QQ_SEND_UNCERTAIN' : 'QQ_DISCONNECTED', p.send ? 'QQ_SEND_FAILED' : 'CONNECTION', p.send)); }
    this.pending.clear();
  }
  private connect() {
    if (this.stopped) return;
    const socket = new WebSocket(this.config.url, { headers: { Authorization: `Bearer ${this.config.accessToken}` }, followRedirects: false, handshakeTimeout: this.config.timeoutMs, maxPayload: 262144 });
    this.socket = socket; this.pong = true;
    socket.on('pong', () => { this.pong = true; });
    socket.on('error', () => {}); // Error objects may contain tokens/URLs; log only controlled codes.
    socket.on('open', async () => {
      try {
        const info = await this.rpc('get_login_info', {});
        if (String(info?.user_id) !== this.config.selfId) throw new BridgeError('QQ_ACCOUNT_MISMATCH', 'CONNECTION');
        const status = await this.rpc('get_status', {});
        if (status?.online !== true || status?.good === false) throw new BridgeError('QQ_NOT_ONLINE', 'CONNECTION');
        await this.refreshIdentity(this.groups, info);
        if (this.stopped || socket !== this.socket || socket.readyState !== WebSocket.OPEN) return;
        this.ready = true; this.failures = 0; this.onState(true, 'CONNECTED');
        this.heartbeat = setInterval(() => {
          if (!this.pong) { socket.terminate(); return; }
          this.pong = false; socket.ping();
          void this.rpc('get_status', {}).then(s => { if (s?.online !== true || s?.good === false) socket.terminate(); }).catch(() => socket.terminate());
        }, 15000);
      } catch (e) { this.onState(false, e instanceof BridgeError ? e.code : 'QQ_HANDSHAKE_FAILED'); socket.terminate(); }
    });
    socket.on('message', raw => {
      let message: any; try { message = JSON.parse(raw.toString()); } catch { socket.terminate(); return; }
      if (typeof message?.echo === 'string') {
        const p = this.pending.get(message.echo); if (!p) return;
        this.pending.delete(message.echo); clearTimeout(p.timer);
        if (message.status === 'ok' && message.retcode === 0) p.resolve(message.data);
        else p.reject(new BridgeError(p.send ? 'QQ_SEND_REJECTED' : 'QQ_API_REJECTED', p.send ? 'QQ_SEND_FAILED' : 'CONNECTION'));
      } else if (this.ready) {
        if (message?.post_type === 'meta_event' && message?.meta_event_type === 'heartbeat' && message.status?.online === false) socket.terminate();
        else this.onEvent(message);
      }
    });
    socket.on('close', () => {
      clearInterval(this.heartbeat); this.disconnect('DISCONNECTED');
      if (!this.stopped) this.reconnect = setTimeout(() => this.connect(), Math.min(1000 * 2 ** this.failures++, 15000));
    });
  }
  private rpc(action: string, params: object, send = false, timeoutMs = this.config.timeoutMs): Promise<any> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new BridgeError('QQ_NOT_CONNECTED', send ? 'QQ_SEND_FAILED' : 'CONNECTION'));
    const echo = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new BridgeError(send ? 'QQ_SEND_UNCERTAIN' : 'QQ_API_TIMEOUT', send ? 'QQ_SEND_FAILED' : 'CONNECTION', send)); }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer, send });
      socket.send(JSON.stringify({ action, params, echo }), error => {
        if (error) { const p = this.pending.get(echo); if (!p) return; this.pending.delete(echo); clearTimeout(timer); reject(new BridgeError(send ? 'QQ_SEND_UNCERTAIN' : 'QQ_WRITE_FAILED', send ? 'QQ_SEND_FAILED' : 'CONNECTION', send)); }
      });
    });
  }
  async send(target: Target, text: string, faceId?: string) {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'QQ_SEND_FAILED');
    if (faceId !== undefined && (!/^\d+$/.test(faceId) || Number(faceId) > 280)) throw new BridgeError('INVALID_CLASSIC_FACE', 'CONFIG');
    const result = await this.rpc(target.kind === 'private' ? 'send_private_msg' : 'send_group_msg', {
      [target.kind === 'private' ? 'user_id' : 'group_id']: target.id,
      message: [{ type: 'text', data: { text } }, ...(faceId === undefined ? [] : [{ type: 'face', data: { id: faceId } }])]
    }, true);
    if (!(typeof result?.message_id === 'number' || typeof result?.message_id === 'string')) throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true);
    return String(result.message_id);
  }
  async sendVoice(target: Target, file: string) {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'QQ_SEND_FAILED');
    let resolved: string;
    try {
      if (typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.wav') throw Error();
      resolved = fs.realpathSync(file);
      const stat = fs.statSync(resolved);
      if (!stat.isFile() || stat.size <= 44 || stat.size > 10 * 1024 * 1024) throw Error();
    } catch { throw new BridgeError('INVALID_VOICE_FILE', 'CONFIG'); }
    const result = await this.rpc(target.kind === 'private' ? 'send_private_msg' : 'send_group_msg', {
      [target.kind === 'private' ? 'user_id' : 'group_id']: target.id,
      message: [{ type: 'record', data: { file: pathToFileURL(resolved).href } }]
    }, true, Math.max(this.config.timeoutMs, 60000));
    if (!(typeof result?.message_id === 'number' && Number.isSafeInteger(result.message_id) || typeof result?.message_id === 'string' && /^-?\d+$/.test(result.message_id))) throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true);
    return String(result.message_id);
  }
  async sendImage(target: Target, file: string, text = '', signal?: AbortSignal) {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'QQ_SEND_FAILED');
    let resolved: string;
    try {
      if (!path.isAbsolute(file) || typeof text !== 'string' || text.length > 20000) throw Error();
      resolved = insideMedia(file, path.resolve('state/media'));
      if (fs.statSync(resolved).size > maxImageBytes) throw Error();
      await imageFormat(fs.readFileSync(resolved));
    } catch { throw new BridgeError('INVALID_IMAGE_FILE', 'CONFIG'); }
    if (signal?.aborted) throw new BridgeError('PAUSED');
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'QQ_SEND_FAILED');
    const result = await this.rpc(target.kind === 'private' ? 'send_private_msg' : 'send_group_msg', {
      [target.kind === 'private' ? 'user_id' : 'group_id']: target.id,
      message: [...(text ? [{ type: 'text', data: { text } }] : []), { type: 'image', data: { file: pathToFileURL(resolved).href } }]
    }, true, Math.max(this.config.timeoutMs, 60000));
    if (!(typeof result?.message_id === 'number' && Number.isSafeInteger(result.message_id) || typeof result?.message_id === 'string' && /^-?\d+$/.test(result.message_id))) throw new BridgeError('QQ_SEND_UNCERTAIN', 'QQ_SEND_FAILED', true);
    return String(result.message_id);
  }
  async friendList(): Promise<Friend[]> {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'CONNECTION');
    const data = await this.rpc('get_friend_list', {});
    if (!Array.isArray(data) || data.some(f => !f || !(typeof f.user_id === 'string' && /^[1-9]\d*$/.test(f.user_id) || typeof f.user_id === 'number' && Number.isSafeInteger(f.user_id) && f.user_id > 0) || typeof f.nickname !== 'string' || typeof f.remark !== 'string')) throw new BridgeError('QQ_FRIEND_LIST_INVALID', 'READ_FAILED');
    return data.filter(f => String(f.user_id) !== this.config.selfId).map(f => ({ userId: String(f.user_id), nickname: f.nickname, remark: f.remark }));
  }
  async attachment(item: Attachment) {
    if (!/^[a-f0-9]{32}(?:\.[a-z0-9]{1,10})?$/i.test(item.fileId)) throw new BridgeError('INVALID_ATTACHMENT_ID', 'READ_FAILED');
    return this.rpc('get_file', { file_id: item.fileId });
  }
  async handleRequest(request: ContactRequest, approve: boolean) {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'CONNECTION');
    if (typeof approve !== 'boolean' || !request.flag || !['friend', 'group'].includes(request.kind) || request.kind === 'group' && !['add', 'invite'].includes(request.subType ?? '')) throw new BridgeError('INVALID_CONTACT_REQUEST', 'CONFIG');
    await this.rpc(request.kind === 'friend' ? 'set_friend_add_request' : 'set_group_add_request', {
      flag: request.flag, approve, ...(request.kind === 'group' ? { sub_type: request.subType } : {})
    }, true);
  }
  async publishQzone(text: string) {
    if (!this.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'CONNECTION');
    if (typeof text !== 'string' || !text.trim() || text.length > 300) throw new BridgeError('INVALID_QZONE_TEXT', 'CONFIG');
    const result = await this.rpc('send_qzone_msg', { content: text, ugc_right: 4 }, true, 60000);
    if (typeof result?.tid !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(result.tid)) throw new BridgeError('QZONE_PUBLISH_UNCERTAIN', 'QQ_SEND_FAILED', true);
    return result.tid;
  }
}
