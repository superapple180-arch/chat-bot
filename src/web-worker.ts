import path from 'node:path';
import { createRuntime } from './runtime.js';
import { BridgeError } from './types.js';
process.chdir(process.env.QQ_BOT_DATA_ROOT ?? path.resolve(import.meta.dirname,'..'));
const post=(message:object)=>{if(process.connected)process.send?.(message,undefined,undefined,()=>{});};
try {
  const app=createRuntime((category,code)=>post({type:'log',category,code}),true,process.env.QQ_BOT_AUTO_RUN === '1');
  let queue=Promise.resolve(),closing=false,commandEpoch=0;
  const timer=setInterval(()=>post({type:'status',value:app.status()}),750);
  const close=async()=>{if(closing)return;closing=true;clearInterval(timer);await app.close();if(process.connected)process.disconnect();};
  process.on('disconnect',()=>{if(!closing){app.pause('MANAGER_DISCONNECTED');void close();}});
  process.on('SIGTERM',()=>void close()); process.on('SIGINT',()=>void close());
  process.on('message',(m:any)=>{
    if(['pause','stop','reload','adopt','memory'].includes(m?.action))commandEpoch++;
    if(m?.action==='pause')app.pause();
    if(m?.action==='stop')app.pause('SHUTDOWN');
    const epoch=commandEpoch;
    queue=queue.then(async()=>{
      if(closing&&m?.action!=='stop')throw new BridgeError('SHUTDOWN','STARTUP');
      if(m?.action==='resume'&&epoch!==commandEpoch)throw new BridgeError('CONTROL_CANCELLED','STARTUP');
      let value:unknown;
      switch(m?.action){
        case 'status':value=app.status();break;
        case 'drain':value=await app.bridge.finishAndPause();break;
        case 'pause':break;
        case 'resume':await app.bridge.resume();break;
        case 'adopt':await app.adopt();break;
        case 'reload':await app.reload();break;
        case 'stop':closing=true;clearInterval(timer);await app.close();break;
        case 'manual':value=await app.bridge.manualSend(m.payload.kind,m.payload.target,m.payload.text,m.payload.requestId);break;
        case 'friends':value=await app.bot.friendList();break;
        case 'dispatch':value=app.bridge.ownerDispatch(m.payload.command,m.payload.requestId);break;
        case 'requests':value=app.requests();break;
        case 'decision':value=await app.bridge.requests.command(`${m.payload.approve?'approve':'reject'} ${m.payload.id}`,app.bridge.config);break;
        case 'memory':value=await app.memoryCommand(m.payload.args);break;
        case 'qzone':value=app.qzoneStatus();break;
        case 'qzone-trigger':app.triggerQzone();value=app.qzoneStatus();break;
        default:throw new BridgeError('UNKNOWN_ACTION','CONFIG');
      }
      post({type:'result',id:m.id,value});
      if(m.action==='stop'&&process.connected)process.disconnect();
    }).catch(e=>{post({type:'result',id:m.id,error:e instanceof BridgeError?e.code:'COMMAND_FAILED'});});
  });
  post({type:'ready',value:app.status()});
}catch(e){post({type:'startup-error',error:e instanceof BridgeError?e.code:'STARTUP_FAILED'});process.exitCode=1;if(process.connected)process.disconnect();}
