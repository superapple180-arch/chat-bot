import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { acquireLock } from '../dist/lock.js';
acquireLock();
const directory=JSON.parse(fs.readFileSync('config.local.json','utf8')).gemini.directory;
function call(input){const p=spawnSync('bin/GeminiDriver.exe',[],{input:JSON.stringify({directory,...input}),encoding:'utf8',windowsHide:true,timeout:25000});return JSON.parse(p.stdout.trim());}
function window(action){const p=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/window-state.ps1',action],{windowsHide:true,encoding:'utf8'});if(p.status!==0)throw Error('WINDOW_TEST_SETUP_FAILED');return JSON.parse(p.stdout);}
const report={at:new Date().toISOString(),realGemini:true,realQQ:false};
try{
  const background=window('background');let v=call({action:'observe'});report.backgroundRead={backgroundConfirmed:!background.foregroundGemini&&!background.minimized,readable:!v.error,minimized:v.minimized,busy:v.busy};
  window('minimize');v=call({action:'observe'});report.minimizedRead={readable:!v.error,minimized:v.minimized};
  const check=call({action:'send',url:v.url,mode:v.mode,fingerprint:v.fingerprint,text:'NEVER_SUBMITTED',marker:'QQBRIDGE_00000000000000000000000000000000'});
  report.minimizedSubmission={refused:check.error==='MINIMIZED_RESTORE_MANUALLY',submitted:check.submitted,code:check.error};
  if(!report.minimizedSubmission.refused||check.submitted)throw Error('MINIMIZATION_GUARD_FAILED');
}finally{window('restore');fs.writeFileSync('artifacts/window-policy.json',JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
