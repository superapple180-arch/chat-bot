import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn,execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec=promisify(execFile),root=path.resolve(import.meta.dirname,'..');process.chdir(root);
const executable='C:/Program Files/Tailscale/tailscale.exe';
const systemShell=path.join(process.env.SystemRoot??'C:/Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
const shellEnv={...process.env,PSModulePath:path.join(path.dirname(systemShell),'Modules')};
const settings=JSON.parse(fs.readFileSync(path.join(root,'config.local.json'),'utf8'));
const proxy=settings.qzone?.proxyUrl??settings.antigravity?.proxyUrl;
if(proxy){const u=new URL(proxy);if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname))throw Error('LOCAL_PROXY_REQUIRED');}
async function get(url,file,extra=[]){
  const curl=path.join(process.env.SystemRoot??'C:/Windows','System32/curl.exe');
  const {stdout}=await exec(curl,['--fail','--location','--silent','--show-error','--retry','2','--retry-all-errors','--connect-timeout','15','--max-time','90',...(proxy?['--proxy',proxy]:[]),...(file?['--output',file]:[]),...extra,url],{windowsHide:true,maxBuffer:65536});return stdout;
}
async function download(){
  const directory=path.join(root,'vendor/tailscale');fs.mkdirSync(directory,{recursive:true});
  const name='tailscale-setup-1.104.4-amd64.msi',url='https://pkgs.tailscale.com/stable/'+name,file=path.join(directory,name);
  const expected=(await get(url+'.sha256')).trim().split(/\s+/)[0].toLowerCase();if(!/^[a-f0-9]{64}$/.test(expected))throw Error('INVALID_OFFICIAL_HASH');
  if(!fs.existsSync(file)){
    console.log('正在下载官方 Tailscale 安装包 到项目 vendor/tailscale');
    const header=await get(url,undefined,['--head']),total=Number([...header.matchAll(/Content-Length:\s*(\d+)/gi)].at(-1)?.[1]);
    if(!Number.isSafeInteger(total)||total<1||total>100*1024*1024)throw Error('INVALID_PACKAGE_SIZE');
    const size=1024*1024,count=Math.ceil(total/size),parts=path.join(directory,'parts');fs.mkdirSync(parts,{recursive:true});
    if(fs.existsSync(file+'.tmp')){
      const partial=fs.readFileSync(file+'.tmp');for(let i=0;i<Math.floor(partial.length/size);i++)fs.writeFileSync(path.join(parts,String(i)),partial.subarray(i*size,(i+1)*size));
    }
    let cursor=0;
    await Promise.all(Array.from({length:6},async()=>{while(cursor<count){
      const index=cursor++,start=index*size,end=Math.min(total-1,start+size-1),part=path.join(parts,String(index));
      if(fs.existsSync(part)&&fs.statSync(part).size===end-start+1)continue;
      await get(url,part,['--range',`${start}-${end}`]);if(fs.statSync(part).size!==end-start+1)throw Error('INCOMPLETE_PACKAGE_PART');console.log(`分片 ${index+1}/${count} 完成`);
    }}));
    const data=Buffer.concat(Array.from({length:count},(_,i)=>fs.readFileSync(path.join(parts,String(i)))));
    if(createHash('sha256').update(data).digest('hex')!==expected)throw Error('TAILSCALE_HASH_MISMATCH');fs.writeFileSync(file,data);
  }
  const hash=createHash('sha256').update(fs.readFileSync(file)).digest('hex');if(hash!==expected)throw Error('TAILSCALE_HASH_MISMATCH');
  const literal="'"+file.replaceAll("'","''")+"'";
  const command="$ErrorActionPreference = 'Stop'; Import-Module Microsoft.PowerShell.Security -ErrorAction Stop; $packageSignature = Get-AuthenticodeSignature -LiteralPath "+literal+"; [pscustomobject]@{Status=[string]$packageSignature.Status;Signer=$packageSignature.SignerCertificate.Subject} | ConvertTo-Json -Compress";
  const {stdout}=await exec(systemShell,['-NoProfile','-Command',command],{windowsHide:true,env:shellEnv});
  const signature=JSON.parse(stdout.replace(/^\uFEFF/,''));
  fs.writeFileSync(path.join(directory,'verification.json'),JSON.stringify({version:'1.104.4',url,sha256:hash,...signature},null,2));
  if(signature.Status!=='Valid'||!signature.Signer?.includes('Tailscale'))throw Error('TAILSCALE_SIGNATURE_INVALID');
  console.log('官方 SHA256 与 Tailscale 数字签名核对通过');return file;
}
try{
  const action=process.argv[2];
  if(action==='download'||action==='install'){
    const file=await download();if(action==='install'){
      const msi="'\""+file.replaceAll("'","''")+"\"'";
      const {stdout}=await exec(systemShell,['-NoProfile','-Command',"$ErrorActionPreference='Stop'; $installer = Start-Process -FilePath 'msiexec.exe' -Verb RunAs -ArgumentList @('/i', "+msi+", '/quiet', '/norestart') -WindowStyle Hidden -Wait -PassThru; [Console]::WriteLine($installer.ExitCode)"],{windowsHide:true,env:shellEnv});
      const code=Number(stdout.trim());
      if(![0,3010].includes(code))throw Error('TAILSCALE_INSTALL_FAILED_'+code);
      console.log('Tailscale 已安装 请本人登录托盘应用 再运行 setup-remote.cmd');
    }
  }else if(action==='serve'){
    if(!fs.existsSync(executable))throw Error('Run install-tailscale.cmd first.');
    const {stdout}=await exec(executable,['status','--json'],{windowsHide:true});const status=JSON.parse(stdout);
    if(status.BackendState!=='Running')throw Error('请先在 Tailscale 托盘应用登录 再运行此脚本');
    const dns=status.Self?.DNSName?.replace(/\.$/,'');if(!/^[a-z0-9][a-z0-9.-]+\.ts\.net$/i.test(dns??''))throw Error('TAILSCALE_DNS_UNAVAILABLE');
    if(!fs.existsSync('state/web-auth.json'))throw Error('Run setup-web.cmd first.');
    const previous=await exec(executable,['serve','status','--json'],{windowsHide:true});const routes=JSON.parse(previous.stdout||'{}');
    const handlers=routes.Web?.[dns+':443']?.Handlers;
    if(handlers&&Object.entries(handlers).some(([key,value])=>key!=='/'||value.Proxy!=='http://127.0.0.1:3210'))throw Error('TAILSCALE_SERVE_443_ALREADY_CONFIGURED');
    const code=await new Promise((resolve,reject)=>{const child=spawn(executable,['serve','--bg','--https=443','http://127.0.0.1:3210'],{stdio:'inherit',windowsHide:true});child.once('error',reject);child.once('exit',resolve);});
    if(code!==0)throw Error('TAILSCALE_SERVE_FAILED');
    fs.writeFileSync('state/web-access.json',JSON.stringify({remoteOrigin:'https://'+dns},null,2),{mode:0o600});console.log('私人管理台地址 https://'+dns);console.log('请让手机或其他电脑加入同一私人网络 未启用公开 Funnel');
  }else throw Error('Usage: tailscale.mjs download|install|serve');
}catch(e){console.error(e.message);process.exitCode=1;}
