import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { Bridge } from '../dist/bridge.js';
import { BridgeError } from '../dist/types.js';
import { State } from '../dist/state.js';
import { ChatStore } from '../dist/chat.js';
import { setWebPassword,WebAuth } from '../dist/web-auth.js';
import { createWebServer } from '../dist/web-server.js';
import { Supervisor } from '../dist/web-supervisor.js';
import { acquireLock } from '../dist/lock.js';
import { MemoryStore } from '../dist/memory.js';
import { FriendAgent } from '../dist/friend-agent.js';

function directory(t,prefix='web'){
  fs.mkdirSync('artifacts/test-tmp',{recursive:true});const dir=fs.mkdtempSync(path.resolve(`artifacts/test-tmp/${prefix}-`));
  return dir;
}
function configuration(){const c=JSON.parse(fs.readFileSync('config.example.json'));return {...c,onebot:{...c.onebot,selfId:'10000',accessToken:randomUUID()},friends:['20001','20002'],groups:['30001'],realSend:true};}
function incoming(id=1,user='20001'){return {post_type:'message',message_type:'private',sub_type:'friend',self_id:10000,user_id:Number(user),message_id:id,message:[{type:'text',data:{text:`合成消息 ${id}`}}]};}
function bridgeFixture(t){
  const dir=directory(t),state=new State(path.join(dir,'state.json')),chat=new ChatStore(path.join(dir,'chat.sqlite')),sent=[],c=configuration();
  let generating=0,max=0;
  const generator={async ready(){},async verify(){},async generate(){generating++;max=Math.max(max,generating);await delay(30);generating--;return '合成 AI 回复';}};
  const sender={ready:true,async friendList(){return [{userId:'20001',nickname:'合成好友',remark:''},{userId:'20002',nickname:'合成好友二',remark:''}];},async send(t,text,face){sent.push({kind:t.kind,id:t.id,text,face});return String(sent.length);}};
  const bridge=new Bridge(c,state,generator,sender,()=>{},undefined,undefined,undefined,chat);
  t.after(async()=>{bridge.pause();await bridge.settled();state.close();chat.close();});
  return {dir,state,chat,sent,c,bridge,sender,get max(){return max;}};
}
test('workbench captures only eligible running events; manual and AI share one queue, preserve targets and manual request deduplication',async t=>{
  const f=bridgeFixture(t);f.bridge.accept(incoming());assert.equal(f.chat.conversations('10000').length,0);
  await f.bridge.resume();f.bridge.accept(incoming());f.bridge.accept(incoming());f.bridge.accept(incoming(2,'99999'));
  const requestId=randomUUID();await Promise.all([f.bridge.manualSend('private','20002','人工回复',requestId),f.bridge.manualSend('private','20002','人工回复',requestId)]);
  await f.bridge.settled();assert.deepEqual(f.sent.map(s=>[s.id,s.text]),[['20001','合成 AI 回复'],['20002','人工回复']]);assert.equal(f.max,1);
  assert.equal(f.chat.messages('10000','private','20001').filter(m=>m.source==='user').length,1);
  const manual=f.chat.messages('10000','private','20002');assert.equal(manual.length,1);assert.equal(manual[0].source,'manual');assert.equal(manual[0].status,'sent');assert.equal(f.sent[1].face,undefined);
  await f.bridge.manualSend('private','20002','人工回复',requestId);await f.bridge.settled();assert.equal(f.sent.length,2);
  assert.equal(f.chat.conversations('another-account').length,0);
});
test('manual dry run never calls sender or memory; paused and unknown targets are rejected',async t=>{
  const f=bridgeFixture(t);f.c.realSend=false;
  await assert.rejects(f.bridge.manualSend('private','20001','文本',randomUUID()),{code:'PAUSED'});
  await f.bridge.resume();await assert.rejects(f.bridge.manualSend('group','90000','文本',randomUUID()),{code:'MANUAL_TARGET_NOT_KNOWN'});
  await f.bridge.manualSend('private','20001','文本 '+f.c.onebot.accessToken,randomUUID());await f.bridge.settled();
  assert.equal(f.sent.length,0);const m=f.chat.messages('10000','private','20001')[0];assert.equal(m.status,'dry-run');assert.ok(!m.body.includes(f.c.onebot.accessToken));
});
test('owner operation results remain available to management but cannot create a QQ conversation or authorize manual sending',async t=>{
  const f=bridgeFixture(t),target={kind:'private',id:'10000',key:'owner',eventKey:'owner-result-only',text:'管理结果'};
  f.chat.put('10000',target,'owner-result','已完成调度','completed');
  assert.equal(f.chat.messages('10000','private','10000')[0].body,'已完成调度');
  assert.deepEqual(f.chat.conversations('10000'),[]);
  assert.equal(f.chat.hasConversation('10000','private','10000'),false);
  await f.bridge.resume();await assert.rejects(f.bridge.manualSend('private','10000','不应发给自己',randomUUID()),{code:'MANUAL_TARGET_NOT_KNOWN'});
  assert.equal(f.sent.length,0);
});
test('authenticated owner dispatch can start a managed friend without configuring a QQ administrator, and records actual outgoing content',async t=>{
  const f=bridgeFixture(t);f.c.friends=[];f.c.friendAdminId='';
  const agent=new FriendAgent({async run(){return {response:JSON.stringify({action:'start',target:'20001',text:'合成开场',instruction:'聊聊周末'})};}},f.sender,f.state);
  const b=new Bridge(f.c,f.state,{async ready(){},async verify(){},async generate(){return '合成后续回复';}},f.sender,()=>{},undefined,agent,undefined,f.chat);
  await b.resume();b.ownerDispatch('找好友 20001 聊聊周末',randomUUID());await b.settled();assert.equal(f.sent[0].text,'合成开场');assert.equal(f.chat.messages('10000','private','20001')[0].body,'合成开场');
  b.accept(incoming(8));await b.settled();assert.equal(f.sent[1].text,'合成后续回复');b.pause();
});
test('uncertain manual send pauses; the persistent request cannot send again even across restart',async t=>{
  const f=bridgeFixture(t);let calls=0;f.sender.send=async()=>{calls++;throw new BridgeError('QQ_SEND_UNCERTAIN','QQ_SEND_FAILED',true);};
  const id=randomUUID();await f.bridge.resume();await f.bridge.manualSend('private','20001','文本',id);await f.bridge.settled();assert.ok(f.bridge.paused);assert.equal(calls,1);
  await f.bridge.manualSend('private','20001','文本',id);assert.equal(calls,1);assert.equal(f.chat.messages('10000','private','20001')[0].status,'uncertain');
  const second=new State(path.join(f.dir,'state.json'));t.after(()=>second.close());const b=new Bridge(f.c,second,{ready:async()=>{},verify:async()=>{},generate:async()=>''},f.sender,()=>{},undefined,undefined,undefined,f.chat);
  await b.manualSend('private','20001','文本',id);assert.equal(calls,1);
});
test('pause cancels queued manual work; attachments keep metadata and existing summary only, with ninety-day cleanup',async t=>{
  const f=bridgeFixture(t);await f.bridge.resume();f.bridge.accept(incoming());await f.bridge.manualSend('private','20002','排队文本',randomUUID());f.bridge.pause();await f.bridge.settled();
  assert.equal(f.sent.length,0);assert.equal(f.chat.messages('10000','private','20002')[0].status,'cancelled');
  const target={kind:'group',id:'30001',eventKey:'attachment-event',key:'x',text:'附件',attachments:[{kind:'image',fileId:'private-platform-id',name:'合成.png'}]};
  f.chat.capture('10000',target);f.chat.summary('10000',target.eventKey,'已有解析摘要');
  const row=f.chat.messages('10000','group','30001')[0];assert.equal(row.summary,'已有解析摘要');assert.ok(!row.attachments.includes('fileId'));
  f.chat.db.prepare('UPDATE chat SET at=?').run(Date.now()-91*86400000);f.chat.cleanup();assert.equal(f.chat.conversations('10000').length,0);
});

class FakeSupervisor extends EventEmitter {
  status={running:false,paused:true,onebotConnected:false};logs=[];calls=[];
  async start(){this.status={running:true,paused:true,onebotConnected:true};return this.status;}
  async stop(){this.status={running:false,paused:true,onebotConnected:false};}
  async call(action,payload){this.calls.push([action,payload]);if(action==='memory')return JSON.stringify({facts:[],history:[]});if(action==='requests')return [];if(action==='decision')return '已处理';if(action==='qzone')return {status:'not-requested'};return {};}
}
async function apiFixture(t){
  const root=directory(t);fs.mkdirSync(path.join(root,'state'));const c=configuration();fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(root,'config.local.json'),JSON.stringify(c));
  const password=randomUUID();
  await setWebPassword(path.join(root,'state/web-auth.json'),password);
  const supervisor=new FakeSupervisor(),{app}=await createWebServer(root,supervisor);await app.ready();t.after(()=>app.close());
  const request=(method,url,body,headers={})=>{
    const address=app.server.address(),origin=new URL('http://127.0.0.1:3210');
    if(address&&typeof address==='object')origin.port=String(address.port);
    return app.inject({method,url,payload:body,headers:{host:origin.host,origin:origin.origin,...headers}});
  };
  const login=await request('POST','/api/login',{password});const cookie=login.headers['set-cookie'].split(';')[0],csrf=login.json().csrf;
  const authed=(method,url,body,headers={})=>request(method,url,body,{cookie,'x-csrf-token':csrf,...headers});return {root,c,app,supervisor,request,authed,cookie,csrf,password};
}
test('API requires password and CSRF, rejects cross origin and hostile Host, and never returns configured OneBot token',async t=>{
  const f=await apiFixture(t);
  assert.equal((await f.request('GET','/api/config')).statusCode,401);
  assert.equal((await f.authed('POST','/api/runtime/start',{}, {'x-csrf-token':''})).statusCode,403);
  assert.equal((await f.authed('POST','/api/runtime/start',{}, {origin:'https://evil.example'})).statusCode,403);
  assert.equal((await f.authed('GET','/api/config',undefined,{host:'evil.example'})).statusCode,403);
  const config=await f.authed('GET','/api/config');assert.equal(config.statusCode,200);assert.ok(!config.body.includes(f.c.onebot.accessToken));assert.equal(config.json().config.onebot.accessToken,'');
  const saved=await f.authed('PUT','/api/config',{...config.json(),config:{...config.json().config,replyStyle:'新风格'}});assert.equal(saved.statusCode,200);assert.equal(saved.json().restartRequired,false);
  const persisted=JSON.parse(fs.readFileSync(path.join(f.root,'config.local.json')));assert.equal(persisted.onebot.accessToken,'');assert.ok(!fs.readFileSync(path.join(f.root,'state/config.local.backup.json'),'utf8').includes(f.c.onebot.accessToken));assert.equal(persisted.replyStyle,'新风格');assert.ok(fs.existsSync(path.join(f.root,'state/config.local.backup.json')));
  assert.equal((await f.authed('PUT','/api/config',config.json())).json().code,'CONFIG_CHANGED_EXTERNALLY');
  await f.authed('POST','/api/logout',{});assert.equal((await f.authed('GET','/api/config')).statusCode,401);
});
test('invalid config never replaces disk; explicit restart classification, structured approvals, memory and remote secure cookie',async t=>{
  const f=await apiFixture(t),config=(await f.authed('GET','/api/config')).json(),before=fs.readFileSync(path.join(f.root,'config.local.json'),'utf8');
  const invalid=structuredClone(config);invalid.config.maxQueue=-1;
  assert.equal((await f.authed('PUT','/api/config',invalid)).json().code,'INVALID_LIMIT');assert.equal(fs.readFileSync(path.join(f.root,'config.local.json'),'utf8'),before);
  config.config.onebot.timeoutMs+=1;assert.equal((await f.authed('PUT','/api/config',config)).json().restartRequired,true);
  assert.equal((await f.authed('POST','/api/requests/invalid',{approve:true})).statusCode,409);
  assert.equal((await f.authed('POST','/api/requests/1234567890abcdef',{approve:'yes'})).statusCode,409);
  assert.equal((await f.authed('POST','/api/requests/1234567890abcdef',{approve:true})).statusCode,200);
  assert.equal((await f.authed('POST','/api/memory',{args:['list','person','20001']})).json().data.facts.length,0);
  const remoteOrigin=new URL('https://bot.synthetic.ts.net');
  const remoteHeaders={host:remoteOrigin.host,origin:remoteOrigin.origin};
  fs.writeFileSync(path.join(f.root,'state/web-access.json'),JSON.stringify({remoteOrigin:remoteOrigin.origin}));
  const remote=await f.request('POST','/api/login',{password:f.password},remoteHeaders);
  assert.match(remote.headers['set-cookie'],/Secure/);assert.match(remote.headers['set-cookie'],/HttpOnly/);assert.match(remote.headers['set-cookie'],/SameSite=Strict/);
  assert.equal((await f.authed('POST','/api/napcat/start',{},remoteHeaders)).json().code,'LOCAL_ACTION_ONLY');
});
test('password storage is salted hash and login is rate limited',async t=>{
  const f=await apiFixture(t),file=path.join(f.root,'state/web-auth.json'),raw=fs.readFileSync(file,'utf8');assert.ok(!raw.includes(f.password));
  const wrongPassword=randomUUID(),auth=new WebAuth(file);assert.equal(await auth.login(wrongPassword),undefined);
  let response;for(let i=0;i<9;i++)response=await f.request('POST','/api/login',{password:wrongPassword});assert.equal(response.statusCode,429);
});

async function workerFixture(t){
  const root=directory(t,'worker');fs.cpSync('dist',path.join(root,'dist'),{recursive:true});fs.writeFileSync(path.join(root,'package.json'),'{"type":"module"}');
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.on('listening',r));
  const actions=[];
  server.on('connection',s=>s.on('message',raw=>{const m=JSON.parse(raw);actions.push(m);assert.ok(['get_login_info','get_status','get_group_member_info','set_friend_add_request'].includes(m.action));s.send(JSON.stringify({echo:m.echo,status:'ok',retcode:0,data:m.action==='get_login_info'?{user_id:10000,nickname:'合成'}:m.action==='get_status'?{online:true,good:true}:m.action==='set_friend_add_request'?null:{user_id:10000,card:'合成'}}));}));
  const c=configuration();c.groups=[];c.onebot.url=`ws://127.0.0.1:${server.address().port}`;fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(root,'config.local.json'),JSON.stringify(c));
  const supervisor=new Supervisor(root);t.after(async()=>{await supervisor.stop().catch(()=>{});for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));});return {root,supervisor,server,actions};
}
async function until(fn){const end=Date.now()+6000;while(!fn()){if(Date.now()>end)throw Error('WAIT_TIMEOUT');await delay(20);}}
test('real worker starts paused, reports status, refuses live CLI lock and releases lock on graceful stop',async t=>{
  const f=await workerFixture(t),lock=path.join(f.root,'state/bridge.lock'),release=acquireLock(lock);
  await assert.rejects(f.supervisor.start(),{code:'BRIDGE_ALREADY_RUNNING'});release();await until(()=>!f.supervisor.status.running);
  await f.supervisor.start();assert.ok(f.supervisor.status.paused);const s=await f.supervisor.call('status');assert.equal(s.realSend,true);
  await f.supervisor.stop();assert.ok(!fs.existsSync(lock));assert.equal(f.supervisor.status.running,false);
});
test('loss of manager IPC stops the real worker without resuming or invoking the provider',async t=>{
  const f=await workerFixture(t);await f.supervisor.start();f.supervisor.disconnect();await until(()=>!f.supervisor.status.running);assert.ok(!fs.existsSync(path.join(f.root,'state/bridge.lock')));
});

test('worker pause cancels an older resume queued behind a slow RPC',async t=>{
  const f=await workerFixture(t),file=path.join(f.root,'config.local.json'),c=JSON.parse(fs.readFileSync(file));
  c.provider='antigravity';c.antigravity={executable:process.execPath,timeoutMs:1000,model:''};
  fs.writeFileSync(file,JSON.stringify(c));fs.mkdirSync(path.join(f.root,'scripts'));
  fs.copyFileSync('scripts/antigravity-tools-hook.mjs',path.join(f.root,'scripts/antigravity-tools-hook.mjs'));
  let held,peer;
  f.server.removeAllListeners('connection');
  f.server.on('connection',s=>s.on('message',raw=>{
    const m=JSON.parse(raw);
    if(m.action==='get_friend_list'){held=m;peer=s;return;}
    assert.ok(['get_login_info','get_status'].includes(m.action));
    s.send(JSON.stringify({echo:m.echo,status:'ok',retcode:0,data:m.action==='get_login_info'?{user_id:10000,nickname:'合成'}:{online:true,good:true}}));
  }));
  await f.supervisor.start();await until(()=>f.supervisor.status.onebotConnected);
  const friends=f.supervisor.call('friends');await until(()=>held);
  const resume=f.supervisor.call('resume'),cancelled=assert.rejects(resume,{code:'CONTROL_CANCELLED'});
  const pause=f.supervisor.call('pause');await until(()=>f.supervisor.status.reason==='USER_PAUSED');
  peer.send(JSON.stringify({echo:held.echo,status:'ok',retcode:0,data:[]}));
  await friends;await cancelled;await pause;
  assert.equal((await f.supervisor.call('status')).paused,true);
});
test('authenticated API uses the real worker for request decisions and memory deletion, preserves pause and never invokes a model',async t=>{
  const f=await workerFixture(t),file=path.join(f.root,'config.local.json'),c=JSON.parse(fs.readFileSync(file));
  c.provider='antigravity';c.antigravity={executable:process.execPath,timeoutMs:1000,model:''};c.memory={enabled:true};fs.writeFileSync(file,JSON.stringify(c));
  fs.mkdirSync(path.join(f.root,'state'),{recursive:true});
  const store=new MemoryStore(path.join(f.root,'state/memory.sqlite'));
  store.db.prepare('INSERT INTO facts(account,scope,subject,body,at,sources) VALUES(?,?,?,?,?,?)').run('10000','synthetic-scope','20001','合成偏好',Date.now(),'[]');store.close();
  const password=randomUUID();
  await setWebPassword(path.join(f.root,'state/web-auth.json'),password);const {app}=await createWebServer(f.root,f.supervisor);t.after(()=>app.close());
  const headers={host:'127.0.0.1:3210',origin:'http://127.0.0.1:3210'};
  const login=await app.inject({method:'POST',url:'/api/login',headers,payload:{password}});
  headers.cookie=login.headers['set-cookie'].split(';')[0];headers['x-csrf-token']=login.json().csrf;
  const request=(method,url,payload)=>app.inject({method,url,headers,payload});
  assert.equal((await request('POST','/api/runtime/start',{})).statusCode,200);await until(()=>f.actions.some(a=>a.action==='get_status'));await delay(30);
  for(const s of f.server.clients)s.send(JSON.stringify({post_type:'request',request_type:'friend',self_id:10000,user_id:20001,flag:'synthetic-flag',comment:'合成申请'}));
  let requests=[];for(let i=0;i<40;i++){requests=(await request('GET','/api/requests')).json();if(requests.length)break;await delay(20);}
  assert.equal(requests.length,1);assert.ok(!JSON.stringify(requests).includes('synthetic-flag'));
  await request('POST','/api/requests/'+requests[0].id,{approve:true});await request('POST','/api/requests/'+requests[0].id,{approve:true});assert.equal(f.actions.filter(a=>a.action==='set_friend_add_request').length,1);
  let memory=(await request('POST','/api/memory',{args:['list','person','20001']})).json();assert.equal(memory.data.facts.length,1);
  await request('POST','/api/memory',{args:['delete','fact',String(memory.data.facts[0].id)]});memory=(await request('POST','/api/memory',{args:['list','person','20001']})).json();assert.equal(memory.data.facts.length,0);
  const status=await f.supervisor.call('status');assert.equal(status.paused,true);assert.equal(status.reason,'MEMORY_MANAGEMENT');await request('POST','/api/runtime/stop',{});
});
test('SSE reconnect sends a fresh snapshot and logout revokes further streaming',async t=>{
  const f=await apiFixture(t);await f.app.listen({host:'127.0.0.1',port:0});const address=f.app.server.address();
  const connect=()=>new Promise((resolve,reject)=>{const req=http.get(`http://127.0.0.1:${address.port}/api/events`,{headers:{Cookie:f.cookie}},resolve);req.on('error',reject);});
  const data=r=>new Promise(resolve=>r.once('data',chunk=>resolve(chunk.toString())));
  let r=await connect();assert.match(await data(r),/event: snapshot/);r.destroy();
  f.supervisor.status={running:true,paused:true};r=await connect();assert.match(await data(r),/"running":true/);
  await f.authed('POST','/api/logout',{});const ended=new Promise(resolve=>r.once('end',resolve));f.supervisor.emit('change');await ended;
});
