import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { BridgeError } from './types.js';

export const maxImageBytes = 10 * 1024 * 1024;
export async function imageFormat(data: Buffer) {
  try {
    if (!data.length || data.length > maxImageBytes) throw Error();
    const image = sharp(data, { animated: true, limitInputPixels: 80000000, failOn: 'warning' });
    const m = await image.metadata();
    if (!['png', 'jpeg', 'webp', 'gif'].includes(m.format ?? '') || !m.width || !m.height || m.width > 12000 || (m.pageHeight ?? m.height) > 12000 || (m.pages ?? 1) > 300 || m.width * m.height > 80000000) throw Error();
    await image.stats();
    return m.format === 'jpeg' ? 'jpg' : m.format!;
  } catch { throw new BridgeError('INVALID_IMAGE_FILE', 'MEDIA'); }
}
export function insideMedia(file: string, root: string) {
  const resolved = fs.realpathSync(file), relative = path.relative(fs.realpathSync(root), resolved);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative) || !fs.statSync(resolved).isFile()) throw new BridgeError('MEDIA_PATH_DENIED', 'MEDIA');
  return resolved;
}
