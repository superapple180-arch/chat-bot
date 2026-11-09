import { BridgeError, type ReplyGenerator, type Target } from './types.js';
import { filterEvent } from './filter.js';
import type { Config } from './config.js';
import type { Sender } from './onebot.js';
import type { State } from './state.js';
import type { MemoryService } from './memory.js';
import type { FriendAgent } from './friend-agent.js';
import { Conversation } from './conversation.js';
import { understandAttachments } from './attachments.js';
import { setTimeout as delay } from 'node:timers/promises';
import { Requests } from './requests.js';
import type { Qzone } from './qzone.js';
import type { ChatStore } from './chat.js';
import { digest } from './filter.js';
import { Voice, type PreparedVoice } from './voice.js';
import { parseChoice, type Choice } from './reply.js';
import { Media, canOfferMedia, explicitMedia, type PreparedMedia } from './media.js';
type Work = Target & { manual?: boolean; ownerCommand?: boolean };
export type Logger = (category: string, code: string) => void;
export class Bridge {
  paused = true;
  private queue: Work[] = [];
  private processing?: Promise<void>;
  private controller?: AbortController;
  private epoch = 0;
  private checking = false;
  private checkTask?: Promise<unknown>;
  private maintenance?: Promise<void>;
  private current?: Work;
  private draining = false;
  readonly conversation: Conversation;
  readonly requests: Requests;
  constructor(public config: Config, private state: State, private gemini: ReplyGenerator, private sender: Sender, private log: Logger, readonly memory?: MemoryService, private friendAgent?: FriendAgent, private qzone?: Qzone, private chat?: ChatStore, private voice = new Voice(), private media = new Media()) { this.conversation = new Conversation(state); this.requests = new Requests(state, sender, log); }
  get active() { return Boolean(this.processing || this.maintenance || this.checking); }
  get accepting() { return !this.draining; }
  get pending() { return this.queue.length; }
  get task() { const t=this.current; return t ? {kind:t.kind,target:t.id,source:t.manual?'manual':t.ownerCommand?'owner':'ai',status:this.state.event(t.eventKey)?.status} : undefined; }
  pause(reason = 'USER_PAUSED') {
    this.paused = true; this.epoch++; this.state.data.pauseReason = reason;
    this.controller?.abort();
    for (const t of this.queue.splice(0)) { this.state.record(t.eventKey, 'cancelled', reason); this.chat?.status(this.config.onebot.selfId,t.eventKey,'cancelled'); }
    this.state.save(); this.log('PAUSED', reason);
  }
  async resume(adopt = false) {
    if (this.processing || this.checking) throw new BridgeError('TASK_STILL_STOPPING');
    this.paused = true;
    this.checking = true;
    const epoch = this.epoch;
    try {
      this.checkTask = (async () => {
        await this.gemini.ready(adopt);
        await this.sender.refreshIdentity?.(this.config.groups);
      })();
      await this.checkTask;
      if (this.epoch !== epoch) throw new BridgeError('PAUSED');
      if (!this.sender.ready) throw new BridgeError('QQ_NOT_CONNECTED', 'CONNECTION');
      this.draining = false; this.paused = false; this.epoch++; this.state.data.pauseReason = ''; this.state.save(); this.log('RUNNING', this.config.realSend ? 'REAL_SEND_ENABLED' : 'DRY_RUN');
    } finally { this.checkTask = undefined; this.checking = false; }
  }
  accept(event: unknown) {
    if (this.draining) return;
    try { if (this.requests.accept(event, this.config)) this.log('REQUEST', 'PENDING_USER_APPROVAL'); }
    catch { this.pause('REQUEST_STORAGE_FAILED'); return; }
    if (this.paused || !this.sender.ready) return;
    const managed = this.requests.filter(event, this.config) ?? this.friendAgent?.filter(event, this.config);
    const captured = managed ?? filterEvent(event, this.config, true);
    if (!captured) return;
    try { if (!captured.adminCommand) this.chat?.capture(this.config.onebot.selfId,captured); }
    catch { this.pause('CHAT_DATABASE_FAILED'); return; }
    if (this.memory && !captured.adminCommand) {
      try {
        this.memory.store.capture(this.config.onebot.selfId, captured);
      } catch { this.pause('MEMORY_DATABASE_FAILED'); return; }
    }
    if (this.state.event(captured.eventKey)) return;
    this.conversation.remember(captured, this.config);
    let target = managed ?? filterEvent(event, this.config, false, captured.kind === 'group' ? this.sender.groupIdentity?.(captured.id) : undefined);
    if (!target && this.config.conversation?.enabled && captured.kind === 'group' && (captured.userId === this.config.friendAdminId || this.conversation.repliesToSelf(captured, this.config) || Math.random() < (this.config.conversation.groupReplyProbability ?? 0.4))) target = captured;
    if (!target) {
      if (this.config.conversation?.enabled) this.state.record(captured.eventKey, 'ignored', 'NO_REPLY_TRIGGER');
      return;
    }
    if (!target || this.state.event(target.eventKey)) return;
    target.conversationContext = this.conversation.context(target, this.config);
    if (this.queue.length >= this.config.maxQueue) { this.state.record(target.eventKey, 'cancelled', 'QUEUE_FULL'); this.pause('QUEUE_FULL'); return; }
    try { if (!target.adminCommand) this.chat?.put(this.config.onebot.selfId,target,'ai','','accepted'); }
    catch { this.pause('CHAT_DATABASE_FAILED'); return; }
    this.state.record(target.eventKey, 'accepted'); this.queue.push(target);
    this.kick();
  }
  private kick() {
    if (!this.processing && !this.checking && !this.paused && this.queue.length) {
      this.processing = this.drain().finally(() => { this.processing = undefined; this.kick(); });
    }
  }
  async manualSend(kind: 'private' | 'group', id: string, text: string, requestId: string) {
    if (this.draining) throw new BridgeError('SHUTDOWN');
    if (!['private','group'].includes(kind) || !/^[1-9]\d*$/.test(id) || typeof text !== 'string' || !text.trim() || text.length > this.config.maxReplyChars || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new BridgeError('INVALID_MANUAL_MESSAGE','CONFIG');
    const eventKey = digest(`${this.config.onebot.selfId}:manual:${requestId}`);
    const previous = this.state.event(eventKey); if (previous) return previous;
    if (this.paused || !this.sender.ready) throw new BridgeError('PAUSED');
    const allowed = this.chat?.hasConversation(this.config.onebot.selfId,kind,id) ||
      kind === 'private' && (await this.sender.friendList?.())?.some(f => f.userId === id);
    if (!allowed) throw new BridgeError('MANUAL_TARGET_NOT_KNOWN','CONFIG');
    if (this.state.event(eventKey)) return this.state.event(eventKey);
    if (this.paused) throw new BridgeError('PAUSED');
    if (this.queue.length >= this.config.maxQueue) throw new BridgeError('QUEUE_FULL');
    const t: Work = {kind,id,key:digest(`${this.config.onebot.selfId}:${kind}:${id}`),eventKey,text:this.conversation.sanitize(text,this.config),manual:true};
    this.chat?.put(this.config.onebot.selfId,t,'manual',t.text,'accepted');
    this.state.record(eventKey,'accepted'); this.queue.push(t); this.kick();
    return this.state.event(eventKey);
  }
  ownerDispatch(command: string, requestId: string) {
    if (this.draining) throw new BridgeError('SHUTDOWN');
    if (!this.friendAgent || typeof command !== 'string' || !command.trim() || command.length > 2000 || !/^[a-zA-Z0-9-]{16,80}$/.test(requestId)) throw new BridgeError('INVALID_OWNER_COMMAND','CONFIG');
    const eventKey = digest(`${this.config.onebot.selfId}:owner:${requestId}`);
    if (this.state.event(eventKey)) return this.state.event(eventKey);
    if (this.paused || !this.sender.ready) throw new BridgeError('PAUSED');
    if (this.queue.length >= this.config.maxQueue) throw new BridgeError('QUEUE_FULL');
    this.state.record(eventKey,'accepted');
    this.queue.push({kind:'private',id:this.config.onebot.selfId,key:'owner:'+eventKey,eventKey,text:command,ownerCommand:true,adminCommand:true});
    this.kick(); return this.state.event(eventKey);
  }
  private async drain() {
    while (!this.paused && this.queue.length) {
      const target = this.queue.shift()!; const epoch = this.epoch;
      this.current=target;
      const sessionKey = this.config.realSend ? target.key : 'dry-run:' + target.key;
      this.controller = new AbortController();
      let prepared: PreparedVoice | undefined;
      let picture: PreparedMedia | undefined;
      try {
        if (target.manual) {
          await this.waitForSend(target);
          if (this.config.realSend) {
            this.state.record(target.eventKey,'sending'); this.chat?.status(this.config.onebot.selfId,target.eventKey,'sending');
            await this.send(target,target.text);
            this.state.record(target.eventKey,'sent'); this.chat?.status(this.config.onebot.selfId,target.eventKey,'sent');
          } else { this.state.record(target.eventKey,'dry-run'); this.chat?.status(this.config.onebot.selfId,target.eventKey,'dry-run'); }
          this.log('MANUAL',this.config.realSend ? 'SENT' : 'DRY_RUN_NOT_SENT'); continue;
        }
        if (target.ownerCommand) {
          const result = await this.friendAgent!.executeOwner(target.text,target.eventKey,this.config,this.controller.signal,(t,text)=>this.send(t,text));
          this.chat?.put(this.config.onebot.selfId,target,'owner-result',result,'completed');
          this.state.record(target.eventKey,'sent'); this.log('OWNER','DISPATCH_COMPLETE'); continue;
        }
        if (this.config.replyAll) await this.waitForSend(target);
        else if (!this.conversation.canSend(target, this.config)) { this.state.record(target.eventKey, 'cancelled', 'SEND_RATE_LIMIT'); this.log('QQ', 'SEND_RATE_LIMIT'); continue; }
        if (target.managedFriend && !this.friendAgent?.active(target.id)) { this.state.record(target.eventKey, 'cancelled', 'FRIEND_CONVERSATION_STOPPED'); continue; }
        this.state.record(target.eventKey, 'generating');
        let recalled: string | undefined;
        try { if (!target.adminCommand) recalled = this.memory?.store.recall(this.config.onebot.selfId, target); }
        catch { throw new BridgeError('MEMORY_DATABASE_FAILED', 'MEMORY'); }
        const material = target.attachments?.length ? await understandAttachments(target, this.config, this.sender, this.controller.signal) : undefined;
        if (material) this.conversation.describe(target, this.config, material);
        if (material) this.chat?.summary(this.config.onebot.selfId,target.eventKey,material);
        const context = [recalled, target.conversationContext, material].filter(Boolean).join('\n');
        const voiceEnabled = this.config.voice?.enabled && !target.adminCommand;
        const mediaEnabled = this.config.media?.enabled && !target.adminCommand;
        const clips = voiceEnabled ? this.voice.catalog() : [];
        const style = this.conversation.style(target, this.config, this.friendAgent?.style(target, this.config.replyStyle) ?? this.config.replyStyle) +
          (voiceEnabled ? this.voice.prompt(clips.map(c => ({ ...c, text: this.conversation.sanitize(c.text, this.config), description: this.conversation.sanitize(c.description, this.config) }))) : '') +
          (mediaEnabled ? this.media.prompt(target, this.config, this.state.data.mediaHistory ?? {}, text => this.conversation.sanitize(text, this.config)) : '');
        const raw = target.approvalCommand
          ? await this.requests.command(target.text.replace(/^\/qq\s+/, ''), this.config, this.controller.signal)
          : target.adminCommand
          ? await this.friendAgent!.execute(target, this.config, this.controller.signal, (t, text) => this.send(t, text))
          : await this.gemini.generate(sessionKey, target.text, style, this.controller.signal, context || undefined);
        const choice: Choice = voiceEnabled || mediaEnabled ? parseChoice(raw, clips, Boolean(voiceEnabled), Boolean(mediaEnabled)) : { kind: 'text', text: raw };
        let answer = this.conversation.sanitize(choice.text, this.config);
        if (choice.kind === 'image' || choice.kind === 'sticker') {
          if (!canOfferMedia(target, this.state.data.mediaHistory, Date.now(), choice.kind) || choice.kind === 'image' && !explicitMedia(target.text, 'image')) {
            answer ||= '嗯，接着聊吧'; this.log('MEDIA', 'FREQUENCY_LIMIT');
          } else {
            try {
              if (!this.sender.sendImage) throw new BridgeError('IMAGE_SEND_UNAVAILABLE', 'MEDIA');
              const query = choice.query === undefined ? undefined : this.conversation.sanitize(choice.query, this.config).replace(/＊＊＊|\d{5,}|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, '').trim();
              if (choice.query !== undefined && !query) throw new BridgeError('MEDIA_QUERY_EMPTY', 'MEDIA');
              picture = await this.media.prepare({ ...choice, query }, this.config, this.controller.signal);
              if (choice.kind === 'image') answer += (answer ? '\n' : '') + '来源：' + this.conversation.sanitize(picture.source, this.config);
            } catch (e) {
              if (this.paused || this.epoch !== epoch || this.controller.signal.aborted) throw new BridgeError('PAUSED');
              this.log('MEDIA', e instanceof BridgeError ? e.code : 'MEDIA_PREPARE_FAILED');
              answer = '这次没找到合适的' + (choice.kind === 'sticker' ? '表情包' : '图片') + '，先用文字回复你';
            }
          }
        }
        const recorded = picture ? answer + (answer ? '\n' : '') + '[' + (choice.kind === 'sticker' ? '表情包' : '图片') + '：' + this.conversation.sanitize(picture.description, this.config) + ']' + (choice.kind === 'image' ? '' : '\n来源：' + this.conversation.sanitize(picture.source, this.config)) : answer;
        if (!target.adminCommand) this.chat?.put(this.config.onebot.selfId,target,'ai',recorded,'generated');
        try { if (!target.adminCommand) this.memory?.store.answer(this.config.onebot.selfId, target, recorded); }
        catch { throw new BridgeError('MEMORY_DATABASE_FAILED', 'MEMORY'); }
        if (this.paused || this.epoch !== epoch) throw new BridgeError('PAUSED');
        if (answer.length > this.config.maxReplyChars) throw new BridgeError('REPLY_TOO_LONG', 'READ_FAILED');
        if (!target.approvalCommand) await this.gemini.verify(this.controller.signal);
        if (this.paused || this.epoch !== epoch) throw new BridgeError('PAUSED');
        if (!this.sender.ready) throw new BridgeError('QQ_DISCONNECTED', 'QQ_SEND_FAILED');
        if (this.config.realSend) {
          if (choice.kind === 'tts' || choice.kind === 'clip') {
            try {
              if (!this.sender.sendVoice) throw new BridgeError('VOICE_SEND_UNAVAILABLE', 'VOICE');
              prepared = await this.voice.prepare({ ...choice, text: answer }, this.config.voice!, this.controller.signal);
            } catch (e) {
              if (this.paused || this.epoch !== epoch || this.controller.signal.aborted) throw new BridgeError('PAUSED');
              this.log('VOICE', e instanceof BridgeError ? e.code : 'VOICE_PREPARE_FAILED');
              this.log('VOICE', 'FALLBACK_TO_TEXT');
            }
          }
          if (this.paused || this.epoch !== epoch || this.controller.signal.aborted) throw new BridgeError('PAUSED');
          if (!this.sender.ready) throw new BridgeError('QQ_DISCONNECTED', 'QQ_SEND_FAILED');
          this.memory?.store.status(this.config.onebot.selfId, target.eventKey, 'sending');
          this.state.record(target.eventKey, 'sending');
          this.chat?.status(this.config.onebot.selfId,target.eventKey,'sending');
          const messageId = await this.send(target, answer, prepared?.file, picture?.file, recorded);
          this.state.record(target.eventKey, 'sent'); this.log('QQ', 'SENT');
          this.chat?.status(this.config.onebot.selfId,target.eventKey,'sent');
          this.conversation.remember(target, this.config, recorded, messageId ?? undefined);
          if (!target.adminCommand) {
            const history = this.state.data.mediaHistory ??= {};
            if (picture) history[target.key] = { at: Date.now(), turns: 0 };
            else if (history[target.key]) history[target.key].turns = Math.min(2, history[target.key].turns + 1);
          }
          this.state.confirmReply(sessionKey);
          this.memory?.store.status(this.config.onebot.selfId, target.eventKey, 'sent');
        } else {
          this.state.discardReply(sessionKey);
          this.memory?.store.status(this.config.onebot.selfId, target.eventKey, 'dry-run');
          this.state.record(target.eventKey, 'dry-run'); this.log('QQ', 'DRY_RUN_NOT_SENT');
          if (voiceEnabled) this.log('VOICE', 'DRY_RUN_' + choice.kind.toUpperCase());
          if (mediaEnabled) this.log('MEDIA', picture ? 'DRY_RUN_IMAGE_PREPARED' : 'DRY_RUN_TEXT_OR_VOICE');
          this.chat?.status(this.config.onebot.selfId,target.eventKey,'dry-run');
        }
      } catch (error) {
        const e = error instanceof BridgeError ? error : new BridgeError('INTERNAL_FAILURE', 'INTERNAL');
        const sent = this.state.event(target.eventKey)?.status === 'sent';
        if (!sent && !target.manual && !target.ownerCommand) this.state.discardReply(sessionKey);
        if (!sent) this.state.record(target.eventKey, e.uncertain ? 'uncertain' : 'failed', e.code);
        try {
          this.chat?.status(this.config.onebot.selfId,target.eventKey,sent ? 'sent' : e.uncertain ? 'uncertain' : 'failed');
          if (!target.manual && !target.ownerCommand) this.memory?.store.status(this.config.onebot.selfId, target.eventKey, sent ? 'sent' : e.uncertain ? 'uncertain' : 'failed'); }
        catch { this.log('MEMORY', 'MEMORY_DATABASE_FAILED'); }
        this.log(e.category, e.code); this.pause(e.code);
      } finally {
        try { prepared?.dispose(this.state.event(target.eventKey)?.status === 'uncertain'); }
        catch { this.log('VOICE', 'VOICE_CLEANUP_FAILED'); }
        try { picture?.dispose(this.state.event(target.eventKey)?.status === 'uncertain'); }
        catch { this.log('MEDIA', 'MEDIA_CLEANUP_FAILED'); }
        this.controller = undefined; this.current=undefined;
      }
    }
  }
  private async send(target: Target, text: string, voiceFile?: string, imageFile?: string, recorded = text) {
    if (this.config.replyAll) await this.waitForSend(target);
    if (this.paused || this.controller?.signal.aborted) throw new BridgeError('PAUSED');
    if (!this.sender.ready) throw new BridgeError('QQ_DISCONNECTED', 'QQ_SEND_FAILED');
    if (!this.conversation.canSend(target, this.config)) throw new BridgeError('SEND_RATE_LIMIT', 'QQ_SEND_FAILED');
    this.conversation.reserve(target, this.config);
    const clean = this.conversation.sanitize(text, this.config);
    if (!(target as Work).manual && !target.adminCommand) this.chat?.put(this.config.onebot.selfId,target,'ai',this.conversation.sanitize(recorded, this.config),'sending');
    try {
      const receipt=imageFile ? await this.sender.sendImage!(target, imageFile, clean, this.controller?.signal) : voiceFile ? await this.sender.sendVoice!(target, voiceFile) : await this.sender.send(target, clean, (target as Work).manual ? undefined : this.conversation.face(clean, this.config));
      this.chat?.status(this.config.onebot.selfId,target.eventKey,'sent'); return receipt;
    } catch(e) { this.chat?.status(this.config.onebot.selfId,target.eventKey,e instanceof BridgeError && e.uncertain ? 'uncertain' : 'failed'); throw e; }
  }
  private async waitForSend(target: Target) {
    while (!this.conversation.canSend(target, this.config)) {
      if (this.paused || this.controller?.signal.aborted) throw new BridgeError('PAUSED');
      await delay(250);
    }
    if (this.paused || this.controller?.signal.aborted) throw new BridgeError('PAUSED');
  }
  async idleCheck() {
    if (this.draining || this.paused || this.processing || this.checking) return;
    this.checking = true;
    try {
      this.checkTask = this.gemini.verify();
      await this.checkTask;
      if (!this.paused && !this.queue.length && (this.memory || this.qzone)) {
        this.controller = new AbortController();
        this.maintenance = (async () => {
          await this.qzone?.runRequested(this.config, this.controller!.signal);
          if (!this.paused && !this.queue.length) await this.memory?.maintain(this.config, this.controller!.signal);
        })();
        await this.maintenance;
      }
    }
    catch (e) { this.pause(e instanceof BridgeError ? e.code : this.memory ? 'MEMORY_DATABASE_FAILED' : 'UIA_UNAVAILABLE'); }
    finally { this.maintenance = undefined; this.controller = undefined; this.checkTask = undefined; this.checking = false; this.kick(); }
  }
  async settled() { await this.processing; await this.checkTask?.catch(() => {}); await this.maintenance; }
  async finishAndPause() {
    this.draining = true;
    await this.settled();
    const restore = !this.paused;
    this.pause('APP_EXIT');
    return { restore };
  }
}
