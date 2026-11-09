import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { Antigravity, AntigravityProcess } from './antigravity.js';
import { MemoryStore, MemoryService } from './memory.js';
import { memoryCommand } from './memory-command.js';
import { State } from './state.js';
import { filterEvent } from './filter.js';
import { BridgeError } from './types.js';
import { acquireLock } from './lock.js';

process.chdir(path.resolve(import.meta.dirname,'..'));
const run = randomUUID();
const folder = path.resolve('artifacts',`memory-${run}`);
fs.mkdirSync(folder,{recursive:true});
const report: {at:string;realQQ:boolean;checks:object[];result:string;reason?:string} = {at:new Date().toISOString(),realQQ:false,checks:[],result:'running'};
let store: MemoryStore | undefined, state: State | undefined;
let unlock = () => {};
try {
  unlock = acquireLock();
  const local=readConfig('config.local.json');
  if (!local.antigravity) throw new BridgeError('ANTIGRAVITY_CONFIG_REQUIRED');
  const c={...local,onebot:{...local.onebot,selfId:'10000'},friends:['20001'],groups:['30001'],realSend:false};
  const transport=new AntigravityProcess(local.antigravity);
  store=new MemoryStore(path.join(folder,'memory.sqlite'));
  state=new State(path.join(folder,'state.json'));
  const code='SYNTHETIC_'+run.replaceAll('-','');
  const event=(id:number,text:string,group=false)=>({post_type:'message',self_id:'10000',user_id:'20001',message_id:id,message_type:group?'group':'private',sub_type:'friend',...(group?{group_id:'30001'}:{}),message:[...(group?[{type:'at',data:{qq:'10000'}}]:[]),{type:'text',data:{text}}]});
  const first=filterEvent(event(1,`我为这次合成测试设定的长期测试代号是 ${code}，请记住。`),c)!;
  store.capture('10000',first);
  const memory=new MemoryService(store,transport,()=>{});
  await memory.maintain(c,undefined,Date.now()+1800100);
  if (!store.facts('10000').some(f=>f.body.includes(code))) throw new BridgeError('MEMORY_REAL_EXTRACTION_FAILED');
  report.checks.push({extraction:true});
  store.close();store=new MemoryStore(path.join(folder,'memory.sqlite'));
  // Remove raw messages to prove retrieval comes from the independent long-term facts.
  store.db.prepare('UPDATE messages SET at=?').run(Date.now()-91*86400000);store.cleanup();
  const query=filterEvent(event(2,'我之前设定的长期测试代号是什么？只回复代号。',true),c)!;
  const recalled=store.recall('10000',query);
  const agent=new Antigravity(transport,state,local.antigravity.model);
  const response=await agent.generate(query.key,query.text,'合成数据验收，请严格只回复代号。',undefined,recalled);
  if(response.trim()!==code)throw new BridgeError('MEMORY_REAL_RECALL_FAILED');
  report.checks.push({restart:true,rawExpired:true,crossPrivateToGroup:true,freshProviderSession:true,recall:true});
  memoryCommand(store,'10000',state,['clear','person','20001'],()=>{});
  if(store.facts('10000').length || Object.keys(state.data.antigravitySessions??{}).length || store.recall('10000',query).includes(code))throw new BridgeError('MEMORY_REAL_DELETE_FAILED');
  const after=await agent.generate(query.key,'如果没有我的长期测试代号记录，只回复 NO_MEMORY，不猜测。','这是删除后新会话的验收，只回复 NO_MEMORY。',undefined,store.recall('10000',query));
  if(after.trim()!=='NO_MEMORY')throw new BridgeError('MEMORY_REAL_FORGET_FAILED');
  report.checks.push({deletion:true,newSessionAfterDeletion:true});report.result='passed';
} catch(e) {report.result='failed';report.reason=e instanceof BridgeError?e.code:'MEMORY_VERIFY_FAILED';process.exitCode=1;}
finally {store?.close();state?.close();unlock();}
const file=path.join(folder,'report.json');fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({...report,report:file}));
