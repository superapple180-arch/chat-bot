import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { Media, canOfferMedia, explicitMedia, mediaUrl } from '../dist/media.js';
import { imageFormat } from '../dist/media-file.js';
import { parseChoice } from '../dist/reply.js';
import { Bridge } from '../dist/bridge.js';
import { State } from '../dist/state.js';
import { ChatStore } from '../dist/chat.js';
import { BridgeError } from '../dist/types.js';
import { readConfig } from '../dist/config.js';
import { publicConfig, saveWebConfig } from '../dist/web-config.js';

const item = { id: 'happy', kind: 'sticker', file: 'happy.png', description: '开心笑脸', tags: ['开心', '哈哈'], source: 'https://github.com/zhaoolee/ChineseBQB' };
const choice = { kind: 'sticker', text: '哈哈', mediaId: 'happy' };
const bqbUrl = 'https://zhaoolee.com/ChineseBQB/media/' + 'a'.repeat(64) + '.png';
const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: '#3366ff' } }).png().toBuffer();
function fixture(t, cleanup = true) {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/media-'));
  fs.mkdirSync(path.join(root, 'assets/media'), { recursive: true }); fs.mkdirSync(path.join(root, 'state'), { recursive: true });
  if (cleanup) t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
async function library(root, rows = [item]) {
  fs.writeFileSync(path.join(root, 'assets/media/happy.png'), await png());
  fs.writeFileSync(path.join(root, 'assets/media/index.json'), JSON.stringify(rows));
}
function config() {
  const c = JSON.parse(fs.readFileSync('config.example.json'));
  return { ...c, media: { enabled: true, online: true }, provider: 'antigravity', antigravity: { executable: 'test.exe', model: '', timeoutMs: 1000 }, friends: ['20001'], groups: ['30001'], replyAll: false, realSend: true, conversation: { enabled: false }, voice: { enabled: false }, onebot: { ...c.onebot, selfId: '10000', accessToken: 'synthetic-media-token-00000' } };
}
function event(id = 1, text = '发个开心的表情包', group = false) {
  return { post_type: 'message', message_type: group ? 'group' : 'private', sub_type: 'friend', self_id: '10000', user_id: '20001', message_id: id,
    ...(group ? { group_id: '30001' } : {}), message: [...(group ? [{ type: 'at', data: { qq: '10000' } }] : []), { type: 'text', data: { text } }] };
}

test('unified reply choices preserve text and voice, accept only opaque ID or bounded query and never arbitrary paths or mixed forms', () => {
  assert.deepEqual(parseChoice('普通文字', [], false, true), { kind: 'text', text: '普通文字' });
  assert.deepEqual(parseChoice(JSON.stringify(choice), [], true, true), choice);
  assert.deepEqual(parseChoice('```json\n{"kind":"image","text":"","query":"cat"}\n```', [], false, true), { kind: 'image', text: '', query: 'cat' });
  assert.equal(parseChoice('{"kind":"tts","text":"晚安"}', [], true, true).kind, 'tts');
  assert.equal(parseChoice('{"kind":"clip","clipId":"night"}', [{ id: 'night', text: '晚安' }], true, true).text, '晚安');
  for (const row of [{ ...choice, query: 'cat' }, { ...choice, mediaId: '../secret' }, { ...choice, file: 'secret.png' }, { kind: 'image', text: '', query: 'https://example.com/a' }, { kind: 'image', text: '', query: 'x'.repeat(81) }, { kind: 'image', text: '' }, { ...choice, query: '' }]) assert.throws(() => parseChoice(JSON.stringify(row), [], true, true), { code: 'INVALID_REPLY_CHOICE' });
  assert.throws(() => parseChoice(JSON.stringify(choice), [], true, false), { code: 'INVALID_REPLY_CHOICE' });
  assert.throws(() => parseChoice('{"kind":"tts","text":"x"}', [], false, true), { code: 'INVALID_REPLY_CHOICE' });
});

test('explicit requests override cooldown; unsolicited media needs both 60 seconds and two intervening AI replies', () => {
  const t = { key: 'scope', text: '哈哈' }, h = { scope: { at: 100000, turns: 2 } };
  assert.equal(canOfferMedia(t, h, 159999), false); assert.equal(canOfferMedia(t, h, 160000), true);
  h.scope.turns = 1; assert.equal(canOfferMedia(t, h, 200000), false);
  for (const text of ['给我一张猫的图片', '来个表情包', '斗图', '找一张风景图']) { assert.ok(explicitMedia(text)); assert.ok(canOfferMedia({ ...t, text }, h, 100001)); }
  assert.equal(canOfferMedia({ ...t, text: '不要发表情包' }), false);
  const photoOnly = { ...t, text: '请找一张家猫照片，不要表情包，也不要语音' };
  assert.ok(explicitMedia(photoOnly.text, 'image')); assert.ok(canOfferMedia(photoOnly, h, 100001, 'image'));
  assert.equal(canOfferMedia(photoOnly, h, 100001, 'sticker'), false);
  assert.equal(canOfferMedia({ ...t, text: '不要发图' }), false);
  assert.ok(explicitMedia('请查找并发送名称为 QQ_MEDIA_NONEXISTENT_9fc82d 的图片，找不到就说找不到', 'image'));
});

test('local media is preferred, model catalog omits paths and sources, bytes are deduplicated without changing GIF or PNG', async t => {
  const root = fixture(t); await library(root); let network = 0;
  const service = new Media(root, async () => { network++; throw Error(); });
  const prompt = service.prompt({ text: '开心', key: 'scope' }, config(), {}, s => s);
  assert.ok(prompt.includes('happy')); assert.ok(!prompt.includes('happy.png')); assert.ok(!prompt.includes(item.source));
  const a = await service.prepare(choice, config()), b = await service.prepare({ kind: 'sticker', text: '', query: '开心' }, config());
  assert.equal(a.file, b.file); assert.equal(network, 0); assert.deepEqual(fs.readFileSync(a.file), fs.readFileSync(path.join(root, 'assets/media/happy.png')));
  a.dispose(); assert.ok(fs.existsSync(b.file + '.hold')); b.dispose(); assert.ok(!fs.existsSync(a.file + '.hold'));
});

test('invalid catalogs, traversal, directory links, corrupt, oversized and unapproved formats cannot become sendable media', async t => {
  const root = fixture(t), service = new Media(root); await library(root);
  for (const rows of [[item, item], [{ ...item, id: '../escape' }], [{ ...item, tags: 'bad' }]]) {
    await library(root, rows); assert.throws(() => service.catalog(), { code: 'INVALID_MEDIA_CATALOG' });
  }
  await library(root, [{ ...item, file: '../../secret.png' }]); fs.writeFileSync(path.join(root, 'secret.png'), await png());
  await assert.rejects(service.prepare(choice, config()), { code: 'MEDIA_PATH_DENIED' });
  await library(root); fs.writeFileSync(path.join(root, 'assets/media/happy.png'), 'not an image');
  await assert.rejects(service.prepare(choice, config()), { code: 'INVALID_IMAGE_FILE' });
  fs.writeFileSync(path.join(root, 'assets/media/happy.png'), Buffer.alloc(10 * 1024 * 1024 + 1));
  await assert.rejects(service.prepare(choice, config()), { code: 'MEDIA_TOO_LARGE' });
  await assert.rejects(imageFormat(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')), { code: 'INVALID_IMAGE_FILE' });
  await assert.rejects(imageFormat(await sharp({ create: { width: 12001, height: 1, channels: 3, background: 'red' } }).png().toBuffer()), { code: 'INVALID_IMAGE_FILE' });
});

test('online URLs use only fixed HTTPS sources; credentials, local hosts, ports and path escapes are denied', () => {
  assert.equal(mediaUrl(bqbUrl).href, bqbUrl);
  for (const url of ['http://zhaoolee.com/ChineseBQB/catalog/search.json', 'https://evil.example/image.png', 'https://127.0.0.1/a', 'https://upload.wikimedia.org:444/wikipedia/commons/a.png', 'https://u:p@zhaoolee.com/ChineseBQB/catalog/search.json', 'https://zhaoolee.com/ChineseBQB/../../secret']) assert.throws(() => mediaUrl(url), { code: 'MEDIA_URL_DENIED' });
});

test('linked subdirectories cannot escape the registered local media library', async t => {
  const root = fixture(t); await library(root, [{ ...item, file: 'escape/secret.png' }]);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, 'secret.png'), await png());
  fs.symlinkSync(outside, path.join(root, 'assets/media/escape'), 'junction');
  await assert.rejects(new Media(root).prepare(choice, config()), { code: 'MEDIA_PATH_DENIED' });
});

test('redirect/download errors and over-limit streamed bodies cannot reach the visual inspector', async t => {
  const root = fixture(t); let inspected = 0;
  const service = new Media(root, async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (String(url).includes('api.php')) return Response.json({ query: { pages: [{ title: 'File:Cat.png', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/cat.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.png', mime: 'image/png', size: 1 }] }] } });
    return new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(10 * 1024 * 1024)); controller.enqueue(new Uint8Array(1)); controller.close(); } }));
  }, async () => { inspected++; return { match: true, description: 'x' }; });
  await assert.rejects(service.prepare({ kind: 'image', text: '', query: 'cat' }, config()), { code: 'MEDIA_NOT_FOUND' });
  assert.equal(inspected, 0);
  const denied = new Media(root, async () => { throw TypeError('redirect refused'); });
  await assert.rejects(denied.prepare({ kind: 'image', text: '', query: 'cat' }, config()), /redirect refused/);
});

function networkFixture(root, options = {}) {
  const urls = [], inspections = []; let downloads = 0;
  const fetcher = async (url, init) => {
    urls.push(String(url)); assert.equal(init.redirect, 'error');
    if (String(url).includes('search.json')) return Response.json([{ src: new URL(bqbUrl).pathname.replace('/ChineseBQB/', ''), label: '网上新词', categoryTitle: '网上新词' }, ...(options.second ? [{ src: 'media/' + 'b'.repeat(64) + '.png', label: '网上新词', categoryTitle: '网上新词' }] : [])]);
    if (String(url).includes('api.php')) return Response.json({ query: { pages: [{ title: 'File:Cat.png', imageinfo: [{ url: 'https://upload.wikimedia.org/wikipedia/commons/a/cat.png', mime: 'image/png', size: 100, descriptionurl: 'https://commons.wikimedia.org/wiki/File:Cat.png', extmetadata: { Artist: { value: 'Author' }, LicenseShortName: { value: 'CC BY' } } }] }] } });
    downloads++;
    if (options.abort) options.abort.abort();
    if (options.big) return new Response('x', { headers: { 'content-length': String(11 * 1024 * 1024) } });
    if (options.fail) throw Error('offline');
    return new Response(await png());
  };
  const service = new Media(root, fetcher, async (file, query) => {
    inspections.push(query); return { match: options.match ?? true, description: '核验过的图片' };
  });
  return { service, urls, inspections, downloads: () => downloads };
}

for (const kind of ['sticker', 'image']) test(`online ${kind} is inspected before use, cached with attribution and reused locally`, async t => {
  const f = networkFixture(fixture(t));
  const query = kind === 'sticker' ? '网上新词' : 'cat';
  const prepared = await f.service.prepare({ kind, text: '', query }, config());
  assert.equal(f.inspections.length, 1); assert.ok(prepared.description.includes('核验'));
  assert.ok(prepared.source.includes(kind === 'sticker' ? 'ChineseBQB' : 'Author · CC BY')); prepared.dispose();
  const count = f.urls.length, again = await f.service.prepare({ kind, text: '', query }, config());
  assert.equal(f.urls.length, count); assert.equal(again.file, prepared.file); again.dispose();
});

test('online rejection inspects at most two candidates, never substitutes random media, and offline mode never searches', async t => {
  const f = networkFixture(fixture(t), { second: true, match: false });
  await assert.rejects(f.service.prepare({ kind: 'sticker', text: '', query: '网上新词' }, config()), { code: 'MEDIA_NOT_FOUND' });
  assert.equal(f.inspections.length, 2); assert.equal(f.downloads(), 2);
  await assert.rejects(f.service.prepare({ kind: 'sticker', text: '', query: '没有任何匹配zz' }, config()), { code: 'MEDIA_NOT_FOUND' });
  const before = f.urls.length;
  await assert.rejects(f.service.prepare({ kind: 'image', text: '', query: 'cat' }, { ...config(), media: { enabled: true, online: false } }), { code: 'MEDIA_NOT_FOUND' });
  assert.equal(f.urls.length, before);
});

test('online sticker candidates favor the requested character before semantic selection, then inspect only the selected images', async t => {
  const root = fixture(t), seen = [];
  const service = new Media(root, async url => String(url).includes('search.json') ? Response.json([
    { src: 'media/' + 'a'.repeat(64) + '.png', label: '其他角色-疑惑', categoryTitle: '其他角色表情包' },
    { src: 'media/' + 'b'.repeat(64) + '.png', label: '另一个角色-疑惑', categoryTitle: '另一个角色' },
    { src: 'media/' + 'c'.repeat(64) + '.png', label: '熊猫-搬砖问号', categoryTitle: '金馆长熊猫' }
  ]) : new Response(await png()), async () => ({ match: true, description: '熊猫问号' }), async (query, rows) => {
    seen.push(...rows); assert.ok(rows[0].description.includes('熊猫')); return [rows[0]];
  });
  const prepared = await service.prepare({ kind: 'sticker', text: '', query: '熊猫头 疑惑 表情包' }, config());
  assert.equal(seen.length, 3); assert.equal(prepared.description, '熊猫问号'); prepared.dispose();
});

test('oversized responses and cancellation release cache holds without accepting the candidate', async t => {
  const f = networkFixture(fixture(t), { big: true });
  await assert.rejects(f.service.prepare({ kind: 'image', text: '', query: 'cat' }, config()), { code: 'MEDIA_NOT_FOUND' });
  assert.equal(f.inspections.length, 0);
  const controller = new AbortController(), g = networkFixture(fixture(t), { abort: controller });
  await assert.rejects(g.service.prepare({ kind: 'image', text: '', query: 'cat' }, config(), controller.signal), { code: 'PAUSED' });
  assert.ok(!fs.readdirSync(path.join(g.service.root, 'state/media')).some(n => n.endsWith('.hold')));
});

test('cache cap evicts oldest unused data, protects active and uncertain images, and expires old holds', async t => {
  const root = fixture(t), service = new Media(root); await library(root);
  const prepared = await service.prepare(choice, config()), cache = path.join(root, 'state/media');
  const old = path.join(cache, 'f'.repeat(64) + '.png');
  fs.writeFileSync(old, Buffer.alloc(1)); fs.truncateSync(old, 200 * 1024 * 1024); fs.utimesSync(old, new Date(0), new Date(0));
  service.cleanup(); assert.ok(!fs.existsSync(old)); assert.ok(fs.existsSync(prepared.file));
  prepared.dispose(true); service.cleanup(200 * 1024 * 1024 - fs.statSync(prepared.file).size); assert.ok(fs.existsSync(prepared.file));
  fs.utimesSync(prepared.file + '.hold', new Date(0), new Date(0)); service.cleanup(200 * 1024 * 1024);
  assert.ok(!fs.existsSync(prepared.file));
});

async function bridgeFixture(t, raw = JSON.stringify(choice)) {
  const root = fixture(t, false); await library(root);
  const state = new State(path.join(root, 'state/events.json')), chat = new ChatStore(path.join(root, 'state/chat.sqlite'));
  const c = config(), sent = [], answers = [], logs = [], requests = [];
  const sender = { ready: true, async send(target, text) { sent.push({ kind: 'text', target: target.id, text }); return '123'; }, async sendImage(target, file, text, signal) { assert.ok(!signal.aborted); sent.push({ kind: 'image', target: target.id, file, text }); return '124'; } };
  const generator = { async ready() {}, async verify() {}, async generate(...args) { requests.push(args); return typeof raw === 'function' ? raw() : raw; } };
  const memory = { store: { capture() {}, recall() {}, status() {}, answer(a, target, text) { answers.push(text); } } };
  const media = new Media(root);
  const bridge = new Bridge(c, state, generator, sender, (...args) => logs.push(args), memory, undefined, undefined, chat, undefined, media);
  t.after(async () => { bridge.pause(); await bridge.settled(); state.close(); chat.close(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.resume(); return { root, state, chat, c, sent, answers, logs, requests, sender, generator, media, bridge };
}

for (const group of [false, true]) test(`bridge sends one image to original ${group ? 'group' : 'private'} target and stores actual description/source`, async t => {
  const f = await bridgeFixture(t); f.bridge.accept(event(1, undefined, group)); await f.bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'image'); assert.equal(f.sent[0].target, group ? '30001' : '20001');
  assert.ok(f.answers[0].includes('开心笑脸')); assert.ok(f.answers[0].includes(item.source));
  assert.equal(f.bridge.paused, false); assert.equal(Object.values(f.state.events())[0].status, 'sent');
  assert.ok(f.chat.messages('10000', group ? 'group' : 'private', group ? '30001' : '20001').some(m => m.body.includes('开心笑脸')));
  assert.equal(Object.values(f.state.data.mediaHistory)[0].turns, 0);
});

test('bridge performs bounded preparation in dry run without calling any send or consuming frequency allowance', async t => {
  const f = await bridgeFixture(t); f.c.realSend = false;
  f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(f.sent.length, 0); assert.ok(f.logs.some(r => r[1] === 'DRY_RUN_IMAGE_PREPARED')); assert.equal(f.state.data.mediaHistory, undefined);
});

test('requesting a normal image while refusing stickers still sends the image and its attribution', async t => {
  const f = await bridgeFixture(t, '{"kind":"image","text":"蓝色方块","mediaId":"blue"}');
  await library(f.root, [{ ...item, id: 'blue', kind: 'image', description: '蓝色方块', tags: ['蓝色', '方块'] }]);
  f.bridge.accept(event(1, '请发送蓝色方块的图片，不要表情包，也不要语音')); await f.bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'image'); assert.ok(f.sent[0].text.includes('来源：'));
  assert.equal(f.bridge.paused, false);
});

test('preparation failure falls back before sending; never records a nonexistent image or loses the text reply', async t => {
  const f = await bridgeFixture(t, '{"kind":"image","text":"给你图片","query":"unfindable"}');
  f.media.prepare = async () => { throw Error('offline'); };
  f.bridge.accept(event(1, '请发一张图片')); await f.bridge.settled();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'text'); assert.match(f.sent[0].text, /没找到合适/);
  assert.equal(f.bridge.paused, false); assert.equal(f.answers[0], f.sent[0].text);
});

test('cooldown blocks unsolicited pictures, two text turns restore eligibility, and explicit requests still work after restart', async t => {
  let raw = JSON.stringify(choice); const f = await bridgeFixture(t, () => raw);
  f.bridge.accept(event()); await f.bridge.settled();
  f.bridge.accept(event(2, '哈哈')); await f.bridge.settled(); assert.equal(f.sent.at(-1).kind, 'text');
  raw = '{"kind":"text","text":"接着聊"}'; f.bridge.accept(event(3, '继续')); await f.bridge.settled();
  assert.equal(Object.values(f.state.data.mediaHistory)[0].turns, 2);
  raw = JSON.stringify(choice); f.bridge.accept(event(4)); await f.bridge.settled(); assert.equal(f.sent.at(-1).kind, 'image');
  const reloaded = JSON.parse(fs.readFileSync(path.join(f.root, 'state/events.json'), 'utf8'));
  assert.equal(Object.values(reloaded.mediaHistory)[0].turns, 0);
});

for (const uncertain of [false, true]) test(`image send ${uncertain ? 'uncertainty' : 'rejection'} pauses without fallback or retry`, async t => {
  const f = await bridgeFixture(t); let attempts = 0;
  f.sender.sendImage = async () => { attempts++; throw new BridgeError(uncertain ? 'QQ_SEND_UNCERTAIN' : 'QQ_SEND_REJECTED', 'QQ_SEND_FAILED', uncertain); };
  f.bridge.accept(event()); await f.bridge.settled(); f.bridge.accept(event()); await f.bridge.settled();
  assert.equal(attempts, 1); assert.equal(f.sent.length, 0); assert.ok(f.bridge.paused);
  assert.equal(Object.values(f.state.events())[0].status, uncertain ? 'uncertain' : 'failed');
  const holds = fs.readdirSync(path.join(f.root, 'state/media')).filter(n => n.endsWith('.hold')); assert.equal(holds.length, uncertain ? 1 : 0);
});

test('pause during media preparation cancels without sending; search keywords are sanitized before leaving the bridge', async t => {
  const f = await bridgeFixture(t, '{"kind":"image","text":"","query":"cat synthetic-media-token-00000 12345678"}');
  let query;
  f.media.prepare = async (choice, c, signal) => { query = choice.query; f.bridge.pause(); throw new BridgeError('PAUSED'); };
  f.bridge.accept(event(1, '请找一张猫的图片')); await f.bridge.settled(); assert.equal(f.sent.length, 0); assert.equal(query, 'cat');
});

test('media config defaults off, validates flags/provider and round-trips through web settings', t => {
  const root = fixture(t), file = path.join(root, 'config.local.json'), c = config();
  fs.writeFileSync(path.join(root, '.env'), 'ONEBOT_ACCESS_TOKEN=' + c.onebot.accessToken + '\n');
  fs.writeFileSync(file, JSON.stringify(c)); assert.deepEqual(readConfig(file).media, c.media);
  const publicValue = publicConfig(root); publicValue.config.media.online = false;
  assert.equal(saveWebConfig(root, publicValue).config.media.online, false);
  for (const media of [null, {}, { enabled: true }, { enabled: 'yes', online: true }, { enabled: true, online: true, url: 'x' }]) { fs.writeFileSync(file, JSON.stringify({ ...c, media })); assert.throws(() => readConfig(file), { code: 'INVALID_MEDIA_CONFIG' }); }
  const { media, ...old } = c; fs.writeFileSync(file, JSON.stringify(old)); assert.equal(readConfig(file).media, undefined);
  fs.writeFileSync(file, JSON.stringify({ ...c, provider: 'gemini' })); assert.throws(() => readConfig(file), { code: 'INVALID_MEDIA_CONFIG' });
});
