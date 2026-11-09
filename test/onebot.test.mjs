// Public fixture identities below are generated synthetic labels.
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { setTimeout as delay } from 'node:timers/promises';
import { OneBot } from '../dist/onebot.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sharp from 'sharp';
async function until(f, timeout = 5000) { const end=Date.now()+timeout; while(!f()) { if(Date.now()>end) throw new Error('WAIT_TIMEOUT'); await delay(10); } }
async function fixture(t, options = {}) {
  const token = 'mock-token-no-real-credentials'; let connections=0; const requests=[]; const received=[]; const states=[]; const warnings=[];
  const server = new WebSocketServer({ host:'127.0.0.1',port:0,verifyClient: info => info.req.headers.authorization===`Bearer ${token}` });
  await new Promise(r => server.on('listening',r));
  server.on('connection', socket => { connections++; socket.on('message', raw => {
    const m=JSON.parse(raw); requests.push(m);
    if(m.action.startsWith('send_') && options.ambiguous) { socket.terminate(); return; }
    if (m.params.message?.some(s => s.type === 'image') && options.imageOutcome) {
      if (options.imageOutcome === 'timeout') return;
      socket.send(JSON.stringify({ status: options.imageOutcome === 'reject' ? 'failed' : 'ok', retcode: options.imageOutcome === 'reject' ? 1 : 0, data: null, echo: m.echo })); return;
    }
    if (m.params.message?.[0]?.type === 'record' && options.voiceOutcome) {
      if (options.voiceOutcome === 'timeout') return;
      socket.send(JSON.stringify({status:options.voiceOutcome==='reject'?'failed':'ok',retcode:options.voiceOutcome==='reject'?1:0,data:null,echo:m.echo})); return;
    }
    if (m.action === 'send_qzone_msg') { const answer=()=>socket.send(JSON.stringify({status:'ok',retcode:0,data:{tid:options.qzoneTid===undefined?'synthetic-tid':options.qzoneTid},echo:m.echo})); if(options.qzoneDelay)setTimeout(answer,options.qzoneDelay);else answer(); return; }
    if (m.action.startsWith('set_') && options.ambiguousRequest) { socket.terminate(); return; }
    if (m.action.startsWith('set_')) { socket.send(JSON.stringify({status:'ok',retcode:0,data:null,echo:m.echo})); return; }
    if (options.rejectLogin && m.action === 'get_login_info' || options.rejectMembers && m.action === 'get_group_member_info') {
      socket.send(JSON.stringify({status:'failed',retcode:1,data:null,echo:m.echo})); return;
    }
    if (options.holdMembers && m.action === 'get_group_member_info') { options.held = { socket, message: m }; return; }
    if (m.action === 'get_friend_list') { socket.send(JSON.stringify({status:'ok',retcode:0,data:options.friends,echo:m.echo})); return; }
    const data=m.action==='get_login_info'?{user_id:options.wrongAccount?999:10000,nickname:options.nickname??'合成昵称'}:m.action==='get_status'?{online:true,good:true}:m.action==='get_group_member_info'?{user_id:options.wrongMember?999:10000,group_id:options.wrongGroup?'99999':m.params.group_id,card:options.cards?.[m.params.group_id]??''}:{message_id:123};
    socket.send(JSON.stringify({status:'ok',retcode:0,data,echo:m.echo}));
  }); });
  const bot=new OneBot({url:`ws://127.0.0.1:${server.address().port}`,accessToken:token,selfId:'10000',timeoutMs:500},e=>received.push(e),(ready,reason)=>states.push({ready,reason}),options.groups??[],code=>warnings.push(code));
  t.after(async()=>{ bot.close(); for(const c of server.clients)c.terminate(); await new Promise(r=>server.close(r)); });
  bot.start(); return {bot,server,requests,received,states,warnings,connections:()=>connections};
}
test('authenticated OneBot receives events, sends text segments to exact original target, reconnects after disconnect', async t=>{
  const f=await fixture(t); await until(()=>f.bot.ready);
  for(const c of f.server.clients)c.send(JSON.stringify({post_type:'message',message_id:1})); await until(()=>f.received.length===1);
  await f.bot.send({kind:'private',id:'20001'},'[CQ:at,qq=all]literal');
  await f.bot.send({kind:'group',id:'30001'},'group reply');
  const sends=f.requests.filter(x=>x.action.startsWith('send_'));
  assert.equal(sends[0].params.user_id,'20001'); assert.equal(sends[1].params.group_id,'30001');
  assert.deepEqual(sends[0].params.message,[{type:'text',data:{text:'[CQ:at,qq=all]literal'}}]);
  for(const c of f.server.clients)c.terminate(); await until(()=>!f.bot.ready); await until(()=>f.connections()===2 && f.bot.ready);
  for(const c of f.server.clients)c.send(JSON.stringify({post_type:'message',message_id:2})); await until(()=>f.received.length===2);
});

test('friend directory uses authenticated API, normalizes IDs and rejects malformed rows', async t => {
  const options = { friends: [{user_id:10000,nickname:'self',remark:''},{user_id:20001,nickname:'合成昵称甲',remark:'备注'},{user_id:'20002',nickname:'合成昵称乙',remark:''}] };
  const f = await fixture(t, options); await until(() => f.bot.ready);
  assert.deepEqual(await f.bot.friendList(), [{userId:'20001',nickname:'合成昵称甲',remark:'备注'},{userId:'20002',nickname:'合成昵称乙',remark:''}]);
  assert.deepEqual(f.requests.find(x => x.action === 'get_friend_list').params, {});
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 0);
  for (const bad of [null, {}, [{user_id:20001,nickname:'x'}], [{user_id:1.5,nickname:'x',remark:''}], [{user_id:'0',nickname:'x',remark:''}]]) {
    options.friends = bad; await assert.rejects(f.bot.friendList(), {code:'QQ_FRIEND_LIST_INVALID'});
  }
  f.bot.close(); await assert.rejects(f.bot.friendList(), {code:'QQ_NOT_CONNECTED'});
});
test('classic faces are validated protocol segments and attachment lookup uses only opaque IDs', async t => {
  const f = await fixture(t); await until(() => f.bot.ready);
  await f.bot.send({ kind: 'private', id: '20001' }, '[CQ:at,qq=all]', '4');
  assert.deepEqual(f.requests.find(x => x.action === 'send_private_msg').params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }, { type: 'face', data: { id: '4' } }]);
  await assert.rejects(f.bot.send({ kind: 'private', id: '20001' }, 'x', '322'), { code: 'INVALID_CLASSIC_FACE' });
  await f.bot.attachment({ kind: 'image', fileId: 'a'.repeat(32), name: 'image' });
  assert.deepEqual(f.requests.find(x => x.action === 'get_file').params, { file_id: 'a'.repeat(32) });
  await assert.rejects(f.bot.attachment({ kind: 'file', fileId: 'C:\\secret', name: 'x' }), { code: 'INVALID_ATTACHMENT_ID' });
});
test('disconnect after send is uncertain, reconnect never retransmits action', async t=>{
  const f=await fixture(t,{ambiguous:true}); await until(()=>f.bot.ready);
  await assert.rejects(f.bot.send({kind:'private',id:'20001'},'synthetic'),e=>e.code==='QQ_SEND_UNCERTAIN'&&e.uncertain);
  await until(()=>f.connections()===2 && f.bot.ready); assert.equal(f.requests.filter(x=>x.action.startsWith('send_')).length,1);
});

function voiceFile(t) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const folder = fs.mkdtempSync(path.resolve('artifacts/test-tmp/onebot-voice-'));
  const file = path.join(folder, 'voice.wav'); fs.writeFileSync(file, Buffer.alloc(50));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return file;
}

test('voice sends exactly one record segment to original private or group target and rejects invalid local files', async t => {
  const f = await fixture(t), file = voiceFile(t); await until(() => f.bot.ready);
  for (const target of [{kind:'private',id:'20001'},{kind:'group',id:'30001'}]) assert.equal(await f.bot.sendVoice(target,file), '123');
  const sends = f.requests.filter(x => x.action.startsWith('send_'));
  assert.equal(sends.length, 2); assert.equal(sends[0].params.user_id, '20001'); assert.equal(sends[1].params.group_id, '30001');
  for (const send of sends) assert.deepEqual(send.params.message, [{type:'record',data:{file:pathToFileURL(file).href}}]);
  for (const invalid of ['https://example.com/voice.wav', '../voice.wav', file+'missing']) await assert.rejects(f.bot.sendVoice({kind:'private',id:'20001'},invalid), {code:'INVALID_VOICE_FILE'});
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 2);
});

for (const voiceOutcome of ['reject', 'missing', 'timeout']) test(`voice ${voiceOutcome} never retries and distinguishes known rejection from uncertain receipt`, async t => {
  const f = await fixture(t, {voiceOutcome}), file = voiceFile(t); await until(() => f.bot.ready);
  if (voiceOutcome === 'timeout') t.mock.timers.enable({apis:['setTimeout']});
  const pending = f.bot.sendVoice({kind:'private',id:'20001'},file);
  const checked = assert.rejects(pending, e => e.code === (voiceOutcome === 'reject' ? 'QQ_SEND_REJECTED' : 'QQ_SEND_UNCERTAIN') && e.uncertain === (voiceOutcome !== 'reject'));
  if (voiceOutcome === 'timeout') { await new Promise(r => setImmediate(r)); t.mock.timers.tick(60000); }
  await checked; t.mock.timers.reset();
  await until(() => f.requests.filter(x => x.action.startsWith('send_')).length === 1);
});

test('voice disconnect remains uncertain after reconnect and never retransmits the audio', async t => {
  const f = await fixture(t, {ambiguous:true}), file = voiceFile(t); await until(() => f.bot.ready);
  await assert.rejects(f.bot.sendVoice({kind:'group',id:'30001'},file), e => e.code === 'QQ_SEND_UNCERTAIN' && e.uncertain);
  await until(() => f.connections() === 2 && f.bot.ready);
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 1);
});

async function imageFile(t, gif = false) {
  const root = path.resolve('state/media'); fs.mkdirSync(root, { recursive: true });
  const folder = fs.mkdtempSync(path.join(root, 'test-')); assert.ok(folder.startsWith(root + path.sep));
  const file = path.join(folder, gif ? 'image.gif' : 'image.png');
  if (gif) {
    const frame = Buffer.from('21f904000a0000002c0000000001000100000202440100', 'hex');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('47494638396101000100800000000000ffffff', 'hex'), frame, frame, Buffer.from('3b', 'hex')]));
    assert.equal((await sharp(file, { animated: true }).metadata()).pages, 2);
  } else fs.writeFileSync(file, await sharp({ create: { width: 2, height: 2, channels: 3, background: 'blue' } }).png().toBuffer());
  t.after(() => fs.rmSync(folder, { recursive: true, force: true })); return file;
}
for (const gif of [false, true]) test(`image ${gif ? 'GIF animation' : 'PNG'} is preserved and text plus image use one request for each exact target`, async t => {
  const f = await fixture(t), file = await imageFile(t, gif), bytes = fs.readFileSync(file); await until(() => f.bot.ready);
  for (const target of [{ kind: 'private', id: '20001' }, { kind: 'group', id: '30001' }]) assert.equal(await f.bot.sendImage(target, file, '[CQ:at,qq=all]literal'), '123');
  const sends = f.requests.filter(x => x.action.startsWith('send_'));
  assert.equal(sends.length, 2); assert.equal(sends[0].params.user_id, '20001'); assert.equal(sends[1].params.group_id, '30001');
  for (const send of sends) assert.deepEqual(send.params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]literal' } }, { type: 'image', data: { file: pathToFileURL(file).href } }]);
  assert.deepEqual(fs.readFileSync(file), bytes);
  await f.bot.sendImage({ kind: 'private', id: '20001' }, file);
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).at(-1).params.message.length, 1);
  for (const invalid of ['https://example.com/a.png', '../image.png', path.resolve('test/fixtures/attachment.pdf'), file + 'missing']) await assert.rejects(f.bot.sendImage({ kind: 'private', id: '20001' }, invalid), { code: 'INVALID_IMAGE_FILE' });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.bot.sendImage({ kind: 'private', id: '20001' }, file, '', controller.signal), { code: 'PAUSED' });
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 3);
});
for (const imageOutcome of ['reject', 'missing', 'timeout']) test(`image ${imageOutcome} is classified without retries or a text fallback`, async t => {
  const f = await fixture(t, { imageOutcome }), file = await imageFile(t); await until(() => f.bot.ready);
  if (imageOutcome === 'timeout') t.mock.timers.enable({ apis: ['setTimeout'] });
  const result = f.bot.sendImage({ kind: 'group', id: '30001' }, file, '合成图片');
  const checked = assert.rejects(result, e => e.code === (imageOutcome === 'reject' ? 'QQ_SEND_REJECTED' : 'QQ_SEND_UNCERTAIN') && e.uncertain === (imageOutcome !== 'reject'));
  if (imageOutcome === 'timeout') {
    while (!f.requests.some(x => x.params.message?.some(s => s.type === 'image'))) await new Promise(r => setImmediate(r));
    t.mock.timers.tick(60000);
  }
  await checked; t.mock.timers.reset();
  assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 1);
});
test('image disconnect stays uncertain after reconnect and never retransmits', async t => {
  const f = await fixture(t, { ambiguous: true }), file = await imageFile(t); await until(() => f.bot.ready);
  await assert.rejects(f.bot.sendImage({ kind: 'private', id: '20001' }, file), e => e.code === 'QQ_SEND_UNCERTAIN' && e.uncertain);
  await until(() => f.connections() === 2 && f.bot.ready); assert.equal(f.requests.filter(x => x.action.startsWith('send_')).length, 1);
});

test('request decisions explicitly send boolean approval, preserve request flags and group subtype, accept null acknowledgements', async t => {
  const f = await fixture(t); await until(() => f.bot.ready);
  await f.bot.handleRequest({kind:'friend',flag:'friend-opaque'}, true);
  await f.bot.handleRequest({kind:'group',flag:'invite-opaque',subType:'invite'}, false);
  assert.deepEqual(f.requests.filter(x => x.action.startsWith('set_')).map(({action,params}) => ({action,params})), [
    {action:'set_friend_add_request',params:{flag:'friend-opaque',approve:true}},
    {action:'set_group_add_request',params:{flag:'invite-opaque',approve:false,sub_type:'invite'}}
  ]);
  await assert.rejects(f.bot.handleRequest({kind:'group',flag:'x'}, true), {code:'INVALID_CONTACT_REQUEST'});
});

test('lost request acknowledgement is uncertain and reconnect cannot approve twice', async t => {
  const f = await fixture(t, {ambiguousRequest:true}); await until(() => f.bot.ready);
  await assert.rejects(f.bot.handleRequest({kind:'friend',flag:'opaque'}, true), e => e.code === 'QQ_SEND_UNCERTAIN' && e.uncertain);
  await until(() => f.connections() === 2 && f.bot.ready);
  assert.equal(f.requests.filter(x => x.action === 'set_friend_add_request').length, 1);
});

test('Qzone publishes through the authenticated account with explicit friends-only visibility and a required tid', async t => {
  const options = {}, f = await fixture(t, options); await until(() => f.bot.ready);
  assert.equal(await f.bot.publishQzone('合成说说'), 'synthetic-tid');
  assert.deepEqual(f.requests.find(x => x.action === 'send_qzone_msg').params, {content:'合成说说',ugc_right:4});
  await assert.rejects(f.bot.publishQzone('x'.repeat(301)), {code:'INVALID_QZONE_TEXT'});
  options.qzoneTid = null;
  await assert.rejects(f.bot.publishQzone('合成测试'), e => e.code === 'QZONE_PUBLISH_UNCERTAIN' && e.uncertain);
});

test('Qzone login and publish can take longer than normal message RPC without losing the receipt', async t => {
  const f=await fixture(t,{qzoneDelay:650}); await until(()=>f.bot.ready);
  assert.equal(await f.bot.publishQzone('等待空间回执'), 'synthetic-tid');
});
test('wrong QQ account cannot become ready or deliver incoming events', async t=>{
  const f=await fixture(t,{wrongAccount:true}); await until(()=>f.states.some(x=>x.reason==='QQ_ACCOUNT_MISMATCH'));
  assert.equal(f.bot.ready,false); assert.equal(f.received.length,0);
});

test('identity reads only self in allowed groups, scopes cards and refreshes on reconnect or reload', async t => {
  const options = { groups: ['30001', '30002'], nickname: '合成昵称丙', cards: { '30001': '一群名片', '30002': '二群名片' } };
  const f = await fixture(t, options); await until(() => f.bot.ready);
  assert.deepEqual(f.bot.groupIdentity('30001'), ['合成昵称丙', '一群名片']);
  assert.deepEqual(f.bot.groupIdentity('30002'), ['合成昵称丙', '二群名片']);
  assert.deepEqual(f.bot.groupIdentity('99999'), []);
  for (const m of f.requests.filter(x => x.action === 'get_group_member_info')) {
    assert.equal(m.params.user_id, '10000'); assert.equal(m.params.no_cache, true); assert.ok(options.groups.includes(m.params.group_id));
  }
  options.nickname = '新昵称'; options.cards['30001'] = '新名片';
  for (const peer of f.server.clients) peer.terminate();
  await until(() => !f.bot.ready); assert.deepEqual(f.bot.groupIdentity('30001'), []);
  await until(() => f.connections() === 2 && f.bot.ready);
  assert.deepEqual(f.bot.groupIdentity('30001'), ['新昵称', '新名片']);
  await f.bot.refreshIdentity(['30002']);
  assert.deepEqual(f.bot.groupIdentity('30001'), []);
  assert.deepEqual(f.bot.groupIdentity('30002'), ['新昵称', '二群名片']);
});

test('missing, invalid or failed identity metadata drops old names while keeping direct mention service ready', async t => {
  const options = { groups: ['30001'], nickname: '合成昵称丙', cards: { '30001': '旧名片' } };
  const f = await fixture(t, options); await until(() => f.bot.ready);
  options.rejectMembers = true; await f.bot.refreshIdentity(options.groups);
  assert.equal(f.bot.ready, true); assert.deepEqual(f.bot.groupIdentity('30001'), ['合成昵称丙']);
  assert.ok(f.warnings.includes('IDENTITY_GROUP_UNAVAILABLE'));
  options.rejectMembers = false; options.wrongMember = true; await f.bot.refreshIdentity(options.groups);
  assert.deepEqual(f.bot.groupIdentity('30001'), ['合成昵称丙']);
  options.wrongMember = false; options.wrongGroup = true; await f.bot.refreshIdentity(options.groups);
  assert.deepEqual(f.bot.groupIdentity('30001'), ['合成昵称丙']);
  options.wrongGroup = false; options.nickname = ''; options.cards['30001'] = '';
  await f.bot.refreshIdentity(options.groups); assert.deepEqual(f.bot.groupIdentity('30001'), []);
  assert.ok(f.warnings.includes('IDENTITY_NICKNAME_UNAVAILABLE'));
  options.rejectLogin = true; await f.bot.refreshIdentity(options.groups);
  assert.equal(f.bot.ready, true); assert.deepEqual(f.bot.groupIdentity('30001'), []);
  assert.ok(f.warnings.includes('IDENTITY_REFRESH_FAILED'));
});

test('refresh rejects changed login accounts and ignores results from a disconnected socket', async t => {
  const options = { groups: ['30001'], nickname: '合成昵称丙', cards: { '30001': '旧名片' } };
  const f = await fixture(t, options); await until(() => f.bot.ready);
  options.holdMembers = true;
  const refreshed = f.bot.refreshIdentity(options.groups); await until(() => options.held);
  for (const peer of f.server.clients) peer.terminate();
  await refreshed; assert.deepEqual(f.bot.groupIdentity('30001'), []);
  options.holdMembers = false;
  await until(() => f.connections() === 2 && f.bot.ready);
  options.wrongAccount = true;
  await assert.rejects(f.bot.refreshIdentity(options.groups), e => e.code === 'QQ_ACCOUNT_MISMATCH');
  assert.equal(f.bot.ready, false); assert.deepEqual(f.bot.groupIdentity('30001'), []);
});

test('newer identity refresh wins over late responses and member timeouts retain only current nickname', async t => {
  const options = { groups: ['30001'], nickname: '合成昵称丙', cards: { '30001': '旧名片' } };
  const f = await fixture(t, options); await until(() => f.bot.ready);
  options.holdMembers = true;
  const older = f.bot.refreshIdentity(options.groups); await until(() => options.held);
  const held = options.held;
  options.holdMembers = false; options.nickname = '新昵称'; options.cards['30001'] = '新名片';
  await f.bot.refreshIdentity(options.groups);
  held.socket.send(JSON.stringify({echo:held.message.echo,status:'ok',retcode:0,data:{user_id:10000,group_id:'30001',card:'合成昵称丁'}}));
  await older; assert.deepEqual(f.bot.groupIdentity('30001'), ['新昵称', '新名片']);
  options.holdMembers = true; await f.bot.refreshIdentity(options.groups);
  assert.equal(f.bot.ready, true); assert.deepEqual(f.bot.groupIdentity('30001'), ['新昵称']);
  assert.ok(f.warnings.includes('IDENTITY_GROUP_UNAVAILABLE'));
});
