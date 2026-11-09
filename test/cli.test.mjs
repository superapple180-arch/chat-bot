import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
async function until(f){const end=Date.now()+5000;while(!f()){if(Date.now()>end)throw Error('WAIT_TIMEOUT');await delay(10);}}
for (const [provider, autoRun, memory] of [['gemini', false, false], ['antigravity', false, false], ['antigravity', true, false], ['antigravity', false, true]]) test(`real CLI (${provider}, autoRun=${autoRun}, memory=${memory}) reports status, blocks second instance, exits and releases lock without calling provider`,async t=>{
  fs.mkdirSync('artifacts/test-tmp',{recursive:true});const dir=fs.mkdtempSync(path.resolve('artifacts/test-tmp/cli-'));
  fs.cpSync('dist',path.join(dir,'dist'),{recursive:true});fs.writeFileSync(path.join(dir,'package.json'),'{"type":"module"}');
  if(autoRun){fs.mkdirSync(path.join(dir,'scripts'));fs.copyFileSync('scripts/antigravity-tools-hook.mjs',path.join(dir,'scripts/antigravity-tools-hook.mjs'));}
  const server=new WebSocketServer({host:'127.0.0.1',port:0});await new Promise(r=>server.on('listening',r));
  const identityGroups=[];
  server.on('connection',s=>s.on('message',raw=>{const m=JSON.parse(raw);assert.ok(['get_status','get_login_info','get_group_member_info'].includes(m.action));if(m.action==='get_group_member_info')identityGroups.push(m.params.group_id);s.send(JSON.stringify({echo:m.echo,status:'ok',retcode:0,data:m.action==='get_login_info'?{user_id:10000,nickname:'合成昵称'}:m.action==='get_group_member_info'?{user_id:10000,group_id:m.params.group_id,card:'合成名片'}:{online:true,good:true}}));}));
  const c=JSON.parse(fs.readFileSync('config.example.json'));c.onebot.selfId='10000';c.onebot.accessToken='synthetic-cli-token-0123456789';c.onebot.url=`ws://127.0.0.1:${server.address().port}`;
  c.provider=provider;if(provider==='antigravity')c.antigravity={executable:process.execPath,timeoutMs:1000,model:''};
  if(memory)c.memory={enabled:true};
  fs.writeFileSync(path.join(dir, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(dir,'config.local.json'),JSON.stringify(c));
  const child=spawn(process.execPath,[path.join(dir,'dist/cli.js'),...(autoRun?['--run']:[])],{cwd:dir,windowsHide:true});let out='';child.stdout.on('data',x=>out+=x);child.stderr.resume();
  const closed=new Promise(r=>child.on('close',r));
  t.after(async()=>{child.kill();for(const s of server.clients)s.terminate();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
  await until(()=>out.includes('[ONEBOT] CONNECTED'));assert.ok(out.includes('[PAUSED]'));
  if(autoRun){await until(()=>out.includes('[RUNNING] DRY_RUN'));t.diagnostic('first CLI explicitly auto-started after authenticated connection');}
  else {t.diagnostic('first CLI connected and paused');assert.ok(!out.includes('[RUNNING]'));}
  const second=spawn(process.execPath,[path.join(dir,'dist/cli.js')],{cwd:dir,windowsHide:true});let secondOut='';second.stdout.on('data',x=>secondOut+=x);second.stderr.resume();
  let secondDone=false;let secondExit;second.on('close',code=>{secondDone=true;secondExit=code;});
  try{await until(()=>secondDone);}catch{second.kill();throw Error('SECOND_INSTANCE_STUCK: '+secondOut);}
  assert.equal(secondExit,1);assert.ok(secondOut.includes('BRIDGE_ALREADY_RUNNING'));t.diagnostic('second CLI refused');
  if(provider==='antigravity'&&!autoRun&&!memory){
    c.groups=['30001'];c.groupAliases=['小蓝'];fs.writeFileSync(path.join(dir, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(path.join(dir,'config.local.json'),JSON.stringify(c));
    child.stdin.write('reload\n');await until(()=>out.includes('RELOADED_REMAIN_PAUSED'));
    assert.deepEqual(identityGroups,['30001']);assert.ok(!out.includes('[RUNNING]'));
  }
  let firstDone=false;closed.then(()=>firstDone=true);child.stdin.write((memory?'memory list person 20001\n':'')+'p\ns\nq\n');
  try{await until(()=>firstDone);}catch{throw Error('QUIT_STUCK: '+out);}
  assert.equal(await closed,0);t.diagnostic('first CLI exited');
  assert.ok(out.includes('USER_PAUSED'));assert.ok(out.includes('"paused":true'));assert.ok(out.includes('"realSend":false'));
  assert.ok(out.includes(`"provider":"${provider}"`));
  if(memory){assert.ok(out.includes('MANAGEMENT_COMPLETE_REMAIN_PAUSED'));assert.ok(fs.existsSync(path.join(dir,'state/memory.sqlite')));}
  assert.ok(!fs.existsSync(path.join(dir,'state/bridge.lock')));assert.ok(!out.includes(c.onebot.accessToken));
});
