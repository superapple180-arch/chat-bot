import fs from 'node:fs';
import WebSocket from 'ws';
import { readConfig } from '../dist/config.js';
const config = readConfig('config.local.json');
const socket = new WebSocket(config.onebot.url, { headers: { Authorization: `Bearer ${config.onebot.accessToken}` }, followRedirects: false });
const pending = new Map(); let sequence = 0;
function rpc(action) {
  const echo = String(++sequence);
  return new Promise((resolve, reject) => {
    pending.set(echo, { resolve, reject }); socket.send(JSON.stringify({ action, params: {}, echo }));
  });
}
const timer = setTimeout(() => { for (const p of pending.values()) p.reject(Error('TIMEOUT')); socket.terminate(); }, 10000);
socket.on('error', () => {});
socket.on('message', raw => {
  const event = JSON.parse(raw); const p = pending.get(event.echo);
  if (!p) return; pending.delete(event.echo);
  if (event.status === 'ok' && event.retcode === 0) p.resolve(event.data); else p.reject(Error('API_REJECTED'));
});
try {
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', () => reject(Error('CONNECTION_FAILED'))); });
  const info = await rpc('get_login_info');
  if (String(info.user_id) !== config.onebot.selfId) throw Error('ACCOUNT_MISMATCH');
  const friends = await rpc('get_friend_list'), groups = await rpc('get_group_list');
  const report = { at: new Date().toISOString(), accountMatched: true, friendsMatched: config.friends.every(id => friends.some(f => String(f.user_id) === id)), groupsMatched: config.groups.every(id => groups.some(g => String(g.group_id) === id)) };
  fs.writeFileSync('artifacts/qq-targets.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
  if (!report.friendsMatched || !report.groupsMatched) process.exitCode = 1;
} catch (error) { console.log(JSON.stringify({ result: 'failed', reason: error.message })); process.exitCode = 1; }
finally { clearTimeout(timer); socket.terminate(); }
