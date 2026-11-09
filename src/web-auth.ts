import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
const derive=promisify(scrypt);
export async function setWebPassword(file: string,password: string) {
  if(password.length<12||password.length>256)throw Error('PASSWORD_LENGTH_12_TO_256');
  const salt=randomBytes(32).toString('hex'),hash=(await derive(password,salt,64) as Buffer).toString('hex');
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file+'.tmp',JSON.stringify({salt,hash}),{mode:0o600});fs.renameSync(file+'.tmp',file);
}
export class WebAuth {
  private sessions=new Map<string,{csrf:string;expires:number}>();
  constructor(private file: string) {}
  async login(password: unknown) {
    if(typeof password!=='string'||password.length>256) return undefined;
    if(!fs.existsSync(this.file))throw Error('WEB_PASSWORD_NOT_CONFIGURED');
    const {salt,hash}=JSON.parse(fs.readFileSync(this.file,'utf8'));
    const actual=await derive(password,salt,64) as Buffer, expected=Buffer.from(hash,'hex');
    if(actual.length!==expected.length||!timingSafeEqual(actual,expected))return undefined;
    for(const [key,s]of this.sessions)if(s.expires<Date.now())this.sessions.delete(key);
    if(this.sessions.size>=20)this.sessions.delete(this.sessions.keys().next().value!);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    this.sessions.set(this.key(token),{csrf,expires:Date.now()+12*3600000});return {token,csrf};
  }
  private key(token: string){return createHash('sha256').update(token).digest('hex');}
  session(token: string|undefined){if(!token)return;const s=this.sessions.get(this.key(token));if(s&&s.expires>Date.now())return s;}
  logout(token: string){this.sessions.delete(this.key(token));}
}
