import fs from 'node:fs';
import path from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
process.chdir(path.resolve(import.meta.dirname,'..'));
try{
  if(!fs.existsSync('dist/web-server.js')||!fs.existsSync('web-dist/index.html'))throw Error('Run build-web.cmd first.');
  if(!fs.existsSync('state/web-auth.json')){
    const result=spawnSync(process.execPath,['scripts/setup-web.mjs'],{stdio:'inherit'});if(result.status!==0)process.exit(result.status??1);
  }
  let exists=false;
  try{const response=await fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(2000)});const data=await response.json();if(data.service!=='qq-bot-console')throw Error('PORT_3210_ALREADY_IN_USE');exists=true;}catch(e){if(e.message==='PORT_3210_ALREADY_IN_USE'||e instanceof SyntaxError)throw Error('PORT_3210_ALREADY_IN_USE');}
  if(!exists){
    const child=spawn(process.execPath,['dist/web-server.js'],{cwd:process.cwd(),detached:true,stdio:'ignore',windowsHide:true});child.on('error',()=>{});child.unref();
    let ready=false;
    for(let i=0;i<35;i++){
      try{const r=await fetch('http://127.0.0.1:3210/api/health',{signal:AbortSignal.timeout(500)});ready=(await r.json()).service==='qq-bot-console';if(ready)break;}catch{}await delay(250);
    }
    if(!ready)throw Error('WEB_SERVER_START_FAILED');
  }
  // The URL is constant; no account data or user input enters the shell.
  spawn('rundll32.exe',['url.dll,FileProtocolHandler','http://127.0.0.1:3210'],{detached:true,stdio:'ignore',windowsHide:true}).unref();
  console.log('QQ 管理台 http://127.0.0.1:3210');
}catch(e){console.error(e.message);process.exitCode=1;}
