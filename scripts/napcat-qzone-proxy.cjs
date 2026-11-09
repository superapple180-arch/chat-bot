const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const config = JSON.parse(fs.readFileSync(process.env.QQ_BOT_CONFIG_FILE || path.resolve(__dirname, '../config.local.json'), 'utf8'));
if (config.qzone?.enabled && config.qzone.proxyUrl) {
  const proxy = new URL(config.qzone.proxyUrl);
  if (proxy.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(proxy.hostname) || !proxy.port || proxy.username || proxy.password || proxy.pathname !== '/' || proxy.search || proxy.hash) throw Error('INVALID_QZONE_PROXY');
  const { ProxyAgent } = require('proxy-agent');
  const agent = new ProxyAgent({ httpAgent: http.globalAgent, httpsAgent: https.globalAgent, getProxyForUrl: value => {
    const host = new URL(value).hostname;
    return host === 'ssl.ptlogin2.qq.com' || host === 'qzone.qq.com' || host.endsWith('.qzone.qq.com') ? proxy.href : '';
  } });
  http.globalAgent = agent; https.globalAgent = agent;
}
