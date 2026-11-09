import { BridgeError } from './types.js';
import { digest } from './filter.js';
import type { State } from './state.js';
import type { MemoryStore } from './memory.js';

export function memoryCommand(store: MemoryStore, account: string, state: State, args: string[], write = console.log) {
  const [command,kind,value,...rest] = args;
  const scope = kind === 'private' || kind === 'group' ? digest(`${account}:${kind}:${value}`) : undefined;
  const person = kind === 'person' ? value : undefined;
  const valid = scope || person;
  if (command === 'help' || !command) {
    write('memory list person QQ号 | memory list private QQ号 | memory list group 群号\nmemory search person QQ号 关键词 | memory search group 群号 关键词\nmemory delete fact 记忆编号 | memory clear person QQ号 | memory clear private QQ号 | memory clear group 群号\nmemory jobs\n管理后保持暂停，输入 r 恢复。失败或送达不明的整理任务不自动重试。'); return;
  }
  if (command === 'jobs') { write(JSON.stringify(store.jobs(account),null,2)); return; }
  if (command === 'delete' && kind === 'fact' && /^[1-9]\d*$/.test(value ?? '') || command === 'clear' && valid && /^[1-9]\d*$/.test(value ?? '')) {
    // Invalidate all reply sessions before deletion, including sessions containing injected cross-chat memories.
    state.data.antigravitySessions = {}; state.save();
    store.remove(account,command==='delete' ? 'fact' : person ? 'person' : 'scope',command==='delete' ? value : person ?? scope!);
    write('本地关联记忆已删除，旧回复会话已停用。Antigravity 服务自身的历史和既有备份不会被远程删除。'); return;
  }
  if ((command === 'list' || command === 'search') && valid && /^[1-9]\d*$/.test(value ?? '')) {
    const query = rest.join(' ').toLowerCase();
    if (command==='search' && !query) throw new BridgeError('MEMORY_QUERY_REQUIRED','MEMORY');
    const facts = store.facts(account,scope,person,query);
    const history = store.history(account,scope,person,query);
    write(JSON.stringify({facts,history},null,2)); return;
  }
  throw new BridgeError('MEMORY_COMMAND_INVALID','MEMORY');
}
