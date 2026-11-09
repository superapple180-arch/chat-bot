// Public fixture identities below are generated synthetic labels.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readConfig } from '../dist/config.js';
import { acquireLock } from '../dist/lock.js';
import { Antigravity, AntigravityProcess } from '../dist/antigravity.js';
import { FriendAgent } from '../dist/friend-agent.js';
import { State } from '../dist/state.js';
import { BridgeError } from '../dist/types.js';
process.chdir(path.resolve(import.meta.dirname, '..'));
let unlock=()=>{}, state, reportFile;
const checks=[], diagnostics=[];
try {
  unlock=acquireLock();
  const local=readConfig('config.local.json');
  if(local.provider!=='antigravity')throw new BridgeError('ANTIGRAVITY_REQUIRED','CONFIG');
  const dir=path.resolve('artifacts',`friend-agent-${Date.now()}`);fs.mkdirSync(dir,{recursive:true});
  reportFile=path.join(dir,'report.json');
  const config={...local,onebot:{...local.onebot,selfId:'10000'},friendAdminId:'90001',friends:[],groups:[],memory:{enabled:false},realSend:true};
  state=new State(path.join(dir,'state.json'));
  const launch=(...args)=>{
    const child=spawn(...args);let buffer='',initializedId='';
    child.stdout.on('data',chunk=>{buffer+=chunk.toString();let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const e=JSON.parse(line);if(e.event==='init')initializedId=e.conversation_id;if(e.event==='result')diagnostics.push({status:e.result?.status,responseChars:e.result?.response?.length??0,sessionMatched:e.result?.conversation_id===initializedId});}catch{}}});
    return child;
  };
  const transport=new AntigravityProcess(local.antigravity,path.join(dir,'workspace'),launch);
  const sends=[];
  const sender={ready:true,async friendList(){return [{userId:'20001',nickname:'合成小明',remark:'合成测试好友'},{userId:'20002',nickname:'合成昵称甲',remark:''},{userId:'20003',nickname:'合成昵称甲',remark:''}];},async send(target,text){sends.push({id:target.id,text});}};
  const agent=new FriendAgent(transport,sender,state);
  let serial=0;
  const event=(user,text)=>({post_type:'message',message_type:'private',sub_type:'friend',self_id:10000,user_id:Number(user),message_id:++serial,message:[{type:'text',data:{text}}]});
  const run=text=>agent.execute(agent.filter(event('90001',text),config),config);
  const verify=async(name,fn)=>{await fn();checks.push(name);console.log(`PASS ${name}`);};
  await verify('list',async()=>{assert.match(await run('/qq 查看好友列表'),/20001/);assert.equal(sends.length,0);});
  await verify('start',async()=>{await run('/qq 找合成小明聊旅行计划，先说明你是 AI 助手，再问他想去哪里');assert.equal(sends.length,1);assert.equal(sends[0].id,'20001');assert.ok(agent.active('20001'));});
  await verify('reply',async()=>{
    const target=agent.filter(event('20001','我想去海边，你觉得适合安排什么活动？'),config);assert.ok(target?.managedFriend);
    const generator=new Antigravity(transport,state,local.antigravity.model);
    const answer=await generator.generate(target.key,target.text,agent.style(target,config.replyStyle));
    assert.ok(answer.trim());state.confirmReply(target.key);
  });
  await verify('ambiguous',async()=>{await run('/qq 找昵称叫合成昵称甲的朋友聊旅行');assert.equal(sends.length,1);});
  await verify('stop',async()=>{await run('/qq 停止与好友 20001 的主动对话');assert.equal(agent.active('20001'),false);assert.equal(sends.length,1);});
  fs.writeFileSync(reportFile,JSON.stringify({at:new Date().toISOString(),checks,diagnostics,realQQ:false,syntheticDispatches:sends.length},null,2));
  console.log(`REPORT ${reportFile}`);
} catch(e) {
  if(reportFile)fs.writeFileSync(reportFile,JSON.stringify({at:new Date().toISOString(),checks,diagnostics,realQQ:false,error:e instanceof BridgeError?e.code:'FRIEND_AGENT_VERIFICATION_FAILED'},null,2));
  console.error(e instanceof BridgeError?e.code:'FRIEND_AGENT_VERIFICATION_FAILED');process.exitCode=1;
} finally {state?.close();unlock();}
