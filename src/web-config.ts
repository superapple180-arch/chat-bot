import fs from 'node:fs';
import path from 'node:path';
import { createHash,randomUUID } from 'node:crypto';
import { readConfig, validateConfig } from './config.js';
import { saveOneBotToken, withoutToken, atomicPrivateWrite } from './secrets.js';
import { BridgeError } from './types.js';
const revision=(body:string)=>createHash('sha256').update(body).digest('hex');
export function publicConfig(root:string){
  const file=path.join(root,'config.local.json'),body=fs.readFileSync(file,'utf8'),config=readConfig(file);
  return {config:{...config,onebot:{...config.onebot,accessToken:''}},revision:revision(body),tokenConfigured:Boolean(config.onebot.accessToken)};
}
export function saveWebConfig(root:string,input:any){
  const file=path.join(root,'config.local.json'),body=fs.readFileSync(file,'utf8');
  if(input?.revision!==revision(body))throw new BridgeError('CONFIG_CHANGED_EXTERNALLY','CONFIG');
  const previous=readConfig(file),next=structuredClone(input.config);
  const keys=['provider','memory','qzone','antigravity','onebot','gemini','friends','groups','replyStyle','realSend','replyAll','groupAliases','friendAdminId','conversation','attachments','voice','media','maxQueue','maxMessageChars','maxReplyChars'];
  if(!next||typeof next!=='object'||Array.isArray(next)||Object.keys(next).some(k=>!keys.includes(k)))throw new BridgeError('INVALID_CONFIG_FIELDS','CONFIG');
  if(process.env.QQ_BOT_DESKTOP==='1'&&next.provider!=='antigravity')throw new BridgeError('DESKTOP_PROVIDER_NOT_SUPPORTED','CONFIG');
  if(!next.onebot?.accessToken)next.onebot={...next.onebot,accessToken:previous.onebot.accessToken};
  validateConfig(next);
  if(process.env.ONEBOT_ACCESS_TOKEN!==undefined&&next.onebot.accessToken!==previous.onebot.accessToken)throw new BridgeError('TOKEN_MANAGED_BY_ENVIRONMENT','CONFIG');
  const temp=path.join(root,`state/config-${randomUUID()}.tmp`);fs.mkdirSync(path.dirname(temp),{recursive:true});
  const envFile=path.join(root,'.env'),oldEnv=fs.existsSync(envFile)?fs.readFileSync(envFile,'utf8'):undefined;
  let secretSaved=false;
  try{
    fs.writeFileSync(temp,JSON.stringify(withoutToken(next),null,2),{mode:0o600,flag:'wx'});
    if(next.onebot.accessToken!==previous.onebot.accessToken){saveOneBotToken(root,next.onebot.accessToken);secretSaved=true;}
    atomicPrivateWrite(path.join(root,'state/config.local.backup.json'),JSON.stringify(withoutToken(JSON.parse(body)),null,2));fs.renameSync(temp,file);
  }catch(error){
    if(secretSaved){if(oldEnv===undefined)fs.rmSync(envFile,{force:true});else atomicPrivateWrite(envFile,oldEnv);}
    throw error;
  }finally{fs.rmSync(temp,{force:true});}
  return {restartRequired:['provider','memory','onebot','gemini','antigravity'].some(k=>JSON.stringify((previous as any)[k])!==JSON.stringify(next[k])),...publicConfig(root)};
}
