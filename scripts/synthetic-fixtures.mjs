import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';

export async function fixtureBuffers() {
  const zip = new JSZip(), options = { date: new Date('2000-01-01T00:00:00Z') };
  zip.file('_rels/', null, { ...options, dir: true }); zip.file('word/', null, { ...options, dir: true });
  zip.file('[Content_Types].xml', '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>', options);
  zip.file('_rels/.rels', '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>', options);
  zip.file('word/document.xml', '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>ATTACHMENT_DOCX_SAMPLE</w:t></w:r></w:p></w:body></w:document>', options);
  const docx = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const stream = 'BT /F1 12 Tf 40 740 Td (ATTACHMENT_PDF_SAMPLE) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const start = Buffer.byteLength(pdf);
  pdf += `xref\n0 6\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return { 'attachment.docx': docx, 'attachment.pdf': Buffer.from(pdf) };
}
export async function makeFixtures(directory) {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of Object.entries(await fixtureBuffers())) fs.writeFileSync(path.join(directory, name), bytes);
}
