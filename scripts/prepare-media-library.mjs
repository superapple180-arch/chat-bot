import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { imageFormat } from '../dist/media-file.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const root = path.resolve('assets/media');
fs.mkdirSync(root, { recursive: true }); fs.mkdirSync('artifacts', { recursive: true });
if (fs.existsSync(path.join(root, 'index.json'))) throw Error('MEDIA_LIBRARY_ALREADY_EXISTS');
const base = 'https://zhaoolee.com/ChineseBQB/';
const response = await fetch(base + 'catalog/search.json', { redirect: 'error', signal: AbortSignal.timeout(30000) });
if (!response.ok) throw Error('MEDIA_INDEX_DOWNLOAD_FAILED');
const rows = await response.json();
const seeds = [
  ['laugh', '黑袍纠察队00004-哈哈哈', ['哈哈', '开心', '大笑', 'laugh']],
  ['thanks', '柯南00023-谢谢你', ['谢谢', '感谢', 'thank']],
  ['night', '美少女战士00083-晚安', ['晚安', '睡觉', 'night']],
  ['cheer', '柯南00044-一起加油', ['加油', '鼓励', 'cheer']],
  ['okay', '负鼠00004-改方案-好的呢-职业假笑', ['好的', '收到', '假笑', 'okay']],
  ['speechless', '觉醒年代00005-有够无语的', ['无语', 'speechless']],
  ['shy', '北方栖姬00065-害羞', ['害羞', '不好意思', 'shy']],
  ['happy', '企鹅家族00005-开心', ['开心', '高兴', 'happy']],
  ['bye', '王冰冰00015-再见', ['再见', '拜拜', 'bye']],
  ['angry', '女神异闻录00022-我生气了', ['生气', 'angry']],
  ['surprise', '猫和老鼠00018-十脸震惊', ['震惊', '惊讶', 'surprise']],
  ['like', '北方栖姬00399-给你点个赞', ['点赞', '赞', '棒', 'like']]
];
const items = [], report = [], previews = [];
for (const [id, label, tags] of seeds) {
  const row = rows.find(r => r.label === label);
  if (!row || !/^media\/[a-f0-9]{64}\.(?:png|jpe?g|gif|webp)$/.test(row.src)) throw Error('SEED_NOT_FOUND: ' + label);
  const url = base + row.src, download = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  if (!download.ok) throw Error('SEED_DOWNLOAD_FAILED: ' + id);
  const bytes = Buffer.from(await download.arrayBuffer()), format = await imageFormat(bytes), file = id + '.' + format;
  fs.writeFileSync(path.join(root, file), bytes);
  items.push({ id, kind: 'sticker', file, description: label.replace(/^.*?\d+-/, ''), tags, source: new URL(row.categoryUrl, base).href });
  const m = await sharp(bytes, { animated: true }).metadata();
  report.push({ id, label, url, file, bytes: bytes.length, width: m.width, height: m.pageHeight ?? m.height, frames: m.pages ?? 1, verifiedFormat: format });
  const image = await sharp(bytes).resize(230, 200, { fit: 'inside', background: 'white' }).extend({ top: 0, bottom: 30, left: 0, right: 0, background: 'white' }).png().toBuffer();
  const tile = await sharp({ create: { width: 250, height: 250, channels: 3, background: 'white' } }).composite([{ input: image, gravity: 'north' }, { input: Buffer.from(`<svg width="250" height="30"><text x="10" y="23" font-size="18">${id}</text></svg>`), top: 220, left: 0 }]).png().toBuffer();
  const i = items.length - 1; previews.push({ input: tile, left: (i % 4) * 250, top: Math.floor(i / 4) * 250 });
  console.log('DOWNLOADED', id, bytes.length, m.pages ?? 1);
}
fs.writeFileSync(path.join(root, 'index.json'), JSON.stringify(items, null, 2));
fs.writeFileSync('artifacts/media-library-validation.json', JSON.stringify({ at: new Date().toISOString(), source: 'https://github.com/zhaoolee/ChineseBQB', items: report, visualReview: 'pending' }, null, 2));
await sharp({ create: { width: 1000, height: 750, channels: 3, background: 'white' } }).composite(previews).png().toFile('artifacts/media-library-preview.png');
