// Isolated UI acceptance fixture. Never connects to QQ or a real provider.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ChatStore } from '../dist/chat.js';
import { setWebPassword } from '../dist/web-auth.js';
import { createWebServer } from '../dist/web-server.js';
import { withoutToken } from '../dist/secrets.js';
const root=path.resolve('artifacts/web-preview');fs.mkdirSync(path.join(root,'state'),{recursive:true});
const c=JSON.parse(fs.readFileSync('config.antigravity.example.json'));c.onebot.selfId='10000';c.onebot.accessToken='synthetic-preview-token-0123456789';c.friends=['20001'];c.groups=['30001'];c.realSend=false;c.replyAll=false;
fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(root,'config.local.json'),JSON.stringify(withoutToken(c)));
await setWebPassword(path.join(root,'state/web-auth.json'),'synthetic-preview-password');
fs.cpSync('web-dist',path.join(root,'web-dist'),{recursive:true});
const chat=new ChatStore(path.join(root,'state/chat.sqlite'));
for(const [kind,id] of [['private','20001'],['group','30001']]){
  const t={kind,id,key:'synthetic',eventKey:'preview-'+id,userId:'20001',senderName:'合成验收消息',text:kind==='group'?'周末的活动安排在下午三点 可以帮忙提醒一下吗':'你好 我们来检查一下聊天工作台的长消息显示',at:Date.now()-120000};
  chat.capture('10000',t);chat.put('10000',t,'ai','好的 我会在这个会话中继续回答你的问题 这是一条仅用于界面检查的合成内容','dry-run');
}
chat.close();
class Preview extends EventEmitter{
  status={running:false,paused:true,onebotConnected:false,provider:'antigravity',queue:0,sessions:0,realSend:false};
  logs=[{at:new Date().toISOString(),category:'PREVIEW',code:'ISOLATED_SYNTHETIC_NO_QQ'}];
  async start(){this.status={...this.status,running:true,paused:true};this.emit('change');return this.status;}
  async stop(){this.status={...this.status,running:false,paused:true};this.emit('change');}
  async call(action){if(action==='pause')this.status.paused=true;if(action==='resume')this.status.paused=false;this.emit('change');if(action==='requests'||action==='friends')return [];if(action==='qzone')return {date:'2026-10-29',status:'not-requested'};if(action==='memory')return '{"facts":[],"history":[]}';return {};}
}
const {app}=await createWebServer(root,new Preview());await app.listen({host:'127.0.0.1',port:3210});console.log('ISOLATED_UI_PREVIEW http://127.0.0.1:3210');
process.on('SIGTERM',()=>void app.close());process.on('SIGINT',()=>void app.close());
