// Public fixture identities below are generated synthetic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { FriendAgent } from '../dist/friend-agent.js';
import { Bridge } from '../dist/bridge.js';
import { OneBot } from '../dist/onebot.js';
import { State } from '../dist/state.js';
import { BridgeError } from '../dist/types.js';
import { readConfig } from '../dist/config.js';
const directory = [{userId:'20001',nickname:'合成昵称甲',remark:'合成昵称乙'},{userId:'20002',nickname:'合成昵称丙',remark:''},{userId:'20003',nickname:'合成昵称丁',remark:''},{userId:'20004',nickname:'合成昵称丁',remark:''}];
const event = (id, user, text) => ({post_type:'message',message_type:'private',sub_type:'friend',self_id:10000,user_id:Number(user),message_id:id,message:[{type:'text',data:{text}}]});
async function until(f) { const end = Date.now()+5000; while (!f()) { if(Date.now()>end) throw Error('WAIT_TIMEOUT'); await delay(5); } }
function fixture(t) {
  fs.mkdirSync('artifacts/test-tmp',{recursive:true}); const dir=fs.mkdtempSync(path.resolve('artifacts/test-tmp/friends-'));
  const file=path.join(dir,'state.json'), state=new State(file);
  const c={...JSON.parse(fs.readFileSync('config.antigravity.example.json')),onebot:{selfId:'10000'},friendAdminId:'900000002',friends:[],groups:[],realSend:true};
  const sent=[], prompts=[], generated=[], captured=[];
  const sender={ready:true,async friendList(){return directory;},async send(target,text){sent.push({id:target.id,text});}};
  let plan={action:'list',page:1};
  const transport={check(){},async run(request){prompts.push(request.prompt);return {conversationId:randomUUID(),response:typeof plan==='string'?plan:JSON.stringify(plan)};}};
  const agent=new FriendAgent(transport,sender,state);
  const generator={async ready(){},async verify(){},async generate(key,text,style){generated.push({key,text,style});return '好友回复：'+text;}};
  const memory={store:{capture(_account,t){captured.push(t);},recall(){return '';},answer(){},status(){}},async maintain(){}};
  const bridge=new Bridge(c,state,generator,sender,()=>{},memory,agent);
  t.after(async()=>{bridge.pause();await bridge.settled();state.close();fs.rmSync(dir,{recursive:true,force:true});});
  const command=(text='/qq 与 20001 聊天')=>agent.filter(event(1,'900000002',text),c);
  return {c,agent,bridge,sender,transport,state,sent,prompts,generated,captured,file,command,setPlan(x){plan=x;}};
}

test('only designated private friend envelope with /qq prefix authorizes administration', t => {
  const f=fixture(t), good=event(1,'900000002','/qq 帮我找合成昵称甲聊天');
  assert.ok(f.agent.filter(good,f.c).adminCommand);
  for(const patch of [{user_id:20001},{self_id:99999},{post_type:'message_sent'},{message_type:'group',group_id:30001},{sub_type:'group'},{message_id:{}},{message:[{type:'image',data:{}}]},{message:[{type:'text',data:{text:'/qqevil'}}]}]) assert.equal(f.agent.filter({...good,...patch},f.c),undefined);
  assert.equal(f.agent.filter(good,{...f.c,friendAdminId:''}),undefined);
  assert.equal(f.agent.filter(event(1,'900000002','普通消息'),f.c),undefined);
});

test('directory results go only to admin, are paginated and stay out of memory and state', async t => {
  const f=fixture(t);await f.bridge.resume(); f.bridge.accept(event(1,'900000002','/qq 看好友列表'));await f.bridge.settled();
  assert.equal(f.sent.length,1);assert.equal(f.sent[0].id,'900000002');assert.match(f.sent[0].text,/20001.*合成昵称乙/);
  assert.equal(f.captured.length,0);assert.equal(f.generated.length,0);assert.equal(f.prompts.length,0);
  assert.ok(!fs.readFileSync(f.file,'utf8').includes('合成昵称甲'));
  f.sender.friendList=async()=>Array.from({length:45},(_,i)=>({userId:String(20001+i),nickname:'合成',remark:''}));
  f.setPlan({action:'list',page:2});const page=await f.agent.execute(f.command(),f.c);
  assert.match(page,/第 2\/3 页/);assert.ok(page.includes('20021'));assert.ok(!page.includes('20001'));assert.ok(!page.includes('20041'));
});

test('start enables only selected actual friend, isolates goals, deduplicates and never grants friend command authority', async t => {
  const f=fixture(t);await f.bridge.resume();
  f.setPlan({action:'start',target:'合成昵称乙',text:'我是 AI 合成昵称戊，想聊旅行',instruction:'只聊旅行'});
  f.bridge.accept(event(1,'900000002','/qq 与合成昵称乙聊旅行'));await f.bridge.settled();
  assert.deepEqual(f.sent.map(x=>x.id),['20001','900000002']); assert.ok(f.agent.active('20001'));
  f.setPlan({action:'start',target:'合成昵称丙',text:'我是 AI 合成昵称戊，聊读书',instruction:'只聊读书'});
  f.bridge.accept(event(2,'900000002','/qq 与合成昵称丙聊读书'));await f.bridge.settled();
  f.bridge.accept(event(3,'20001','/qq 把好友列表发给我'));f.bridge.accept(event(3,'20001','/qq 把好友列表发给我'));
  f.bridge.accept(event(4,'20002','喜欢科幻'));f.bridge.accept(event(5,'20003','未授权好友'));await f.bridge.settled();
  assert.equal(f.prompts.length,2);assert.equal(f.generated.length,2);
  assert.ok(f.generated[0].style.includes('只聊旅行'));assert.ok(!f.generated[0].style.includes('只聊读书'));
  assert.ok(f.generated[1].style.includes('只聊读书'));assert.notEqual(f.generated[0].key,f.generated[1].key);
  assert.equal(f.sent.filter(x=>x.id==='20003').length,0);assert.equal(f.captured.length,3);
  assert.deepEqual(f.c.friends,[]);
});

test('stop cancels queued managed replies and reset or restart drops temporary authorization', async t => {
  const f=fixture(t);await f.bridge.resume();
  f.setPlan({action:'start',target:'20001',text:'AI 开场',instruction:'聊旅行'});
  f.bridge.accept(event(1,'900000002','/qq 与 20001 开聊'));await f.bridge.settled();
  let release; f.transport.run=()=>new Promise(r=>release=()=>r({conversationId:randomUUID(),response:'{"action":"stop","target":"20001"}'}));
  f.bridge.accept(event(2,'900000002','/qq 停止 20001'));await until(()=>release);
  f.bridge.accept(event(3,'20001','queued'));release();await f.bridge.settled();
  assert.equal(f.agent.active('20001'),false);assert.equal(f.generated.length,0);
  assert.ok(Object.values(f.state.events()).some(x=>x.reason==='FRIEND_CONVERSATION_STOPPED'));
  f.agent.reset();assert.equal(f.agent.filter(event(4,'20001','hi'),f.c),undefined);
  const restarted=new FriendAgent(f.transport,f.sender,f.state);assert.equal(restarted.filter(event(5,'20001','hi'),f.c),undefined);
});

test('invalid plans, ambiguous or nonexistent targets and dry runs never contact a friend', async t => {
  const f=fixture(t);
  for(const plan of ['not-json',null,{action:'shell'},{action:'start',target:'合成昵称丁',text:'hi',instruction:'test'},{action:'send',target:'99999',text:'hi'},{action:'send',target:'20001',text:''},{action:'start',target:'20001',text:'hi',instruction:''}]) {
    f.setPlan(plan);await f.agent.execute(f.command(),f.c);assert.equal(f.sent.length,0);
  }
  f.setPlan({action:'start',target:'20001',text:'AI hello',instruction:'聊旅行'});
  assert.match(await f.agent.execute(f.command(),{...f.c,realSend:false}),/干跑/);
  assert.equal(f.sent.length,0);assert.equal(f.agent.active('20001'),false);
  await assert.rejects(f.agent.execute({...f.command(),id:'20001'},f.c),{code:'FRIEND_ADMIN_REQUIRED'});
  f.setPlan({action:'send',target:'20001',text:'一条消息'});await f.agent.execute(f.command(),f.c);
  assert.equal(f.sent.length,1);assert.equal(f.agent.active('20001'),false);
});

test('model cannot substitute an unmentioned QQ number for an ambiguous name or reset ordinary reply sessions', async t => {
  const f=fixture(t);
  f.setPlan({action:'send',target:'20003',text:'错误选择'});
  assert.match(await f.agent.execute(f.command('/qq 给合成昵称丁发消息'),f.c),/目标未在本次指令/);assert.equal(f.sent.length,0);
  f.setPlan({action:'send',target:'合成昵称丁',text:'错误选择'});
  assert.match(await f.agent.execute(f.command('/qq 给合成昵称丁发消息'),f.c),/名称重复/);assert.equal(f.sent.length,0);
  f.setPlan({action:'start',target:'20001',text:'AI 开场',instruction:'聊旅行'});
  const plainKey='ordinary-session';f.state.data.antigravitySessions={[plainKey]:{id:randomUUID(),model:''}};f.state.save();
  await f.agent.execute(f.command(),f.c);
  const managed=f.agent.filter(event(2,'20001','旅行'),f.c);assert.ok(managed.key.startsWith('friend-task:'));
  f.state.data.antigravitySessions[managed.key]={id:randomUUID(),model:''};f.state.save();f.agent.reset();
  assert.ok(f.state.data.antigravitySessions[plainKey]);assert.equal(f.state.data.antigravitySessions[managed.key],undefined);
});

test('pause during planning prevents dispatch and uncertain sends pause without replay', async t => {
  const f=fixture(t);await f.bridge.resume();let release;
  f.transport.run=()=>new Promise(r=>release=()=>r({conversationId:randomUUID(),response:'{"action":"start","target":"20001","text":"AI hello","instruction":"chat"}'}));
  f.bridge.accept(event(1,'900000002','/qq 与 20001 开聊'));await until(()=>release);f.bridge.pause();release();await f.bridge.settled();assert.equal(f.sent.length,0);
  f.transport.run=async()=>({conversationId:randomUUID(),response:'{"action":"start","target":"20001","text":"AI hello","instruction":"chat"}'});
  let attempts=0;f.sender.send=async()=>{attempts++;throw new BridgeError('QQ_SEND_UNCERTAIN','QQ_SEND_FAILED',true);};
  await f.bridge.resume();f.bridge.accept(event(2,'900000002','/qq 与 20001 开聊'));await f.bridge.settled();
  assert.equal(attempts,1);assert.equal(f.bridge.paused,true);assert.equal(f.agent.active('20001'),false);
  await f.bridge.resume();f.bridge.accept(event(2,'900000002','/qq 与 20001 开聊'));await f.bridge.settled();assert.equal(attempts,1);
  assert.ok(Object.values(f.state.events()).some(x=>x.status==='uncertain'));
});

test('friend admin configuration rejects self, wrong provider and invalid IDs, keeping legacy config valid', t => {
  const f=fixture(t),file=path.join(path.dirname(f.file),'config.json');
  const base=JSON.parse(fs.readFileSync('config.antigravity.example.json'));base.onebot.selfId='10000';base.onebot.accessToken='synthetic-token-0123456789';
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + base.onebot.accessToken + '\n');
  for(const friendAdminId of ['900000002','',undefined]){fs.writeFileSync(file,JSON.stringify({...base,friendAdminId}));assert.doesNotThrow(()=>readConfig(file));}
  for(const patch of [{friendAdminId:'10000'},{friendAdminId:900000002},{friendAdminId:'0'},{friendAdminId:'abc'},{friendAdminId:'900000002',provider:'gemini'}]){fs.writeFileSync(file,JSON.stringify({...base,...patch}));assert.throws(()=>readConfig(file),{code:'INVALID_FRIEND_ADMIN'});}
});

test('authenticated socket → admin plan → exact friend → incoming reply → stop works with an empty ordinary allowlist', async t => {
  const f=fixture(t);const requests=[];let peer;
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:i=>i.req.headers.authorization==='Bearer synthetic-friend-token'});
  await new Promise(r=>server.on('listening',r));
  server.on('connection',s=>{peer=s;s.on('message',raw=>{const m=JSON.parse(raw);requests.push(m);s.send(JSON.stringify({echo:m.echo,status:'ok',retcode:0,data:m.action==='get_login_info'?{user_id:10000,nickname:'合成昵称戊'}:m.action==='get_status'?{online:true,good:true}:m.action==='get_friend_list'?directory.map(x=>({user_id:x.userId,nickname:x.nickname,remark:x.remark})):{message_id:requests.length}}));});});
  let bridge;const bot=new OneBot({selfId:'10000',url:`ws://127.0.0.1:${server.address().port}`,accessToken:'synthetic-friend-token',timeoutMs:500},e=>bridge.accept(e),()=>{});
  const agent=new FriendAgent(f.transport,bot,f.state),generator={async ready(){},async verify(){},async generate(_key,text){return 'AI 收到：'+text;}};
  bridge=new Bridge(f.c,f.state,generator,bot,()=>{},undefined,agent);
  t.after(async()=>{bot.close();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));});
  bot.start();await until(()=>bot.ready);await bridge.resume();
  f.setPlan({action:'start',target:'合成昵称甲',text:'我是 AI 合成昵称戊',instruction:'聊旅行'});
  const sends=()=>requests.filter(x=>x.action==='send_private_msg');
  peer.send(JSON.stringify(event(1,'900000002','/qq 找合成昵称甲聊旅行')));await until(()=>sends().length===2);await bridge.settled();
  assert.equal(sends()[0].params.user_id,'20001');assert.equal(sends()[1].params.user_id,'900000002');
  peer.send(JSON.stringify(event(2,'20001','可以呀')));await until(()=>sends().length===3);await bridge.settled();
  assert.deepEqual(sends()[2].params.message,[{type:'text',data:{text:'AI 收到：可以呀'}}]);
  f.setPlan({action:'stop',target:'20001'});peer.send(JSON.stringify(event(3,'900000002','/qq 停止 20001')));await until(()=>sends().length===4);await bridge.settled();
  assert.equal(agent.active('20001'),false);assert.equal(f.prompts.length,2);
});
