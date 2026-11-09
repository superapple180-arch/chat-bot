import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { readConfig } from './config.js';
import { State } from './state.js';
import { UiaDesktop } from './desktop.js';
import { Gemini } from './gemini.js';
import { Antigravity, AntigravityProcess } from './antigravity.js';
import { OneBot } from './onebot.js';
import { Bridge, type Logger } from './bridge.js';
import { BridgeError } from './types.js';
import { MemoryService, MemoryStore } from './memory.js';
import { memoryCommand } from './memory-command.js';
import { acquireLock } from './lock.js';
import { FriendAgent } from './friend-agent.js';
import { Qzone, beijingDate } from './qzone.js';
import { ChatStore } from './chat.js';
import { Voice } from './voice.js';
import { Media } from './media.js';
import { dailySchedule } from './daily-schedule.js';

export function createRuntime(log: Logger, workbench = false, autoRun = false) {
  const unlock = acquireLock();
  let state: State | undefined, memory: MemoryService | undefined, bot: OneBot | undefined, chat: ChatStore | undefined;
  try {
    const config = readConfig('config.local.json');
    const antigravity = config.provider === 'antigravity';
    state = new State(antigravity ? 'state/antigravity.json' : 'state/bridge.json');
    const storage = state;
    const transport = antigravity ? new AntigravityProcess(config.antigravity!) : undefined;
    if (config.memory?.enabled) memory = new MemoryService(new MemoryStore('state/memory.sqlite'),transport!,log);
    if (workbench) chat = new ChatStore();
    const generator = antigravity ? new Antigravity(transport!,state,config.antigravity!.model) : new Gemini(new UiaDesktop(config.gemini.directory),state,config.gemini.timeoutMs);
    let bridge: Bridge;
    const pause = (reason?: string) => { autoRun = false; bridge.pause(reason); };
    bot = new OneBot(config.onebot,event=>bridge?.accept(event),(ready,reason)=>{
      log('ONEBOT',reason);
      if (ready && autoRun && bridge) {
        autoRun = false;
        if (fs.existsSync('state/pause.flag')) { fs.rmSync('state/pause.flag'); pause(); }
        else void bridge.resume().catch(e=>log('STARTUP',e instanceof BridgeError ? e.code : 'AUTO_START_FAILED'));
      }
      if (!ready && bridge?.active) pause('QQ_DISCONNECTED_DURING_TASK');
    },config.groups,code=>log('ONEBOT',code));
    const sender = bot;
    const friendAgent = transport ? new FriendAgent(transport,bot,state) : undefined;
    const qzone = transport ? new Qzone(state,transport,bot,log) : undefined;
    const voice = new Voice();
    voice.cleanup();
    const media = new Media();
    if (config.media?.enabled) media.cleanup();
    bridge = new Bridge(config,state,generator,bot,log,memory,friendAgent,qzone,chat,voice,media);
    let closing: Promise<void> | undefined, cleanupAt = Date.now();
    const timer = setInterval(()=>{
      if (fs.existsSync('state/pause.flag')) { fs.rmSync('state/pause.flag'); pause(); }
      if (process.env.QQ_BOT_DESKTOP === '1') {
        try {
          dailySchedule(`state/qzone-schedule-${config.onebot.selfId}.json`, new Date(), Boolean(bridge.config.qzone?.enabled), bridge.accepting && !bridge.paused && sender.ready, () => {
            const date = beijingDate(), key = `${bridge.config.realSend ? '' : 'dry-run:'}${config.onebot.selfId}:${date}`;
            if (!storage.data.qzonePosts?.[key]) {
              const temp = 'state/qzone-request.tmp';
              fs.writeFileSync(temp, JSON.stringify({ selfId: config.onebot.selfId, date }), { mode: 0o600 });
              fs.renameSync(temp, 'state/qzone-request.json');
            }
          });
        } catch { pause('SCHEDULE_STORAGE_FAILED'); }
      }
      if (Date.now()-cleanupAt > 86400000) { try { chat?.cleanup(); voice.cleanup(); if (bridge.config.media?.enabled) media.cleanup(); cleanupAt=Date.now(); } catch { pause('STORAGE_CLEANUP_FAILED'); } }
      void bridge.idleCheck().catch(()=>pause('INTERNAL_FAILURE'));
    },1000);
    bot.start(); log('PAUSED',state.data.pauseReason || 'STARTUP_PAUSED');
    return {
      bridge, config, bot, state, memory, pause,
      status() { return {provider:config.provider ?? 'gemini',paused:bridge.paused,reason:storage.data.pauseReason,onebotConnected:sender.ready,active:bridge.active,memoryEnabled:bridge.config.memory?.enabled??false,attachmentsEnabled:bridge.config.attachments?.enabled??false,voiceEnabled:bridge.config.voice?.enabled??false,mediaEnabled:bridge.config.media?.enabled??false,mediaOnline:bridge.config.media?.online??false,qzoneEnabled:bridge.config.qzone?.enabled??false,queue:bridge.pending,task:bridge.task,replyAll:bridge.config.replyAll ?? false,pendingRequests:storage.pendingRequests(config.onebot.selfId),friends:bridge.config.friends.length,groups:bridge.config.groups.length,realSend:bridge.config.realSend,sessions:Object.keys(antigravity ? storage.data.antigravitySessions ?? {} : storage.data.sessions).length}; },
      async reload() {
        pause('CONFIG_RELOAD'); await bridge.settled(); const next = readConfig('config.local.json');
        if (['memory','onebot','gemini','provider','antigravity'].some(k=>JSON.stringify(next[k as keyof typeof next])!==JSON.stringify(config[k as keyof typeof config]))) throw new BridgeError('CONNECTION_CONFIG_RESTART_REQUIRED','CONFIG');
        await sender.refreshIdentity(next.groups);
        if (next.friendAdminId !== bridge.config.friendAdminId) friendAgent?.reset();
        if (JSON.stringify(next.conversation)!==JSON.stringify(bridge.config.conversation) || JSON.stringify(next.media)!==JSON.stringify(bridge.config.media)) { storage.data.sessions={}; storage.data.antigravitySessions={}; storage.save(); }
        bridge.conversation.clear(); bridge.config=next; log('CONFIG','RELOADED_REMAIN_PAUSED');
      },
      async adopt() { pause('ADOPT_REQUESTED'); await bridge.settled(); await generator.ready(true); log('GENERATOR','ADOPTED_REMAIN_PAUSED'); },
      async memoryCommand(args: string[]) {
        if (!memory) throw new BridgeError('MEMORY_NOT_ENABLED','MEMORY');
        pause('MEMORY_MANAGEMENT'); await bridge.settled(); bridge.conversation.clear();
        const output: string[]=[];
        memoryCommand(memory.store,config.onebot.selfId,storage,args,s=>output.push(s));
        log('MEMORY','MANAGEMENT_COMPLETE_REMAIN_PAUSED'); return output.join('\n');
      },
      requests() { return Object.entries(storage.requests(config.onebot.selfId)).map(([id,{flag: _flag,...r}])=>({id,...r})); },
      qzoneStatus() {
        const date = beijingDate(), prefix=bridge.config.realSend ? '' : 'dry-run:';
        return {date,enabled:bridge.config.qzone?.enabled ?? false,...(storage.data.qzonePosts?.[`${prefix}${config.onebot.selfId}:${date}`] ?? {status:fs.existsSync('state/qzone-request.json') ? 'queued' : 'not-requested'})};
      },
      triggerQzone() {
        if (!bridge.config.qzone?.enabled) throw new BridgeError('QZONE_NOT_ENABLED','CONFIG');
        if (bridge.paused) throw new BridgeError('PAUSED');
        const date=beijingDate(), key=`${bridge.config.realSend ? '' : 'dry-run:'}${config.onebot.selfId}:${date}`;
        if (storage.data.qzonePosts?.[key]) return;
        const temp=`state/qzone-request.${randomUUID()}.tmp`;
        fs.writeFileSync(temp,JSON.stringify({selfId:config.onebot.selfId,date}),{mode:0o600,flag:'wx'}); fs.renameSync(temp,'state/qzone-request.json');
      },
      close() { return closing ??= (async()=>{ clearInterval(timer); pause('SHUTDOWN'); sender.close(); await bridge.settled(); memory?.store.close(); chat?.close(); storage.close(); unlock(); })(); }
    };
  } catch(e) { bot?.close(); memory?.store.close(); chat?.close(); state?.close(); unlock(); throw e; }
}
export type Runtime = ReturnType<typeof createRuntime>;
