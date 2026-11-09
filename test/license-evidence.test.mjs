import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { verifyUpstreamGrant } from '../scripts/audit-source-licenses.mjs';

test('upstream license clearance requires the locked version, integrity, fixed commit and unchanged full grant', t => {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/license-evidence-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'licenses'));
  const text = fs.readFileSync('LICENSE', 'utf8'), file = 'licenses/UPSTREAM-MIT.txt'; fs.writeFileSync(path.join(root, file), text);
  const evidence = { version: '1.0.0', integrity: 'synthetic-archive-integrity', commit: 'a'.repeat(40), files: [{ file, sha256: createHash('sha256').update(text).digest('hex') }] };
  const verify = (entry = evidence, license = 'MIT') => verifyUpstreamGrant(root, entry, '1.0.0', evidence.integrity, license);
  assert.equal(verify(), true);
  for (const patch of [{ version: '1.0.1' }, { integrity: 'different-archive' }, { commit: 'main' }, { files: [] }, { files: [{ ...evidence.files[0], file: '../LICENSE' }] }]) assert.equal(verify({ ...evidence, ...patch }), false);
  assert.equal(verify(evidence, 'LGPL-3.0-or-later'), false);
  fs.appendFileSync(path.join(root, file), '\nChanged grant'); assert.equal(verify(), false);
});

test('the build tool Apache license cannot clear an LGPL binary dependency', t => {
  fs.mkdirSync('artifacts/test-tmp', { recursive: true });
  const root = fs.mkdtempSync(path.resolve('artifacts/test-tmp/lgpl-evidence-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'licenses'));
  const text = 'Apache License\nVersion 2.0, January 2004', file = 'licenses/builder.txt'; fs.writeFileSync(path.join(root, file), text);
  const evidence = { version: '1.0.0', integrity: 'synthetic-integrity', commit: 'b'.repeat(40), files: [{ file, sha256: createHash('sha256').update(text).digest('hex') }] };
  assert.equal(verifyUpstreamGrant(root, evidence, evidence.version, evidence.integrity, 'LGPL-3.0-or-later'), false);
});
