import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import staticFiles from '@fastify/static';
import { WebAuth } from './web-auth.js';
import { Supervisor } from './web-supervisor.js';
import { publicConfig,saveWebConfig } from './web-config.js';
import { readConfig } from './config.js';
import { ChatStore } from './chat.js';
import { BridgeError } from './types.js';
import { codePath } from './paths.js';
import { napcatLaunch, requireNapcat } from './napcat-launch.js';

export async function createWebServer(root:string,supervisor=new Supervisor(root)) {
  const app=Fastify({logger:false,bodyLimit:131072,requestTimeout:320000});
  await app.register(cookie);await app.register(rateLimit,{global:false});
  const auth=new WebAuth(path.join(root,'state/web-auth.json'));
  const accessFile=path.join(root,'state/web-access.json');
  const remoteOrigin=()=>{try{return JSON.parse(fs.readFileSync(accessFile,'utf8')).remoteOrigin as string|undefined;}catch{return undefined;}};
  const localPort=()=>{const address=app.server.address();return address&&typeof address==='object'?address.port:3210;};
  const origins=()=>[`http://127.0.0.1:${localPort()}`,`http://localhost:${localPort()}`,remoteOrigin()].filter(Boolean) as string[];
  app.addHook('onRequest',async(req,reply)=>{
    const allowed=origins(),host=req.headers.host;
    const selected=allowed.find(o=>new URL(o).host===host);
    if(!selected)return reply.code(403).send({code:'INVALID_HOST'});
    reply.headers({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});
    const route=req.routeOptions.url;
    if(!route?.startsWith('/api/'))return;
    reply.header('Cache-Control','no-store');
    if(req.headers.origin&&!allowed.includes(req.headers.origin))return reply.code(403).send({code:'INVALID_ORIGIN'});
    if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==selected)return reply.code(403).send({code:'INVALID_ORIGIN'});
    if(route==='/api/health'&&req.method==='GET')return;
    if(route==='/api/login'&&req.method==='POST')return;
    const session=auth.session(req.cookies.qq_session);
    if(!session)return reply.code(401).send({code:'UNAUTHORIZED'});
    if(!['GET','HEAD'].includes(req.method)&&req.headers['x-csrf-token']!==session.csrf)return reply.code(403).send({code:'INVALID_CSRF'});
  });
  app.setErrorHandler((e,_req,reply)=>{reply.code(e instanceof BridgeError?409:(e as any).statusCode===429?429:400).send({code:e instanceof BridgeError?e.code:(e as any).statusCode===429?'LOGIN_RATE_LIMIT':'REQUEST_FAILED'});});
  app.post('/api/login',{config:{rateLimit:{max:8,timeWindow:60000}}},async(req,reply)=>{
    const result=await auth.login((req.body as any)?.password);
    if(!result)return reply.code(401).send({code:'INVALID_PASSWORD'});
    const remote=remoteOrigin();
    reply.setCookie('qq_session',result.token,{path:'/',httpOnly:true,sameSite:'strict',secure:Boolean(remote&&new URL(remote).host===req.headers.host),maxAge:12*3600});
    return {csrf:result.csrf};
  });
  app.get('/api/health',async()=>({service:'qq-bot-console'}));
  app.post('/api/shutdown',async()=>{setTimeout(()=>void app.close(),50);return {ok:true};});
  app.get('/api/session',async req=>({csrf:auth.session(req.cookies.qq_session)!.csrf}));
  app.post('/api/logout',async(req,reply)=>{auth.logout(req.cookies.qq_session!);reply.clearCookie('qq_session',{path:'/'});return {ok:true};});
  app.get('/api/status',async()=>supervisor.status);
  let control=Promise.resolve<unknown>(undefined);
  let controlEpoch=0;
  const serial=(run:()=>Promise<unknown>)=>{const next=control.then(run);control=next.catch(()=>{});return next;};
  app.post('/api/runtime/:action',async(req)=>{
    const {action}=req.params as {action:string};
    if(['pause','stop','restart','reload','adopt'].includes(action))controlEpoch++;
    if(action==='pause')return supervisor.call('pause').then(()=>({ok:true}));
    if(!['start','stop','restart','resume','reload','adopt'].includes(action))throw new BridgeError('UNKNOWN_ACTION','CONFIG');
    const epoch=controlEpoch;
    return serial(async()=>{
      if(action==='resume'&&epoch!==controlEpoch)throw new BridgeError('CONTROL_CANCELLED','STARTUP');
      if(action==='start')return supervisor.start();
      if(action==='stop'){await supervisor.stop();return {ok:true};}
      if(action==='restart'){await supervisor.stop();return supervisor.start();}
      await supervisor.call(action);return {ok:true};
    });
  });
  app.get('/api/config',async()=>publicConfig(root));
  app.put('/api/config',async req=>{controlEpoch++;return serial(async()=>{
    if(supervisor.status.running)await supervisor.call('pause');
    return saveWebConfig(root,req.body);
  });});
  const readChat=(fn:(store:ChatStore,account:string)=>unknown)=>{
    const file=path.join(root,'state/chat.sqlite');if(!fs.existsSync(file))return [];
    const store=new ChatStore(file,true);try{return fn(store,readConfig(path.join(root,'config.local.json')).onebot.selfId);}finally{store.close();}
  };
  app.get('/api/conversations',async()=>readChat((s,a)=>s.conversations(a)));
  app.get('/api/messages',async req=>{
    const q=req.query as any;
    if(!['private','group'].includes(q.kind)||!/^[1-9]\d*$/.test(q.target)||q.before!==undefined&&!/^\d{1,16}$/.test(q.before))throw new BridgeError('INVALID_CONVERSATION','CONFIG');
    return readChat((s,a)=>s.messages(a,q.kind,q.target,q.before?Number(q.before):undefined));
  });
  app.post('/api/messages',async req=>supervisor.call('manual',req.body));
  app.get('/api/friends',async()=>supervisor.call('friends'));
  app.post('/api/friends/dispatch',async req=>supervisor.call('dispatch',req.body));
  app.get('/api/requests',async()=>supervisor.call('requests'));
  app.post('/api/requests/:id',async req=>{
    const id=(req.params as any).id,approve=(req.body as any)?.approve;
    if(!/^[a-f0-9]{16}$/.test(id)||typeof approve!=='boolean')throw new BridgeError('INVALID_REQUEST_DECISION','CONFIG');
    return {message:await supervisor.call('decision',{id,approve})};
  });
  app.post('/api/memory',async req=>{
    const args=(req.body as any)?.args;
    if(!Array.isArray(args)||args.length>5||args.some(x=>typeof x!=='string'||x.length>1000))throw new BridgeError('MEMORY_COMMAND_INVALID','MEMORY');
    controlEpoch++;
    const result=await supervisor.call('memory',{args});try{return {data:JSON.parse(result)};}catch{return {message:result};}
  });
  app.get('/api/qzone',async()=>supervisor.call('qzone'));
  app.post('/api/qzone',async()=>supervisor.call('qzone-trigger'));
  app.get('/api/diagnostics',async()=>({logs:supervisor.logs,tailscaleInstalled:process.platform==='win32'?fs.existsSync('C:/Program Files/Tailscale/tailscale.exe'):process.platform==='darwin'?fs.existsSync('/Applications/Tailscale.app/Contents/MacOS/Tailscale'):fs.existsSync('/usr/bin/tailscale')||fs.existsSync('/usr/local/bin/tailscale'),remoteOrigin:remoteOrigin()??null,napcatUrl:'http://127.0.0.1:6099',localOnly:true}));
  let napcat:ReturnType<typeof spawn>|undefined;
  const startNapcat=async()=>{
    if(napcat)throw new BridgeError('NAPCAT_START_ALREADY_REQUESTED','STARTUP');
    const listening=await new Promise<boolean>(resolve=>{
      const socket=net.connect({host:'127.0.0.1',port:6099});
      const finish=(value:boolean)=>{socket.destroy();resolve(value);};
      socket.setTimeout(600);socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.once('timeout',()=>finish(false));
    });
    if(listening||supervisor.status.onebotConnected)throw new BridgeError('NAPCAT_ALREADY_RUNNING','STARTUP');
    const launch=napcatLaunch(root,readConfig(path.join(root,'config.local.json')));
    try { requireNapcat(launch.command); } catch { throw new BridgeError('NAPCAT_NOT_INSTALLED','STARTUP'); }
    napcat=spawn(launch.command,launch.args,{cwd:launch.cwd,env:launch.env,stdio:'ignore',windowsHide:true});
    napcat.once('error',()=>{napcat=undefined;});napcat.once('exit',()=>{napcat=undefined;});return {ok:true};
  };
  app.post('/api/napcat/start',async req=>{
    if(req.headers.host!==`127.0.0.1:${localPort()}`&&req.headers.host!==`localhost:${localPort()}`)throw new BridgeError('LOCAL_ACTION_ONLY','CONFIG');
    return startNapcat();
  });
  const streams=new Set<import('node:http').ServerResponse>();
  app.get('/api/events',async(req,reply)=>{
    reply.hijack();reply.raw.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Accel-Buffering':'no'});streams.add(reply.raw);
    const send=()=>{if(!auth.session(req.cookies.qq_session)){reply.raw.end();return;}reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(supervisor.status)}\n\n`);};
    send();supervisor.on('change',send);const timer=setInterval(send,15000);
    req.raw.on('close',()=>{clearInterval(timer);supervisor.off('change',send);streams.delete(reply.raw);});
  });
  const staticRoot=process.env.QQ_BOT_CODE_ROOT ? codePath('web-dist') : path.join(root,'web-dist');
  if(fs.existsSync(staticRoot)){
    await app.register(staticFiles,{root:staticRoot});
    app.setNotFoundHandler((req,reply)=>req.url.startsWith('/api/')?reply.code(404).send({code:'NOT_FOUND'}):reply.sendFile('index.html'));
  }
  app.addHook('preClose',async()=>{for(const stream of streams)stream.end();await supervisor.stop();napcat?.kill();});
  return {app,supervisor,startNapcat};
}
if(process.argv[1]&&path.resolve(process.argv[1])===path.resolve(import.meta.filename)){
  const root=process.env.QQ_BOT_DATA_ROOT ?? path.resolve(import.meta.dirname,'..');process.chdir(root);
  if(!fs.existsSync('state/web-auth.json')){console.error('WEB_PASSWORD_NOT_CONFIGURED: Run setup-web.cmd');process.exitCode=1;}
  else{
    const {app,supervisor}=await createWebServer(root,new Supervisor(root,process.env.QQ_BOT_CODE_ROOT ?? root));
    process.on('SIGINT',()=>void app.close());process.on('SIGTERM',()=>void app.close());
    process.on('exit',()=>supervisor.disconnect());
    await app.listen({host:'127.0.0.1',port:3210});console.log('QQ 管理台 http://127.0.0.1:3210');
  }
}
