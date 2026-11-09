import { EventEmitter } from 'node:events';
import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { BridgeError } from './types.js';

export class Supervisor extends EventEmitter {
  private child?: ChildProcess;
  private starting?: Promise<unknown>;
  private pending=new Map<string,{resolve:(v:unknown)=>void;reject:(e:Error)=>void;timer:NodeJS.Timeout}>();
  status: Record<string,unknown>={running:false,paused:true,onebotConnected:false};
  logs: {at:string;category:string;code:string}[]=[];
  constructor(private root: string, private codeRoot = root, private nodeExecutable = process.execPath) { super(); }
  start(autoRun = false) {
    if(this.starting)return this.starting;
    if(this.child)throw new BridgeError('BRIDGE_ALREADY_RUNNING','STARTUP');
    const child=this.child=fork(path.join(this.codeRoot,'dist/web-worker.js'),[],{cwd:this.root,execPath:this.nodeExecutable,env:{...process.env,QQ_BOT_AUTO_RUN:autoRun?'1':'0'},stdio:['ignore','ignore','ignore','ipc']});
    this.starting=new Promise((resolve,reject)=>{
      let startupError:Error|undefined;
      const timer=setTimeout(()=>reject(new BridgeError('STARTUP_TIMEOUT','STARTUP')),15000);
      child.on('message',(m:any)=>{
        if(m.type==='ready'){clearTimeout(timer);this.status={...m.value,running:true};resolve(this.status);this.emit('change');}
        if(m.type==='startup-error'){clearTimeout(timer);startupError=new BridgeError(m.error,'STARTUP');}
        if(m.type==='status'){this.status={...m.value,running:true};this.emit('change');}
        if(m.type==='log'){
          this.logs.push({at:new Date().toISOString(),category:m.category,code:m.code});this.logs=this.logs.slice(-300);this.emit('change');
        }
        if(m.type==='result'){
          const p=this.pending.get(m.id);if(!p)return;clearTimeout(p.timer);this.pending.delete(m.id);
          if(m.error)p.reject(new BridgeError(m.error));else p.resolve(m.value);
        }
      });
      const ended=()=>{
        clearTimeout(timer);reject(startupError??new BridgeError('BRIDGE_EXITED','STARTUP'));
        if(this.child===child){this.child=undefined;this.status={running:false,paused:true,onebotConnected:false};}
        for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new BridgeError('BRIDGE_EXITED'));}this.pending.clear();this.emit('change');
      };
      child.once('error',ended);child.once('exit',ended);
    }).finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  call(action: string,payload?: unknown):Promise<any> {
    const child=this.child;
    if(!child?.connected)return Promise.reject(new BridgeError('BRIDGE_NOT_RUNNING','STARTUP'));
    const id=randomUUID();
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new BridgeError('OPERATION_TIMEOUT'));},310000);
      this.pending.set(id,{resolve,reject,timer});child.send({id,action,payload},error=>{if(error){clearTimeout(timer);this.pending.delete(id);reject(new BridgeError('BRIDGE_DISCONNECTED'));}});
    });
  }
  async stop() {
    if(this.starting)await this.starting.catch(()=>{});
    const child=this.child;if(!child)return;
    const exited=new Promise<void>(resolve=>child.once('exit',()=>resolve()));
    await this.call('stop');await exited;
  }
  disconnect() { if(this.child?.connected)this.child.disconnect(); }
}
