import type { Config } from './config.js';
import type { State } from './state.js';
import type { Target } from './types.js';
import { digest } from './filter.js';

type Entry = { event: string; messageId?: string; userId?: string; name?: string; text: string; at: number; role: 'user' | 'assistant' };
export class Conversation {
  private recent = new Map<string, Entry[]>();
  constructor(private state: State) {}
  clear() { this.recent.clear(); }
  private scope(t: Target, c: Config) { return digest(`${c.onebot.selfId}:${t.kind}:${t.id}`); }
  remember(t: Target, c: Config, answer?: string, messageId?: string) {
    if (!c.conversation?.enabled || t.adminCommand) return;
    const key = this.scope(t, c), entries = this.recent.get(key) ?? [];
    const isUser = answer === undefined, role = isUser ? 'user' : 'assistant';
    if (entries.some(e => e.event === t.eventKey && e.role === role)) return;
    entries.push({ event: t.eventKey, messageId: isUser ? t.messageId : messageId, userId: isUser ? t.userId : c.onebot.selfId,
      name: isUser ? t.senderName : 'AI', text: answer ?? t.text, at: Date.now(), role });
    this.recent.set(key, entries.slice(-(t.kind === 'group' ? 80 : 30)));
  }
  context(t: Target, c: Config) {
    if (!c.conversation?.enabled || t.adminCommand) return undefined;
    const entries = this.recent.get(this.scope(t, c)) ?? [];
    const quoted = t.replyTo ? entries.find(e => e.messageId === t.replyTo) : undefined;
    const recent: Entry[] = [];
    const context = { currentSpeaker: t.userId, currentName: t.senderName, atUsers: t.atUsers,
      replyTo: t.replyTo, quoted: quoted ? { ...quoted, text: quoted.text.slice(0, 500) } : undefined,
      quoteUnavailable: Boolean(t.replyTo && !quoted), recent };
    let length = JSON.stringify(context).length;
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.event === t.eventKey && entry.role === 'user') continue;
      const item = { ...entry, text: entry.text.slice(0, 1500) };
      const size = JSON.stringify(item).length + (recent.length ? 1 : 0);
      if (length + size > 6000) break;
      recent.unshift(item);
      length += size;
    }
    return JSON.stringify(context);
  }
  style(t: Target, c: Config, base: string) {
    if (!c.conversation?.enabled || t.adminCommand) return base;
    const note = c.conversation.personas?.[`${t.kind}:${t.id}`];
    const style = base + '\n聊天方式：围绕当前发送者的这句话和最近上下文接话，分清群内不同说话人、引用对象与时间，不把别人的经历安到对方身上。默认用一到三句自然口语，用户需要解释或细节时再展开；避免客服套话、重复复述、无必要的分点和每轮结尾追问。对方倾诉时先回应具体感受，不急于说教；玩笑和吐槽可轻松接住，不把调侃当事实，也不强行迎合。\n' +
      '附件聊天：结合视觉依据中的配字、动作和语气回应表情包，默认自然接梗；只有对方要求解释、识字或总结时才展开分析。只有附件且未附文字时按分享内容自然回应，不机械地逐项描述画面。区分画面事实与语气推测；不确定梗义就保留不确定性，关键文字看不清时再请对方补充。视频依据仅为无声抽样，问到未提供的声音或未采样细节时如实说明限制，不编造。';
    return note ? style + '\n本会话专属性格（优先级低于全局规则及隐私约束）：\n' + note : style;
  }
  describe(t: Target, c: Config, material: string) {
    if (!c.conversation?.enabled || t.adminCommand) return;
    const entry = this.recent.get(this.scope(t, c))?.find(e => e.event === t.eventKey && e.role === 'user');
    if (entry) entry.text = t.text + '\n' + material.slice(0, 6000);
  }
  repliesToSelf(t: Target, c: Config) {
    return Boolean(c.conversation?.enabled && t.replyTo && this.recent.get(this.scope(t, c))?.some(e => e.messageId === t.replyTo && e.role === 'assistant'));
  }
  canSend(t: Target, c: Config) { return !c.conversation?.enabled || this.state.canSend(this.scope(t, c)); }
  reserve(t: Target, c: Config) { if (c.conversation?.enabled) this.state.reserveSend(this.scope(t, c)); }
  sanitize(text: string, c: Config) {
    const secrets = [c.onebot.accessToken, ...(c.conversation?.enabled ? [c.friendAdminId ?? '', ...c.conversation.redact ?? []] : [])].filter(Boolean).sort((a, b) => b.length - a.length);
    for (const secret of secrets) text = text.split(secret).join('＊＊＊');
    return text.replace(/\b(?:Bearer\s+)[a-zA-Z0-9._~+\/-]+=*/gi, 'Bearer ＊＊＊')
      .replace(/\b(SESSDATA|access[_-]?token|api[_-]?key|password)\s*[=:]\s*["']?[^\s"';,]+/gi, '$1=＊＊＊');
  }
  face(text: string, c: Config, now = new Date(), random = Math.random) {
    if (!c.conversation?.enabled || text.length > 60) return undefined;
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
    const minutes = Number(parts.find(p => p.type === 'hour')!.value) * 60 + Number(parts.find(p => p.type === 'minute')!.value);
    const offpeak = minutes >= 30 && minutes < 510;
    const probability = offpeak ? c.conversation.faceProbability ?? 0 : c.conversation.peakFaceProbability ?? 0;
    if (random() >= probability) return undefined;
    return /哈哈|开心|高兴/.test(text) ? '4' : /谢谢|喜欢/.test(text) ? '76' : /困|晚安/.test(text) ? '21' : '14';
  }
}
