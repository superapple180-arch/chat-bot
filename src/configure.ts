import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { randomBytes } from 'node:crypto';
process.chdir(path.resolve(import.meta.dirname, '..'));
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
try {
  const file = 'config.local.json';
  const c = JSON.parse(fs.readFileSync(fs.existsSync(file) ? file : 'config.example.json', 'utf8'));
  const id = (await rl.question('当前登录的个人 QQ 号：')).trim();
  if (!/^[1-9]\d+$/.test(id)) throw new Error('INVALID_SELF_ID');
  const list = (s: string) => s.trim() ? s.split(/[,，\s]+/).filter(Boolean) : [];
  const selfOnly = process.argv.includes('--self-only');
  const friends = selfOnly ? c.friends : list(await rl.question('测试好友 QQ 号，用逗号分隔；留空表示不回复好友：'));
  const groups = selfOnly ? c.groups : list(await rl.question('测试群号，用逗号分隔；留空表示不回复群：'));
  if ([...friends, ...groups].some(x => !/^[1-9]\d+$/.test(x))) throw new Error('INVALID_ALLOWLIST');
  c.onebot.selfId = id; c.friends = friends; c.groups = groups; c.realSend = false;
  if (!c.onebot.accessToken || c.onebot.accessToken.includes('REPLACE')) c.onebot.accessToken = randomBytes(32).toString('hex');
  fs.writeFileSync(file, JSON.stringify(c, null, 2), { mode: 0o600 });
  console.log('配置已保存，真实发送仍关闭。请先运行 start.cmd，以 r 启动干跑；确认后自行把 realSend 改为 true 并 reload、r。');
} finally { rl.close(); }
