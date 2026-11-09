import type { Config } from './config.js';
import { digest, filterEvent } from './filter.js';
import type { Sender } from './onebot.js';
import type { State } from './state.js';
import { BridgeError, type Target } from './types.js';

export class Requests {
  constructor(private state: State, private sender: Sender, private log = (_category: string, _code: string) => {}) {}
  accept(e: any, config: Config): boolean {
    if (!e || e.post_type !== 'request' || String(e.self_id) !== config.onebot.selfId ||
      !['friend', 'group'].includes(e.request_type) || !/^[1-9]\d*$/.test(String(e.user_id)) ||
      typeof e.flag !== 'string' || !e.flag || e.flag.length > 2048 ||
      e.request_type === 'group' && (!['add', 'invite'].includes(e.sub_type) || !/^[1-9]\d*$/.test(String(e.group_id)))) return false;
    const id = digest(JSON.stringify([config.onebot.selfId, e.request_type, e.sub_type ?? '', e.flag])).slice(0, 16);
    const result = this.state.addRequest(id, { selfId: config.onebot.selfId, kind: e.request_type, flag: e.flag, userId: String(e.user_id),
      ...(e.request_type === 'group' ? { subType: e.sub_type, groupId: String(e.group_id) } : {}),
      comment: typeof e.comment === 'string' ? e.comment.slice(0, 500) : '', at: new Date().toISOString(), status: 'pending' });
    if (result === 'limited') this.log('REQUEST', 'REQUEST_LIMIT_REACHED');
    return result === 'accepted';
  }
  filter(event: unknown, config: Config): Target | undefined {
    if (!config.friendAdminId) return;
    const target = filterEvent(event, { ...config, replyAll: false, friends: [config.friendAdminId], groups: [], conversation: { enabled: false }, attachments: { enabled: false, localRoots: [] } });
    if (target && /^\/qq\s+(?:requests|approve|reject)(?:\s|$)/.test(target.text)) return { ...target, key: 'approval:' + target.key, adminCommand: true, approvalCommand: true };
  }
  async command(command: string, config: Config, signal?: AbortSignal): Promise<string> {
    const list = /^requests(?:\s+([1-9]\d{0,5}))?$/.exec(command);
    if (list) {
      const rows = Object.entries(this.state.requests(config.onebot.selfId, true));
      const page = Number(list[1] ?? 1), pages = Math.max(1, Math.ceil(rows.length / 5));
      if (page > pages) return `页码超出范围，共 ${pages} 页。`;
      return `联系人请求 ${rows.length} 条，第 ${page}/${pages} 页\n` + rows.slice((page - 1) * 5, page * 5).map(([id, r]) =>
        `${id} ${r.kind === 'friend' ? '好友申请' : r.subType === 'invite' ? '邀请本账号入群' : '他人申请加入群'} QQ=${r.userId}${r.groupId ? ' 群=' + r.groupId : ''} 状态=${r.status}\n验证信息（仅作资料）=${JSON.stringify(r.comment)}`).join('\n') +
        '\n私聊 /qq approve 编号 或 /qq reject 编号；本机控制台省略 /qq。未操作的请求不会自动同意。';
    }
    const decision = /^(approve|reject) ([a-f0-9]{16})$/.exec(command);
    if (!decision) return '用法：requests [页码]、approve 编号、reject 编号；每次只能处理一条。';
    const request = this.state.request(decision[2]);
    if (!request || request.selfId !== config.onebot.selfId || request.status !== 'pending') return '请求不存在或已处理；结果不明的请求请在 QQ 中核对，不自动重试。';
    if (!config.realSend) return '干跑：未处理该请求，真实发送关闭时不会添加好友或加入群。';
    if (signal?.aborted) throw new BridgeError('PAUSED');
    if (!this.sender.ready || !this.sender.handleRequest) throw new BridgeError('QQ_NOT_CONNECTED', 'CONNECTION');
    if (!this.state.requestStatus(decision[2], 'processing', 'pending')) return '请求已在处理中，不会重复执行。';
    try {
      await this.sender.handleRequest(request, decision[1] === 'approve');
    } catch (error) {
      this.state.requestStatus(decision[2], error instanceof BridgeError && !error.uncertain ? 'failed' : 'uncertain');
      throw error;
    }
    this.state.requestStatus(decision[2], decision[1] === 'approve' ? 'approved' : 'rejected');
    return `请求 ${decision[2]} 已${decision[1] === 'approve' ? '同意' : '拒绝'}。`;
  }
}
