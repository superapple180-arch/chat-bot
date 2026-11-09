import fs from 'node:fs';
import path from 'node:path';

const [file, , name] = process.argv.slice(2);
console.log = (...args) => console.error(...args);
try {
  let text;
  const extension = path.extname(name).toLowerCase();
  if (['.txt', '.md', '.csv', '.tsv', '.json', '.log'].includes(extension)) {
    const data = fs.readFileSync(file);
    text = new TextDecoder(data[0] === 0xff && data[1] === 0xfe ? 'utf-16le' : 'utf-8', { fatal: true }).decode(data);
  } else if (extension === '.docx') {
    const mammoth = (await import('mammoth')).default;
    text = (await mammoth.extractRawText({ path: file }, { externalFileAccess: false })).value;
  } else if (extension === '.pdf') {
    const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const loading = getDocument({ data: new Uint8Array(fs.readFileSync(file)), isEvalSupported: false, useSystemFonts: true, verbosity: 0 });
    try {
      const doc = await loading.promise, pages = [];
      for (let page = 1; page <= Math.min(doc.numPages, 20); page++) {
        pages.push((await (await doc.getPage(page)).getTextContent()).items.map(x => x.str ?? '').join(' '));
        if (pages.join('\n').length > 12000) break;
      }
      text = pages.join('\n') + (doc.numPages > 20 ? '\n[仅提取前20页]' : '');
    } finally { await loading.destroy(); }
  } else throw Error('UNSUPPORTED_FILE_TYPE');
  if (text.length > 12000) text = text.slice(0, 11970) + '\n[内容过长 已截断]';
  if (!text?.trim()) throw Error('NO_READABLE_CONTENT');
  process.stdout.write(JSON.stringify({ text }));
} catch { process.stdout.write(JSON.stringify({ error: 'ATTACHMENT_PARSE_FAILED' })); process.exitCode = 1; }
