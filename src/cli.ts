import path from 'node:path';
import readline from 'node:readline';
import { createRuntime, type Runtime } from './runtime.js';
import { BridgeError } from './types.js';
process.chdir(path.resolve(import.meta.dirname,'..'));
const log=(category:string,code:string)=>console.log(`${new Date().toISOString()} [${category}] ${code}`);
let runtime:Runtime|undefined;
try{
  const app=runtime=createRuntime(log,false,process.argv.includes('--run'));
  console.log('命令：r 启动/恢复　p 暂停　s 状态　requests 查看联系人请求　approve 编号 同意　reject 编号 拒绝　adopt 接管　reload 重载　q 退出');
  console.log(process.argv.includes('--run')?'已请求连接成功后自动启动。错误或手动暂停后不会自动恢复。':'首次启动为暂停状态。未确认任务不会自动重试。');
  console.log(app.config.realSend?(app.config.replyAll?'真实发送已启用：回复全部好友和已加入群聊，无需提及。好友申请和入群邀请必须逐条授权。':app.config.friendAdminId?'真实发送已启用，按白名单及管理员指定的好友对话发送。':'真实发送已启用，仅回复配置白名单。'):'默认仅生成，不发送 QQ。');
  if(app.memory)console.log('长期记忆已启用：原文90天 重要记忆长期保存 同一账号跨私聊和群聊双向使用。memory help 查看管理命令');
  if(app.config.qzone?.enabled)console.log('QQ空间自主创作已启用：接受本机发布触发，每个北京时间自然日最多一条，好友可见；暂停时不发布。qzone-post.cmd 可触发或查看状态。');
  if(app.config.friendAdminId)console.log('好友管理已启用：指定管理员可私聊发送 /qq 指令，查看好友或让 AI 主动开聊。重启后主动对话需重新开启。');
  const rl=readline.createInterface({input:process.stdin,output:process.stdout});
  let closing=false,commands=Promise.resolve();
  const close=async()=>{if(closing)return;closing=true;rl.close();process.stdin.destroy();await app.close();};
  process.on('SIGINT',()=>void close());process.on('SIGTERM',()=>void close());
  rl.on('close',()=>{if(!closing)void close();});
  rl.on('line',line=>{
    line=line.trim();
    if(line==='p'){if(!closing)app.pause();return;}
    if(['adopt','reload'].includes(line)||line.startsWith('memory '))app.pause('MANAGEMENT_REQUESTED');
    commands=commands.then(async()=>{
      if(closing)return;
      if(/^(requests|approve|reject)(?:\s|$)/.test(line)){console.log(await app.bridge.requests.command(line,app.bridge.config));return;}
      if(line.startsWith('memory ')){console.log(await app.memoryCommand(line.split(/\s+/).slice(1)));return;}
      switch(line){
        case 'r':await app.bridge.resume();break;
        case 's':console.log(JSON.stringify(app.status()));break;
        case 'reload':await app.reload();break;
        case 'adopt':await app.adopt();break;
        case 'q':await close();break;
        default:log('CONSOLE','UNKNOWN_COMMAND');
      }
    }).catch(e=>log(e instanceof BridgeError?e.category:'INTERNAL',e instanceof BridgeError?e.code:'COMMAND_FAILED'));
  });
  process.on('unhandledRejection',()=>{log('INTERNAL','UNHANDLED_FAILURE');void close();});
}catch(e){log(e instanceof BridgeError?e.category:'STARTUP',e instanceof BridgeError?e.code:'STARTUP_FAILED');void runtime?.close();process.exitCode=1;}
