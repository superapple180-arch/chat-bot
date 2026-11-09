import path from 'node:path';
import { readConfig } from './config.js';
import { State } from './state.js';
import { MemoryStore } from './memory.js';
import { memoryCommand } from './memory-command.js';
import { BridgeError } from './types.js';
import { acquireLock } from './lock.js';

process.chdir(path.resolve(import.meta.dirname,'..'));
let unlock = () => {};
let store: MemoryStore | undefined, state: State | undefined;
try {
  unlock = acquireLock();
  const config = readConfig('config.local.json');
  if (!config.memory?.enabled) throw new BridgeError('MEMORY_NOT_ENABLED','MEMORY');
  store = new MemoryStore('state/memory.sqlite');
  store.cleanup();
  state = new State('state/antigravity.json');
  memoryCommand(store,config.onebot.selfId,state,process.argv.slice(2));
} catch (e) { console.error(e instanceof BridgeError ? e.code : 'MEMORY_DATABASE_FAILED'); process.exitCode=1; }
finally { store?.close(); state?.close(); unlock(); }
