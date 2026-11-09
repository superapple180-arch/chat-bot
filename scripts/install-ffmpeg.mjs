import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import ffmpeg from 'ffmpeg-static';

const sum = data => createHash('sha256').update(data).digest('hex');
const binaryHash = '04e1307997530f9cf2fe35cba2ca7e8875ca91da02f89d6c7243df819c94ad00';
if (!ffmpeg) throw Error('FFMPEG_PLATFORM_UNSUPPORTED');
const base = 'https://cdn.npmmirror.com/binaries/ffmpeg-static/b6.1.1/';
const get = async name => {
  const response = await fetch(base + name, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw Error('FFMPEG_DOWNLOAD_FAILED');
  return Buffer.from(await response.arrayBuffer());
};
if (!fs.existsSync(ffmpeg) || sum(fs.readFileSync(ffmpeg)) !== binaryHash) {
  const cached = path.resolve('.cache/ffmpeg-win32-x64.gz');
  const compressed = fs.existsSync(cached) ? fs.readFileSync(cached) : await get('ffmpeg-win32-x64.gz');
  if (sum(compressed) !== '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77') throw Error('FFMPEG_ARCHIVE_HASH_MISMATCH');
  const binary = gunzipSync(compressed);
  if (sum(binary) !== binaryHash) throw Error('FFMPEG_BINARY_HASH_MISMATCH');
  fs.writeFileSync(ffmpeg, binary);
}
for (const name of ['LICENSE', 'README']) {
  const file = ffmpeg + '.' + name;
  if (!fs.existsSync(file)) fs.writeFileSync(file, await get('win32-x64.' + name));
}
console.log('FFMPEG_VERIFIED');
