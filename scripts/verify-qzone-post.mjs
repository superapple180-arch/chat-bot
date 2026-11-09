import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { ProxyAgent } from 'proxy-agent';
import { OneBot } from '../dist/onebot.js';
import { readConfig } from '../dist/config.js';
import { beijingDate } from '../dist/qzone.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
let bot;
const report = { at: new Date().toISOString(), readOnly: true, matched: false };
try {
  const c = readConfig('config.local.json'), state = JSON.parse(fs.readFileSync('state/antigravity.json', 'utf8'));
  const post = state.qzonePosts?.[`${c.onebot.selfId}:${beijingDate()}`];
  if (!post?.text) throw Error('QZONE_DRAFT_MISSING');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('QQ_NOT_CONNECTED')), 12000);
    bot = new OneBot(c.onebot, () => {}, ready => { if (ready) { clearTimeout(timer); resolve(); } }); bot.start();
  });
  // Credentials remain in this process and are sent only to the authenticated account's Qzone HTTPS endpoint.
  const auth = await bot.rpc('get_cookies', { domain: 'qzone.qq.com' }, false, 60000);
  if (typeof auth?.cookies !== 'string' || !/^\d+$/.test(String(auth.bkn))) throw Error('QZONE_AUTH_UNAVAILABLE');
  const owner = /(?:^|;\s*)uin=o?0*([1-9]\d*)(?:;|$)/.exec(auth.cookies)?.[1];
  if (owner !== c.onebot.selfId) throw Error('QZONE_AUTH_ACCOUNT_MISMATCH');
  const url = new URL('https://user.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6');
  url.search = new URLSearchParams({ uin: c.onebot.selfId, g_tk: String(auth.bkn), pos: '0', num: '20', sort: '0', ftype: '0', replynum: '0', format: 'json', callback: '_preloadCallback', need_comment: '0' }).toString();
  const agent = c.qzone?.proxyUrl ? new ProxyAgent({ getProxyForUrl: () => c.qzone.proxyUrl }) : undefined;
  const data = await new Promise((resolve, reject) => {
    const request = https.get(url, { agent, headers: { Cookie: auth.cookies, Referer: `https://user.qzone.qq.com/${c.onebot.selfId}/main`, 'User-Agent': 'Mozilla/5.0' } }, response => {
      if (response.statusCode !== 200) { response.resume(); reject(Error('QZONE_READ_HTTP_FAILED')); return; }
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; if (text.length > 1048576) request.destroy(Error('QZONE_READ_TOO_LARGE')); });
      response.on('end', () => {
        try { const wrapper = /^\s*_preloadCallback\(([^]*)\)\s*;?\s*$/.exec(text); resolve(JSON.parse(wrapper ? wrapper[1] : text)); }
        catch { report.format = { type: response.headers['content-type'], encoding: response.headers['content-encoding'], length: text.length, firstCharacter: text.charCodeAt(0), callback: /^\s*([a-zA-Z_$][\w$]*)\s*\(/.exec(text)?.[1], html: /^\s*</.test(text) }; reject(Error('QZONE_READ_FORMAT_INVALID')); }
      });
    });
    request.setTimeout(30000, () => request.destroy(Error('QZONE_READ_TIMEOUT'))); request.on('error', () => reject(Error('QZONE_READ_NETWORK_FAILED')));
  });
  if (data.code !== 0) throw Error('QZONE_READ_SERVICE_REJECTED');
  const rows = Array.isArray(data.msglist) ? data.msglist : [];
  const found = rows.find(row => row.content === post.text);
  Object.assign(report, { matched: Boolean(found), tid: found?.tid, total: data.total ?? null, returned: rows.length, responseFields: Object.keys(data) });
} catch (error) { report.error = error.code ?? error.message ?? 'QZONE_READ_FAILED'; process.exitCode = 1; }
finally {
  bot?.close(); fs.writeFileSync('artifacts/qzone-readback.json', JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));
}
