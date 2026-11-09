import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventory, localProtectedValues, forbiddenPublicFile } from './release-privacy.mjs';
import { makeFixtures } from './synthetic-fixtures.mjs';
import { syntheticIdentities } from './synthetic-identities.mjs';

const root = process.cwd(), target = path.resolve(process.argv[2] ?? `.cache/public-source-${Date.now()}`);
if (!path.relative(path.resolve('.cache'), target) || path.relative(path.resolve('.cache'), target).startsWith('..') || fs.existsSync(target)) throw Error('FRESH_PROJECT_LOCAL_EXPORT_REQUIRED');
fs.mkdirSync(target, { recursive: true });
const excluded = new Set(['node_modules', '.git', 'fixtures', 'send-completion.mjs']);
for (const directory of ['src', 'test', 'web', 'desktop', 'desktop-app', 'scripts', '.github', '.githooks']) {
  if (!fs.existsSync(directory)) continue;
  fs.cpSync(directory, path.join(target, directory), { recursive: true, filter: file => !excluded.has(path.basename(file)) && !forbiddenPublicFile(file) && !fs.lstatSync(file).isSymbolicLink() });
}
for (const file of ['package.json', 'package-lock.json', 'tsconfig.json', 'config.example.json', 'config.antigravity.example.json', 'requirements-voice.txt', '.env.example', '.npmrc', '.gitignore', '.gitattributes', 'LICENSE', 'electron-builder.config.cjs']) fs.copyFileSync(file, path.join(target, file));
fs.copyFileSync('README.public.md', path.join(target, 'README.md'));
fs.copyFileSync('THIRD_PARTY.public.md', path.join(target, 'THIRD_PARTY.md'));
fs.copyFileSync('THIRD_PARTY.public.md', path.join(target, 'THIRD_PARTY.public.md'));
fs.copyFileSync('README.public.md', path.join(target, 'README.public.md'));
fs.mkdirSync(path.join(target, 'docs'), { recursive: true });
fs.copyFileSync('docs/DESKTOP_APP.md', path.join(target, 'docs/DESKTOP_APP.md'));
for (const file of ['PUBLIC_SOURCE_AUDIT.json', 'PUBLIC_SOURCE_AUDIT.md']) fs.copyFileSync(path.join('docs', file), path.join(target, 'docs', file));
for (const kind of ['media', 'voice']) { fs.mkdirSync(path.join(target, 'assets', kind), { recursive: true }); fs.writeFileSync(path.join(target, 'assets', kind, 'index.json'), '[]\n'); }
const example = path.join(target, 'config.example.json'), config = JSON.parse(fs.readFileSync(example));
if (config.gemini) config.gemini.directory = 'Gemini';
fs.writeFileSync(example, JSON.stringify(config, null, 2) + '\n');
const legacySmoke = path.join(target, 'scripts/driver-smoke.mjs');
const legacyText = fs.readFileSync(legacySmoke, 'utf8');
if (!/^const directory = .+;$/m.test(legacyText)) throw Error('LEGACY_SMOKE_PATH_REQUIRES_REVIEW');
fs.writeFileSync(legacySmoke, legacyText.replace(/^const directory = .+;$/m, "const directory = JSON.parse(fs.readFileSync('config.local.json', 'utf8')).gemini.directory;"));
// Existing private local history is deliberately not copied. Replace any old
// account-specific numeric fixtures consistently within this export only.
let accounts = [];
if (fs.existsSync('config.local.json')) { const c = JSON.parse(fs.readFileSync('config.local.json')); accounts = [...new Set([c.onebot?.selfId, c.friendAdminId, ...(c.friends ?? []), ...(c.groups ?? [])].filter(v => typeof v === 'string' && /^\d{5,}$/.test(v)))]; }
function sanitize(directory) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) sanitize(file);
    else if ((/\.(?:mjs|cjs|ts|tsx|json|md|css|html|yml|yaml|nsh|ps1|txt|py)$/.test(item.name) || ['LICENSE', '.npmrc', '.gitignore', '.gitattributes', 'pre-push'].includes(item.name)) && !item.name.includes('lock')) {
      let text = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
      if (path.relative(target, file).replaceAll('\\', '/').startsWith('test/')) accounts.forEach((account, i) => { text = text.replace(new RegExp(`(?<![a-zA-Z0-9_])${account}(?![a-zA-Z0-9_])`, 'g'), String(900000001 + i)); });
      fs.writeFileSync(file, text);
    }
  }
}
sanitize(target); const identities = syntheticIdentities(target); await makeFixtures(path.join(target, 'test/fixtures'));
// Bind review inputs to the final reviewed transformations, including normalized line endings.
const auditFile = path.join(target, 'docs/PUBLIC_SOURCE_AUDIT.json');
const audit = JSON.parse(fs.readFileSync(auditFile, 'utf8'));
for (const entry of audit.inputs) entry.sha256 = createHash('sha256').update(fs.readFileSync(path.join(target, entry.file))).digest('hex');
fs.writeFileSync(auditFile, JSON.stringify(audit, null, 2) + '\n');
const result = inventory(target, localProtectedValues(root));
fs.mkdirSync('artifacts', { recursive: true });
fs.writeFileSync('artifacts/release-source-review.json', JSON.stringify({ export: path.relative(root, target), digest: result.digest, files: result.files.length, findings: result.findings, syntheticIdentities: identities, manualChecks: ['真名及私人邮箱', '电脑用户名及路径', '合成测试数据与截图元数据', 'Git提交作者和邮箱', '第三方署名与许可例外'] }, null, 2));
console.log(JSON.stringify({ export: path.relative(root, target), files: result.files.length, findings: result.findings }));
if (result.findings.length) process.exitCode = 1;
