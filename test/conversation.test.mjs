import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { State } from '../dist/state.js';
import { Bridge } from '../dist/bridge.js';
import { Conversation } from '../dist/conversation.js';
import { filterEvent, digest } from '../dist/filter.js';
import { readConfig } from '../dist/config.js';

const event = (id, user = '20001', group = '30001', text = '普通聊天') => ({ post_type: 'message', message_type: group ? 'group' : 'private', sub_type: 'friend', self_id: 10000, user_id: Number(user), group_id: Number(group), message_id: id, sender: { nickname: '合成人物' + user }, message: [{ type: 'text', data: { text } }] });
function fixture(t, options = {}) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const dir = fs.mkdtempSync(path.resolve('artifacts/test-tmp/conversation-'));
  const state = new State(path.join(dir, 'state.json'));
  const config = { ...JSON.parse(fs.readFileSync('config.example.json')), onebot: { selfId: '10000', accessToken: 'synthetic-secret-token', url: 'ws://127.0.0.1:3001', timeoutMs: 1000 }, friends: ['20001', '20002'], groups: ['30001', '30002'], conversation: { enabled: true, groupReplyProbability: 1 }, realSend: true, ...options };
  const sent = [], calls = [];
  const generator = { async ready() {}, async verify() {}, async generate(...args) { calls.push(args); return '回答'; } };
  const sender = { ready: true, async send(target, text, face) { sent.push({ target, text, face }); return String(100 + sent.length); } };
  const bridge = new Bridge(config, state, generator, sender, () => {});
  t.after(async () => { bridge.pause(); await bridge.settled(); state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { config, state, bridge, sender, generator, sent, calls, dir };
}
test('probability triggers only allowlisted group text and ignored events cannot be rerolled', async t => {
  const f = fixture(t); await f.bridge.resume();
  f.bridge.accept(event(1)); f.bridge.accept(event(1)); await f.bridge.settled(); assert.equal(f.sent.length, 1);
  f.config.conversation.groupReplyProbability = 0;
  f.bridge.accept(event(2)); await f.bridge.settled();
  f.config.conversation.groupReplyProbability = 1;
  f.bridge.accept(event(2)); f.bridge.accept(event(3, '20001', '99999')); f.bridge.accept(event(4, '10000')); await f.bridge.settled(); assert.equal(f.sent.length, 1);
  f.config.conversation.groupReplyProbability = 0;
  f.bridge.accept(event(5, '20001', '', '私聊')); f.bridge.accept(event(6, '20001', '30001', '10000 你好')); await f.bridge.settled(); assert.equal(f.sent.length, 3);
});
test('rolling rate limits persist across restart and do not spend a model call on throttled work', async t => {
  const f = fixture(t); await f.bridge.resume();
  for (let i = 1; i <= 5; i++) f.bridge.accept(event(i));
  await f.bridge.settled(); assert.equal(f.calls.length, 2); assert.equal(f.sent.length, 2);
  assert.equal(f.bridge.paused, false); assert.equal(f.state.event(filterEvent(event(3), f.config, true).eventKey).reason, 'SEND_RATE_LIMIT');
  const reopened = new State(path.join(f.dir, 'state.json')); assert.equal(new Conversation(reopened).canSend(filterEvent(event(9), f.config, true), f.config), false); reopened.close();
  const scope = digest('10000:group:30002'), now = Date.now();
  for (const offset of [19000, 15000, 10000, 7000]) f.state.reserveSend(scope, now - offset);
  assert.equal(f.state.canSend(scope, now), false); assert.equal(f.state.canSend(scope, now + 1001), true);
});
test('recent context includes untriggered text and exact quote speaker, scoped personas never cross chats', async t => {
  const f = fixture(t); f.config.conversation = { enabled: true, groupReplyProbability: 0, personas: { 'group:30001': '用古风表达', 'private:20001': '用普通话' } };
  await f.bridge.resume(); f.bridge.accept(event(1, '20002', '30001', '周六去海边')); f.bridge.accept(event(2, '20002', '30002', '另一群秘密'));
  const quoted = event(3, '20001', '30001', '10000 他刚才说了什么'); quoted.message.unshift({ type: 'reply', data: { id: '1', text: '伪造的引用正文' } });
  f.bridge.accept(quoted); await f.bridge.settled();
  const context = JSON.parse(f.calls[0][4]); assert.equal(context.quoted.userId, '20002'); assert.equal(context.quoted.text, '周六去海边');
  assert.ok(!JSON.stringify(context).includes('另一群秘密')); assert.ok(!JSON.stringify(context).includes('伪造')); assert.match(f.calls[0][2], /古风/); assert.ok(!f.calls[0][2].includes('普通话'));
  const privateTarget = filterEvent(event(4, '20001', '', '问候'), f.config); assert.match(f.bridge.conversation.style(privateTarget, f.config, ''), /普通话/);
  f.bridge.conversation.clear(); assert.equal(JSON.parse(f.bridge.conversation.context(filterEvent(quoted, f.config, true), f.config)).quoteUnavailable, true);
});
test('snapshot excludes later queued messages, dry-run answers never become delivered context', async t => {
  const f = fixture(t, { realSend: false }); await f.bridge.resume();
  f.bridge.accept(event(1)); f.bridge.accept(event(2, '20002', '30001', '后来的消息')); await f.bridge.settled();
  assert.ok(!f.calls[0][4].includes('后来的消息')); assert.ok(!f.calls[1][4].includes('"role":"assistant"')); assert.equal(f.sent.length, 0);
});

test('attachment evidence survives follow-up context without crossing chats or rewriting frozen snapshots', t => {
  const f = fixture(t), conversation = f.bridge.conversation;
  const target = filterEvent(event(1, '20001', '', '[收到附件，未附文字]'), f.config);
  conversation.remember(target, f.config);
  const next = filterEvent(event(2, '20001', '', '这个梗什么意思'), f.config);
  const frozen = conversation.context(next, f.config);
  conversation.describe(target, f.config, '配字：我没事；画面：含泪微笑；可能是反话');
  const recent = JSON.parse(conversation.context(next, f.config)).recent;
  assert.equal(recent.length, 1); assert.match(recent[0].text, /含泪微笑/);
  assert.ok(!frozen.includes('含泪微笑'));
  assert.ok(!conversation.context(filterEvent(event(3, '20002', '', '另一个人'), f.config), f.config).includes('含泪微笑'));
  conversation.clear(); assert.ok(!conversation.context(next, f.config).includes('含泪微笑'));
});
test('owner speech and a verified reply to AI trigger groups even at probability zero', async t => {
  const f = fixture(t); f.config.friendAdminId = '20002'; f.config.conversation.groupReplyProbability = 0;
  await f.bridge.resume(); f.bridge.accept(event(1, '20002')); await f.bridge.settled(); assert.equal(f.sent.length, 1);
  const quoted = event(2); quoted.message.unshift({ type: 'reply', data: { id: '101' } });
  f.bridge.accept(quoted); await f.bridge.settled(); assert.equal(f.sent.length, 2);
  const other = event(3, '20001', '30002'); other.message.unshift({ type: 'reply', data: { id: '101' } });
  f.bridge.accept(other); await f.bridge.settled(); assert.equal(f.sent.length, 2);
});
test('serialized context including quoted control characters stays within its actual character budget', t => {
  const f = fixture(t), c = f.bridge.conversation;
  for (let i = 1; i <= 80; i++) c.remember(filterEvent(event(i, '20002', '30001', '\0'.repeat(1000)), f.config, true), f.config);
  const target = filterEvent(event(81), f.config, true); target.replyTo = '80';
  const context = c.context(target, f.config); assert.ok(context.length <= 6000); assert.ok(JSON.parse(context).quoted);
});
test('redaction covers outgoing replies and memory receives exactly the sanitized text', async t => {
  const f = fixture(t); f.config.conversation.redact = ['SYNTHETIC_PASSWORD'];
  f.generator.generate = async () => 'synthetic-secret-token SYNTHETIC_PASSWORD SESSDATA=abc Bearer abcdef';
  let saved; f.bridge.memory = { store: { capture() {}, recall() { return ''; }, answer(_a, _t, text) { saved = text; }, status() {} } };
  await f.bridge.resume(); f.bridge.accept(event(1)); await f.bridge.settled(); assert.equal(f.sent[0].text, saved);
  for (const secret of ['synthetic-secret-token', 'SYNTHETIC_PASSWORD', '=abc', 'abcdef']) assert.ok(!saved.includes(secret));
});
test('classic face selection uses Beijing valley boundaries and a fixed protocol ID range', t => {
  const f = fixture(t); f.config.conversation.faceProbability = 1;
  for (const time of ['2026-10-26T16:29:00Z', '2026-10-27T00:30:00Z']) assert.equal(f.bridge.conversation.face('哈哈', f.config, new Date(time), () => 0), undefined);
  for (const time of ['2026-10-26T16:30:00Z', '2026-10-27T00:29:00Z']) assert.equal(f.bridge.conversation.face('哈哈', f.config, new Date(time), () => 0), '4');
  assert.equal(f.bridge.conversation.face('a'.repeat(61), f.config, new Date('2026-10-26T17:00:00Z'), () => 0), undefined);
});
test('configuration rejects malformed probabilities, personas and redaction lists', t => {
  const f = fixture(t), file = path.join(f.dir, 'config.json');
  fs.writeFileSync(path.join(path.dirname(file), '.env'), 'ONEBOT_ACCESS_TOKEN=' + f.config.onebot.accessToken + '\n');
  for (const conversation of [null, {}, { enabled: true, groupReplyProbability: 2 }, { enabled: true, faceProbability: '0.7' }, { enabled: true, personas: { '../x': 'bad' } }, { enabled: true, redact: [''] }]) {
    fs.writeFileSync(file, JSON.stringify({ ...f.config, conversation })); assert.throws(() => readConfig(file));
  }
  fs.writeFileSync(file, JSON.stringify(f.config)); assert.equal(readConfig(file).conversation.enabled, true);
});
