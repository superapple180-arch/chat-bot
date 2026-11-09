import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const testDomain = /(?:@(?:example\.(?:com|org|net)|[^@\s]+\.(?:test|invalid)|users\.noreply\.github\.com))$/i;
export const sourceExclusions = ['node_modules', '.cache', 'artifacts', 'dist', 'web-dist', 'runtime', 'vendor', 'state', 'desktop-app/node_modules'];
export function forbiddenPublicFile(file) {
  const leaf = path.posix.basename(file.replaceAll('\\', '/'));
  return leaf !== '.env.example' && (/^\.env(?:\.|$)/i.test(leaf) || /^config\.local(?:\.|$)/i.test(leaf) || /\.(?:pem|key|p12|pfx|jks|keystore)$/i.test(leaf) || /^id_(?:rsa|ed25519)/i.test(leaf));
}
export function readableText(data) {
  if (data[0] === 0xff && data[1] === 0xfe) return data.toString('utf16le');
  if (data[0] === 0xfe && data[1] === 0xff && data.length % 2 === 0) { const copy = Buffer.from(data); copy.swap16(); return copy.toString('utf16le'); }
  if (data.includes(0)) return null;
  try { return new TextDecoder('utf-8', { fatal: true }).decode(data); } catch { return null; }
}
export function privacyMatches(text, protectedValues = [], thirdParty = false) {
  const matches = [];
  for (const match of text.matchAll(/[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+|\/(?:Users|home)\/[^/\s"']+\//gi)) matches.push({ category: 'personal-computer-path', value: match[0] });
  // Exact synthetic URL userinfo used by existing rejection tests is not email.
  const emailText = text.replaceAll('https://u:p@qpic.cn/', 'https://synthetic.invalid/').replaceAll('https://u:p@zhaoolee.com/', 'https://synthetic.invalid/');
  if (!thirdParty) for (const match of emailText.matchAll(/[\w.+-]+@[\w.-]+\.[a-z]{2,}/gi)) if (!testDomain.test(match[0])) matches.push({ category: 'email-review', value: match[0] });
  for (const match of text.matchAll(/(?:sk-(?:proj-)?[a-zA-Z0-9_-]{24,}|gh[pousr]_[a-zA-Z0-9]{30,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g)) matches.push({ category: 'credential-pattern', value: match[0] });
  for (const match of text.matchAll(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis|mssql):\/\/[^\s/'"]+:[^\s/@'\"]+@[^\s'"`]+/gi)) matches.push({ category: 'database-credential-url', value: match[0] });
  for (const match of text.matchAll(/(?:api[_-]?key|access[_-]?token|client[_-]?secret|password|oauth[_-]?secret)["']?\s*[:=]\s*(["'])([^"'\r\n]{8,})\1/gi)) {
    const value = match[2];
    if (!/^(?:synthetic|test-only|REPLACE|YOUR_|example|placeholder)/i.test(value) && !/[+{}$<>]/.test(value) && !/^(?:password|accessToken|clientSecret|ONEBOT_ACCESS_TOKEN)$/i.test(value)) matches.push({ category: 'hardcoded-secret-review', value });
  }
  for (const value of protectedValues) if (value && text.includes(value)) matches.push({ category: 'protected-identity-or-secret', value });
  return matches;
}
export const privacyFindings = (text, protectedValues = [], thirdParty = false) => [...new Set(privacyMatches(text, protectedValues, thirdParty).map(match => match.category))];
export function inventory(root, protectedValues = [], exclusions = [], reviewVendor) {
  const files = [], findings = [], vendorReviewed = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name), relative = path.relative(root, absolute).replaceAll('\\', '/');
      if (exclusions.some(prefix => relative === prefix || relative.startsWith(prefix + '/'))) continue;
      if (entry.name === '.git') continue;
      if (forbiddenPublicFile(relative)) findings.push({ file: relative, categories: ['forbidden-secret-file'] });
      const nameCategories = privacyFindings(relative, protectedValues, relative.includes('node_modules/'));
      if (nameCategories.length) findings.push({ file: '[redacted-path:' + createHash('sha256').update(relative).digest('hex').slice(0, 12) + ']', categories: ['sensitive-filename', ...nameCategories] });
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(absolute), rel = path.relative(root, resolved);
        if (rel.startsWith('..') || path.isAbsolute(rel)) findings.push({ file: relative, categories: ['external-symlink'] });
        continue;
      }
      if (entry.isDirectory()) { walk(absolute); continue; }
      const data = fs.readFileSync(absolute), decoded = readableText(data), binary = decoded === null;
      files.push({ file: relative, sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length, kind: binary ? 'manual-binary-review' : 'text' });
      const text = binary ? data.toString('latin1') + '\n' + data.toString('utf16le') : decoded;
      const matches = privacyMatches(text, protectedValues, relative.includes('node_modules/') || /(?:LICENSE|LICENCE|THIRD_PARTY)/i.test(entry.name));
      const categories = [...new Set(matches.map(match => match.category))];
      const origin = (binary || relative.includes('node_modules/')) && matches.length && !categories.includes('protected-identity-or-secret') ? reviewVendor?.(absolute, data, matches) : undefined;
      if (origin) vendorReviewed.push({ file: nameCategories.length ? '[redacted-path]' : relative, categories, origin, sha256: files.at(-1).sha256 });
      else if (categories.length) findings.push({ file: nameCategories.length ? '[redacted-path]' : relative, categories });
    }
  }
  walk(root); files.sort((a, b) => a.file.localeCompare(b.file));
  return { files, findings, vendorReviewed, digest: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}
export function localProtectedValues(project) {
  const values = [];
  for (const [key, value] of Object.entries(process.env)) if (/(?:TOKEN|SECRET|PASSWORD|API_KEY|DATABASE_URL|PRIVATE_KEY)/i.test(key)) values.push(value);
  const envFile = path.join(project, '.env');
  if (fs.existsSync(envFile)) values.push(...Object.values(parseEnv(fs.readFileSync(envFile, 'utf8'))));
  let user;
  try { user = os.userInfo().username; } catch { user = process.env.USERNAME ?? process.env.USER; }
  if (!user) throw Error('LOCAL_USER_IDENTITY_REQUIRED');
  if (!['runner', 'root', 'sandbox'].includes(user.toLowerCase()) && user.length >= 4) values.push(user);
  const local = path.join(project, '.cache/release-private.json');
  if (process.env.CHAT_BOT_PRIVATE_VALUES) {
    const input = JSON.parse(process.env.CHAT_BOT_PRIVATE_VALUES);
    if (!Array.isArray(input) || input.some(v => typeof v !== 'string' || v.length < 3)) throw Error('INVALID_PRIVATE_REVIEW_VALUES');
    values.push(...input);
  }
  if (fs.existsSync(local)) {
    const input = JSON.parse(fs.readFileSync(local, 'utf8'));
    if (!Array.isArray(input) || input.some(v => typeof v !== 'string' || v.length < 3)) throw Error('INVALID_PRIVATE_REVIEW_VALUES');
    values.push(...input);
  }
  const config = path.join(project, 'config.local.json');
  if (fs.existsSync(config)) {
    const c = JSON.parse(fs.readFileSync(config, 'utf8'));
    values.push(c.onebot?.accessToken, c.onebot?.selfId, c.friendAdminId, ...(c.friends ?? []), ...(c.groups ?? []));
  }
  return [...new Set(values.filter(v => typeof v === 'string' && v.length >= 4))];
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? '.');
  const result = inventory(root, localProtectedValues(process.cwd()), process.argv.includes('--source') ? sourceExclusions : []);
  if (process.argv.includes('--history')) {
    const history = spawnSync('git', ['-C', root, 'log', '--all', '--format=%an%n%ae%n%cn%n%ce%n%B'], { encoding: 'utf8' });
    if (history.status !== 0) throw Error('HISTORY_REVIEW_FAILED');
    const categories = privacyFindings(history.stdout, localProtectedValues(process.cwd()));
    if (categories.length) result.findings.push({ file: '[git-metadata]', categories });
  }
  console.log(JSON.stringify({ checkedFiles: result.files.length, manualBinaryReview: result.files.filter(f => f.kind !== 'text').length, digest: result.digest, findings: result.findings }));
  if (result.findings.length) process.exitCode = 1;
}
