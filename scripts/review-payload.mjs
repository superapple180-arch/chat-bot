import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { inventory, localProtectedValues } from './release-privacy.mjs';
const require = createRequire(import.meta.url);
const electron = path.join(path.dirname(require.resolve('electron/package.json')), 'dist');
let originals;
function referenceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => item.isDirectory() ? referenceFiles(path.join(directory, item.name)) : item.isFile() ? [path.join(directory, item.name)] : []);
}
export function reviewPayload(root, protectedValues = []) {
  return inventory(root, protectedValues, [], (file, data, matches) => {
    if (file.endsWith('.asar') && fs.existsSync(file + '.contents')) return '同一安装包内已实际解包并逐文件检查的 ASAR 容器';
    const leaf = path.basename(file);
    const containsAll = source => {
      const text = source.toString('latin1') + '\n' + source.toString('utf16le');
      return matches.every(match => text.includes(match.value));
    };
    if (leaf === 'node.exe' || leaf === 'node') {
      const original = path.resolve('.cache/desktop/node', process.platform === 'win32' ? 'node.exe' : 'bin/node');
      if (fs.existsSync(original)) {
        const source = fs.readFileSync(original);
        if (source.equals(data)) return '构建时按发行校验清单验证的 Node 原始二进制';
        if (containsAll(source)) return '签名后 Node 的全部命中均存在于已验证的原始发行二进制';
      }
    }
    const marker = file.replaceAll('\\', '/').lastIndexOf('/backend/node_modules/');
    if (marker >= 0) {
      const suffix = file.replaceAll('\\', '/').slice(marker + '/backend/node_modules/'.length);
      const modules = path.resolve('node_modules'), original = path.resolve(modules, suffix);
      if (!path.relative(modules, original).startsWith('..') && fs.existsSync(original)) {
        const source = fs.readFileSync(original);
        if (source.equals(data)) return '与锁定生产依赖原文件逐字节一致的上游公开样例或编译元数据';
        if (containsAll(source) && data.includes(0)) return '生产依赖原始二进制中已存在的公开编译元数据';
      }
    }
    originals ??= referenceFiles(electron);
    const names = new Set([leaf, ...(leaf === 'chat-bot.exe' ? ['electron.exe'] : leaf === 'chat-bot' ? ['electron', 'Electron'] : [])]);
    for (const original of originals.filter(item => names.has(path.basename(item)))) {
      const source = fs.readFileSync(original);
      if (source.equals(data)) return '已经发行校验验证的 Electron 原始资源';
      if (['chat-bot.exe', 'chat-bot'].includes(leaf)) {
        if (containsAll(source)) return '定制 Electron 可执行文件的全部命中均存在于原始发行二进制';
      }
    }
  });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = reviewPayload(path.resolve(process.argv[2]), localProtectedValues(process.cwd()));
  console.log(JSON.stringify({ checkedFiles: result.files.length, digest: result.digest, findings: result.findings, vendorReviewed: result.vendorReviewed }));
  if (result.findings.length) process.exitCode = 1;
}
