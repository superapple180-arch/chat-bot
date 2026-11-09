import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { MemoryStore, MemoryService } from '../dist/memory.js';
import { memoryCommand } from '../dist/memory-command.js';
import { Bridge } from '../dist/bridge.js';
import { State } from '../dist/state.js';
import { filterEvent } from '../dist/filter.js';
import { BridgeError } from '../dist/types.js';
import { readConfig } from '../dist/config.js';
const halfHour = 1800000;
const config = () => ({provider:'antigravity',antigravity:{executable:'runtime/antigravity/agy.exe',timeoutMs:1000,model:''},onebot:{selfId:'10000',url:'ws://127.0.0.1:3001',accessToken:'synthetic-token-00000',timeoutMs:1000},friends:['20001','20002'],groups:['30001','30002'],maxQueue:50,maxMessageChars:4000,maxReplyChars:8000,replyStyle:'简短',realSend:false,memory:{enabled:true}});
let sequence = 0;
const event = (text, user='20001', group, atBot=false) => ({post_type:'message',message_type:group?'group':'private',sub_type:'friend',self_id:10000,user_id:user,message_id:++sequence,...(group?{group_id:group}:{}),message:[...(atBot?[{type:'at',data:{qq:'10000'}}]:[]),{type:'text',data:{text}}]});
function fixture(t, transport) {
  fs.mkdirSync('artifacts/test-tmp',{recursive:true});
  const dir=fs.mkdtempSync(path.resolve('artifacts/test-tmp/memory-'));
  const file=path.join(dir,'memory.sqlite');
  let store=new MemoryStore(file);
  const state=new State(path.join(dir,'state.json'));
  t.after(()=>{store.close();state.close();fs.rmSync(dir,{recursive:true,force:true});});
  const c=config(), logs=[],sent=[];
  const calls=[];
  const agent={async ready(){},async verify(){},async generate(...args){calls.push(args);return '合成回答';}};
  const sender={ready:true,async send(t,a){sent.push([t,a]);}};
  const service=new MemoryService(store,transport??{async run(){return {conversationId:randomUUID(),response:'{"facts":[]}'};}},(...a)=>logs.push(a));
  const bridge=new Bridge(c,state,agent,sender,(...a)=>logs.push(a),service);
  const capture=(e)=>{const target=filterEvent(e,c,true);store.capture(c.onebot.selfId,target);return target;};
  return {get store(){return store;},state,c,bridge,service,logs,sent,calls,capture,file,dir,reopen(){store.close();store=new MemoryStore(file);return store;}};
}
function extract(f, targets, facts) {
  const rows=f.store.batch(f.c.onebot.selfId,f.c);
  assert.ok(rows.length);
  f.store.startJob(f.c.onebot.selfId,rows,Date.now());
  f.store.finishJob(f.c.onebot.selfId,rows,JSON.stringify({facts:facts.map((text,i)=>({subject:targets[i].userId,text,sources:[rows[i].id]}))}),Date.now());
}
test('records unmentioned allowlisted group text once without replying; paused and nonallowlisted messages are not captured', async t=>{
  const f=fixture(t);const e=event('群内讨论');
  f.bridge.accept(e);assert.equal(f.store.history('10000').length,0);
  await f.bridge.resume();const group=event('群内讨论','20001','30001');
  f.bridge.accept(group);f.bridge.accept(group);f.bridge.accept(event('排除','20001','99999'));
  f.bridge.accept({...event('附件','20001','30001'),message:[{type:'image',data:{}}]});
  f.bridge.accept({...group,message_id:++sequence,self_id:'99999'});
  f.bridge.accept(event('自身','10000','30001'));
  await f.bridge.settled();assert.equal(f.store.history('10000').length,1);assert.equal(f.calls.length,0);
  f.bridge.accept(event('提问','20001','30001',true));await f.bridge.settled();
  assert.equal(f.calls.length,1);assert.equal(f.sent.length,0);
  assert.equal(f.store.history('10000').filter(m=>m.role==='assistant')[0].status,'dry-run');
});
test('Antigravity memory captures keyword-triggered groups once and preserves dry-run isolation', async t=>{
  const f=fixture(t); f.c.groupAliases=['小蓝'];
  await f.bridge.resume(); const e=event('今天小蓝在吗','20001','30001');
  f.bridge.accept(e);f.bridge.accept(e);await f.bridge.settled();
  assert.equal(f.calls.length,1);assert.equal(f.calls[0][1],'今天小蓝在吗');assert.equal(f.sent.length,0);
  const rows=f.store.history('10000');
  assert.equal(rows.filter(m=>m.role==='user').length,1);
  assert.equal(rows.filter(m=>m.role==='assistant')[0].status,'dry-run');
});

test('same-person memories cross private and groups after database reopen, without crossing people or bot accounts', t=>{
  const f=fixture(t);const a=f.capture(event('我喜欢蓝色咖啡杯'));
  const b=f.capture(event('我的暗号是 OTHER_SECRET','20002'));
  extract(f,[a],['用户喜欢蓝色咖啡杯']);
  f.reopen();
  const query=filterEvent(event('我喜欢什么咖啡杯','20001','30002',true),f.c);
  const recalled=f.store.recall('10000',query);
  assert.ok(recalled.includes('蓝色咖啡杯'));assert.ok(!recalled.includes('OTHER_SECRET'));
  assert.ok(!f.store.recall('99999',query).includes('蓝色咖啡杯'));
  assert.ok(!f.store.recall('10000',b).includes('蓝色咖啡杯'));
});
test('old keyword-matching messages outside recent context are retrieved; prompt budget and sending status are respected', t=>{
  const f=fixture(t);const target=f.capture(event('项目 ALPHA_NEEDLE 是绿色'));
  f.store.answer('10000',target,'UNSENT_SECRET');f.store.status('10000',target.eventKey,'uncertain');
  for(let i=0;i<100;i++)f.capture(event('日常记录'+i));
  const query=filterEvent(event('ALPHA_NEEDLE 是什么颜色'),f.c);
  const recalled=f.store.recall('10000',query);
  assert.ok(recalled.includes('ALPHA_NEEDLE'));assert.ok(!recalled.includes('UNSENT_SECRET'));assert.ok(recalled.length<=6000);
});
test('90-day cleanup removes original text and FTS results while retaining sourced important facts', t=>{
  const f=fixture(t);const old=f.capture(event('旧原文 SECRET_OLD_RAW'));
  extract(f,[old],['喜欢蓝色']);
  f.store.db.prepare('UPDATE messages SET at=?').run(Date.now()-91*86400000);
  f.store.cleanup();
  assert.equal(f.store.history('10000').length,0);assert.equal(f.store.facts('10000').length,1);
  assert.equal(f.store.db.prepare("SELECT count(*) n FROM history_search WHERE history_search MATCH 'SECRET_OLD_RAW'").get().n,0);
  assert.ok(f.store.recall('10000',old).includes('喜欢蓝色'));
});
test('extractor validates source IDs and sender identity and preserves later explicit corrections with timestamps', t=>{
  const f=fixture(t);f.capture(event('我喜欢红色','20001','30001'));
  f.capture(event('更正 我现在喜欢蓝色','20002','30001'));
  const rows=f.store.batch('10000',f.c);
  for(const bad of ['bad json',JSON.stringify({facts:[{subject:'20001',text:'错误归因',sources:[rows[1].id]}]}),JSON.stringify({facts:[{subject:'20001',text:'伪造来源',sources:[99999]}]})]){
    assert.throws(()=>f.store.finishJob('10000',rows,bad,Date.now()),/MEMORY_INVALID_EXTRACTION/);
    assert.equal(f.store.facts('10000').length,0);
  }
  f.store.finishJob('10000',rows,JSON.stringify({facts:[{subject:'20001',text:'喜欢红色',sources:[rows[0].id]},{subject:'20002',text:'现在喜欢蓝色',sources:[rows[1].id]}]}),Date.now());
  assert.equal(f.store.facts('10000',undefined,'20001')[0].body,'喜欢红色');
  assert.equal(f.store.facts('10000',undefined,'20002')[0].body,'现在喜欢蓝色');
});
test('background extraction uses a fresh session only when due; uncertain work is persisted and never automatically retried', async t=>{
  let attempts=0;
  const f=fixture(t,{async run(request){attempts++;assert.equal(request.conversationId,undefined);throw new BridgeError('ANTIGRAVITY_TIMEOUT','GENERATION_FAILED',true);}});
  f.capture(event('我喜欢海边','20001','30001'));
  await f.service.maintain(f.c);assert.equal(attempts,0);
  await f.service.maintain(f.c,undefined,Date.now()+halfHour+100);assert.equal(attempts,1);
  assert.equal(f.store.jobs('10000')[0].status,'uncertain');
  await f.service.maintain(f.c,undefined,Date.now()+2*halfHour+200);assert.equal(attempts,1);
  f.reopen();assert.equal(f.store.batch('10000',f.c,Date.now()+10*halfHour).length,0);
});
test('crashed extraction and unfinished generated answers remain uncertain/interrupted on restart', t=>{
  const f=fixture(t);const a=f.capture(event('我是测试用户'));f.store.answer('10000',a,'尚未送达');
  f.store.startJob('10000',f.store.batch('10000',f.c),Date.now());
  f.reopen();assert.equal(f.store.jobs('10000')[0].status,'uncertain');
  assert.equal(f.store.history('10000')[0].status,'interrupted');
});
test('explicit fact/person/scope deletion clears sources, dependent facts, both sides of exchanges and provider sessions', t=>{
  for(const mode of ['fact','person','group']){
    const f=fixture(t);const a=f.capture(event('我喜欢深海 BLUE_DELETE','20001','30001'));
    f.store.answer('10000',a,'复述 BLUE_DELETE');f.store.status('10000',a.eventKey,'sent');
    extract(f,[a],['喜欢深海 BLUE_DELETE']);
    const fact=f.store.facts('10000')[0];
    f.state.data.antigravitySessions={one:{id:randomUUID(),model:''},two:{id:randomUUID(),model:''}};f.state.save();
    const args=mode==='fact'?['delete','fact',String(fact.id)]:mode==='person'?['clear','person','20001']:['clear','group','30001'];
    memoryCommand(f.store,'10000',f.state,args,()=>{});
    assert.equal(f.store.history('10000').length,0);assert.equal(f.store.facts('10000').length,0);
    assert.deepEqual(f.state.data.antigravitySessions,{});
    assert.ok(!f.store.recall('10000',a).includes('BLUE_DELETE'));
  }
});
test('memory database failure pauses bridge and never sends; acknowledged send status is not overwritten on journal failure', async t=>{
  const f=fixture(t);await f.bridge.resume();f.store.capture=()=>{throw Error('sqlite failure');};
  f.bridge.accept(event('触发'));assert.equal(f.bridge.paused,true);assert.equal(f.state.data.pauseReason,'MEMORY_DATABASE_FAILED');assert.equal(f.sent.length,0);
  const g=fixture(t);g.c.realSend=true;await g.bridge.resume();
  const status=g.store.status.bind(g.store);g.store.status=(a,e,s)=>{if(s==='sent')throw Error('sqlite failure');status(a,e,s);};
  const e=event('发送后失败');g.bridge.accept(e);await g.bridge.settled();
  assert.equal(g.sent.length,1);assert.equal(g.state.event(filterEvent(e,g.c).eventKey).status,'sent');assert.equal(g.bridge.paused,true);
});
test('reply arrival during consolidation queues until extraction finishes', async t=>{
  let release,started;
  const running=new Promise(r=>{started=r;});
  const f=fixture(t,{async run({signal}){started();await new Promise(r=>{release=r;signal.addEventListener('abort',r,{once:true});});if(signal.aborted)throw new BridgeError('PAUSED','MEMORY',true);return {response:'{"facts":[]}'};}});
  f.capture(event('我喜欢苹果','20001','30001'));await f.bridge.resume();
  const original=f.service.maintain.bind(f.service);f.service.maintain=(c,s)=>original(c,s,Date.now()+halfHour+100);
  const idle=f.bridge.idleCheck();await running;
  f.bridge.accept(event('提问'));assert.equal(f.calls.length,0);release();await idle;await f.bridge.settled();assert.equal(f.calls.length,1);
});
test('configuration defaults remain compatible and reject memory enabled on legacy Gemini', t=>{
  const f=fixture(t),file=path.join(f.dir,'config.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.c.onebot.accessToken + '\n');
  fs.writeFileSync(file,JSON.stringify(f.c));assert.equal(readConfig(file).memory.enabled,true);
  fs.writeFileSync(file,JSON.stringify({...f.c,provider:'gemini'}));assert.throws(()=>readConfig(file),/INVALID_MEMORY_CONFIG/);
});
test('pause aborts consolidation, cancels queued replies, and preserves uncertain extraction without replay', async t=>{
  let started;const running=new Promise(r=>{started=r;});
  const f=fixture(t,{async run({signal}){started();await new Promise(r=>signal.addEventListener('abort',r,{once:true}));throw new BridgeError('PAUSED','MEMORY',true);}});
  f.capture(event('我喜欢苹果','20001','30001'));await f.bridge.resume();
  const original=f.service.maintain.bind(f.service);f.service.maintain=(c,s)=>original(c,s,Date.now()+halfHour+100);
  const idle=f.bridge.idleCheck();await running;f.bridge.accept(event('排队消息'));f.bridge.pause();
  await idle;await f.bridge.settled();assert.equal(f.calls.length,0);assert.equal(f.sent.length,0);
  assert.equal(f.store.jobs('10000')[0].status,'uncertain');assert.equal(f.bridge.pending,0);
});
test('consolidation bounds batches, rotates groups, accepts successful JSON and skips removed allowlists', async t=>{
  const f=fixture(t,{async run({prompt}){const data=JSON.parse(prompt.split('本批原文：')[1]);return {response:JSON.stringify({facts:[{subject:data[0].subject,text:'喜欢苹果',sources:[data[0].id]}]})};}});
  for(let i=0;i<55;i++)f.capture(event('我喜欢苹果 '+i,'20001','30001'));
  const second=f.capture(event('我喜欢香蕉','20002','30002'));
  const batch=f.store.batch('10000',f.c);assert.equal(batch.length,50);assert.ok(batch.reduce((n,m)=>n+m.body.length,0)<=12000);
  await f.service.maintain(f.c,undefined,Date.now()+halfHour+100);
  assert.equal(f.store.facts('10000').length,1);
  assert.equal(f.store.batch('10000',f.c)[0].scope,second.key);
  assert.equal(f.store.batch('10000',{...f.c,groups:[]}).length,0);
});
test('later self-correction is returned with newer provenance and does not overwrite another person', t=>{
  const f=fixture(t);const first=f.capture(event('我喜欢红色'));
  extract(f,[first],['喜欢红色']);f.capture(event('更正 我现在喜欢蓝色'));
  const rows=f.store.batch('10000',f.c,Date.now()+halfHour+100);
  f.store.finishJob('10000',rows,JSON.stringify({facts:[{subject:'20001',text:'更正：现在喜欢蓝色，不再喜欢红色',sources:[rows[0].id]}]}),Date.now()+halfHour+100);
  const query=filterEvent(event('我喜欢什么颜色','20001','30002',true),f.c);
  const recalled=JSON.parse(f.store.recall('10000',query));
  assert.ok(recalled.items.some(x=>x.text.includes('现在喜欢蓝色')));
  assert.ok(recalled.items.filter(x=>x.type==='重要记忆').every(x=>x.sources.every(s=>s.user==='20001')));
});
test('expired message IDs and deleted fact IDs are never reused for another person', t=>{
  const f=fixture(t);const first=f.capture(event('我喜欢湖泊'));
  extract(f,[first],['喜欢湖泊']);
  const oldFact=f.store.facts('10000')[0],oldSource=JSON.parse(oldFact.sources)[0].id;
  f.store.db.prepare('UPDATE messages SET at=?').run(Date.now()-91*86400000);f.store.cleanup();
  f.capture(event('另一人的新记录','20002'));
  assert.ok(f.store.history('10000')[0].id>oldSource);
  f.store.remove('10000','fact',String(oldFact.id));
  assert.equal(f.store.history('10000')[0].user_id,'20002');
  const rows=f.store.batch('10000',f.c);
  f.store.finishJob('10000',rows,JSON.stringify({facts:[{subject:'20002',text:'新记忆',sources:[rows[0].id]}]}),Date.now());
  assert.ok(f.store.facts('10000')[0].id>oldFact.id);
});
