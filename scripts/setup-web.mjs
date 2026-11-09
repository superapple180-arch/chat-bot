import fs from 'node:fs';
import path from 'node:path';
import { setWebPassword } from '../dist/web-auth.js';
process.chdir(path.resolve(import.meta.dirname,'..'));
if(!process.stdin.isTTY){console.error('INTERACTIVE_TERMINAL_REQUIRED');process.exit(1);}
function secret(prompt){
  return new Promise((resolve,reject)=>{
    let text='';process.stdout.write(prompt);process.stdin.setRawMode(true);process.stdin.resume();process.stdin.setEncoding('utf8');
    const finish=()=>{process.stdin.off('data',read);process.stdin.setRawMode(false);process.stdin.pause();process.stdout.write('\n');};
    const read=chunk=>{for(const char of chunk){if(char==='\u0003'){finish();reject(Error('CANCELLED'));return;}if(char==='\r'||char==='\n'){finish();resolve(text);return;}if(char==='\u007f'||char==='\b')text=text.slice(0,-1);else if(char>=' '&&text.length<256)text+=char;}};
    process.stdin.on('data',read);
  });
}
try{
  if(fs.existsSync('state/web-auth.json'))console.log('重新设置密码后 请重启管理台使原有登录失效');
  const password=await secret('设置管理密码 至少12个字符 输入不显示: '),again=await secret('再次输入密码: ');
  if(password!==again)throw Error('PASSWORDS_DO_NOT_MATCH');
  await setWebPassword('state/web-auth.json',password);console.log('管理密码已设置 仅保存密码哈希');
}catch(e){console.error(e.message);process.exitCode=1;}
