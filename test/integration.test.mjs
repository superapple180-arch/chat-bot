// Public fixture identities below are generated synthetic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { State } from '../dist/state.js';
import { Gemini } from '../dist/gemini.js';
import { Bridge } from '../dist/bridge.js';
import { OneBot } from '../dist/onebot.js';
async function until(f) { const end=Date.now()+5000; while(!f()) { if(Date.now()>end) throw Error('WAIT_TIMEOUT'); await delay(5); } }
test('full socket → filter → queue → sessions → desktop → original socket target, including duplicate and no-mention',async t=>{
  fs.mkdirSync('artifacts/test-tmp',{recursive:true}); const dir=fs.mkdtempSync(path.resolve('artifacts/test-tmp/integration-'));
  const config=JSON.parse(fs.readFileSync('config.example.json'));
  config.onebot.selfId='10000'; config.onebot.accessToken='synthetic-token-0123456789'; config.onebot.timeoutMs=500;
  config.friends=['20001']; config.groups=['30001', '30002']; config.realSend=true;
  const state=new State(path.join(dir,'state.json')); let view={url:'https://gemini.google.com/app/personal',mode:'Flash',fingerprint:'first',hasDraft:false,busy:false,minimized:false,userCount:0,responseCount:0,text:'',marker:'',submitted:false};
  let serial=0; const histories=new Map(); let submitted=0;
  const desktop={async call(input){
    if(input.action==='observe'||input.action==='check') return {...view};
    assert.equal(input.fingerprint,view.fingerprint);
    if(input.action==='new') view={...view,url:'https://gemini.google.com/app',fingerprint:'new-'+ ++serial,userCount:0,responseCount:0};
    else {
      submitted++; const url=input.url.endsWith('/app')?'https://gemini.google.com/app/test'+ ++serial:input.url;
      const text=JSON.parse(input.text.split('聊天内容（JSON 字符串）：\n')[1].split('\n本轮关联编号：')[0]);
      const history=histories.get(url)??[]; history.push(text);histories.set(url,history);
      view={...view,url,fingerprint:'answer-'+ ++serial,userCount:history.length,responseCount:history.length,text:history.join('|'),marker:input.marker,submitted:true};
    }
    return {...view};
  }};
  const server=new WebSocketServer({host:'127.0.0.1',port:0,verifyClient:i=>i.req.headers.authorization===`Bearer ${config.onebot.accessToken}`});
  await new Promise(r=>server.on('listening',r)); config.onebot.url=`ws://127.0.0.1:${server.address().port}`;
  let peer; const sends=[];
  server.on('connection',s=>{peer=s;s.on('message',raw=>{const m=JSON.parse(raw);if(m.action.startsWith('send_'))sends.push(m);s.send(JSON.stringify({echo:m.echo,status:'ok',retcode:0,data:m.action==='get_login_info'?{user_id:10000,nickname:'合成昵称甲'}:m.action==='get_status'?{online:true,good:true}:m.action==='get_group_member_info'?{user_id:10000,group_id:m.params.group_id,card:m.params.group_id==='30001'?'一群助手':'二群助手'}:{message_id:sends.length}}));});});
  let bridge;const bot=new OneBot(config.onebot,e=>bridge.accept(e),()=>{},config.groups);
  bridge=new Bridge(config,state,new Gemini(desktop,state,500),bot,()=>{});
  t.after(async()=>{bridge.pause();await bridge.settled();bot.close();for(const c of server.clients)c.terminate();await new Promise(r=>server.close(r));state.close();fs.rmSync(dir,{recursive:true,force:true});});
  bot.start();await until(()=>bot.ready);await bridge.resume();
  const make=(i,group=false)=>({post_type:'message',self_id:10000,user_id:20001,message_id:i,message_type:group?'group':'private',sub_type:'friend',...(group?{group_id:30001}:{}),message:[...(group?[{type:'at',data:{qq:'10000'}}]:[]),{type:'text',data:{text:(group?'G':'P')+'-'+i}}]});
  for(let i=1;i<=10;i++){const e=make(i,i%2===0);peer.send(JSON.stringify(e));peer.send(JSON.stringify(e));}
  peer.send(JSON.stringify({...make(11,true),message:[{type:'text',data:{text:'UNMENTIONED'}}]}));
  peer.send(JSON.stringify({...make(12),user_id:10000}));
  peer.send(JSON.stringify({...make(13),user_id:99999}));
  await until(()=>sends.length===10);await bridge.settled();
  assert.equal(submitted,10);assert.equal(histories.size,2);assert.equal(sends.length,10);
  for(let i=0;i<10;i++){
    const group=i%2===1;const s=sends[i];assert.equal(s.action,group?'send_group_msg':'send_private_msg');
    assert.equal(s.params[group?'group_id':'user_id'],group?'30001':'20001');
    const text=s.params.message[0].data.text;assert.ok(text.split('|').every(x=>x.startsWith(group?'G-':'P-')));
  }
  assert.equal(Object.values(state.events()).filter(x=>x.status==='sent').length,10);
  const keyword = { ...make(14,true), message: [{ type:'text', data:{text:'有人见到合成昵称甲吗'} }] };
  peer.send(JSON.stringify(keyword)); peer.send(JSON.stringify(keyword));
  peer.send(JSON.stringify({ ...make(15,true), message:[{type:'text',data:{text:'二群助手'}}] }));
  peer.send(JSON.stringify({ ...make(16,true), group_id:30002, message:[{type:'at',data:{qq:'20002'}},{type:'text',data:{text:'二群助手来了吗'}}] }));
  await until(()=>sends.length===12); await bridge.settled();
  assert.equal(submitted,12); assert.equal(histories.size,3);
  assert.equal(sends[10].params.group_id,'30001'); assert.equal(sends[11].params.group_id,'30002');
  assert.ok(sends[11].params.message[0].data.text.includes('@20002'));
  assert.equal(Object.values(state.events()).filter(x=>x.status==='sent').length,12);
});
