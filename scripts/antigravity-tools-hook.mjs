import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const workspace = path.resolve(process.argv[3] ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../state/antigravity-workspace'));
const canonical = value => process.platform === 'win32' ? value.toLowerCase() : value;
const normal = value => canonical(path.resolve(value.startsWith('file:') ? fileURLToPath(value) : value));
const invalid = () => {
  if (process.argv[2] === 'start') process.exit(1);
  if (process.argv[2] === 'post-tool') { console.log('{}'); process.exit(0); }
  console.log('{"decision":"deny","reason":"QQ bridge guard is invalid or missing."}');
  process.exit(0);
};
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 262144) invalid();
}
try {
  const event = JSON.parse(input);
  const applies = (event.workspacePaths ?? []).some(p => typeof p === 'string' && normal(p) === normal(workspace)) || normal(process.cwd()) === normal(workspace);
  const requestFile = path.join(workspace, '.hook-request.json');
  if (!applies) {
    console.log(process.argv[2] === 'tool' ? '{"decision":"allow"}' : '{}');
    process.exit(0);
  }
  if (!fs.existsSync(requestFile)) invalid();
  const request = JSON.parse(fs.readFileSync(requestFile, 'utf8'));
  if (!/^[a-f0-9-]{36}$/i.test(request.nonce)) invalid();
  const proofFile = path.join(workspace, `.hook-proof-${request.nonce}.json`);
  if (process.argv[2] === 'start') {
    if (typeof event.conversationId !== 'string') invalid();
    fs.writeFileSync(proofFile, JSON.stringify({ nonce: request.nonce, conversationId: event.conversationId }), { mode: 0o600 });
    console.log('{}');
  } else {
    const proof = fs.existsSync(proofFile) ? JSON.parse(fs.readFileSync(proofFile, 'utf8')) : {};
    const post = process.argv[2] === 'post-tool';
    if (!post) fs.appendFileSync(path.join(workspace, `.hook-denials-${request.nonce}.jsonl`), JSON.stringify({ tool: event.toolCall?.name ?? 'unknown' }) + '\n');
    const protectedSession = proof.nonce === request.nonce && proof.conversationId === event.conversationId;
    let allowed = event.toolCall?.name === 'finish' && protectedSession;
    if (protectedSession && event.toolCall?.name === 'view_file' && Array.isArray(request.attachments)) {
      let args = event.toolCall.arguments ?? event.toolCall.args ?? {};
      if (typeof args === 'string') args = JSON.parse(args);
      if (args && Object.keys(args).length === 1 && typeof args.AbsolutePath === 'string') {
        const file = fs.realpathSync(args.AbsolutePath);
        const relative = path.relative(fs.realpathSync(workspace), file);
        const declared = request.attachments.find(item => normal(item.path) === normal(file));
        if (relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && path.extname(file).toLowerCase() === '.png' && fs.statSync(file).size <= 10 * 1024 * 1024 && declared?.sha256 === createHash('sha256').update(fs.readFileSync(file)).digest('hex') && Number.isSafeInteger(event.stepIdx) && event.stepIdx >= 0) {
          allowed = true;
          const id = createHash('sha256').update(canonical(file)).digest('hex');
          const proofFile = path.join(workspace, `.hook-view-${request.nonce}-${id}.json`);
          const pendingFile = proofFile + '.pending';
          const confirmation = { nonce: request.nonce, conversationId: event.conversationId, sha256: declared.sha256, stepIdx: event.stepIdx };
          if (!post) fs.writeFileSync(pendingFile, JSON.stringify(confirmation), { mode: 0o600 });
          else if (fs.existsSync(pendingFile)) {
            const pending = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
            if (Object.keys(confirmation).every(key => pending[key] === confirmation[key])) {
              fs.rmSync(pendingFile);
              if (event.error === undefined || event.error === '') fs.writeFileSync(proofFile, JSON.stringify({ ...confirmation, completed: true }), { mode: 0o600 });
            }
          }
        }
      }
    }
    console.log(post ? '{}' : JSON.stringify({ decision: allowed ? 'allow' : 'deny', reason: 'QQ bridge permits only confirmed current attachment reads and text replies.' }));
  }
} catch { invalid(); }
