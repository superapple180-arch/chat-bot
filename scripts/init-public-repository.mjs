import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { inventory, localProtectedValues, sourceExclusions } from './release-privacy.mjs';
const root = process.cwd(), target = fs.realpathSync(process.argv[2] ?? '');
const relative = path.relative(path.resolve('.cache'), target);
if (!relative || relative.startsWith('..') || fs.existsSync(path.join(target, '.git'))) throw Error('FRESH_PUBLIC_EXPORT_REQUIRED');
if (inventory(target, localProtectedValues(root), sourceExclusions).findings.length) throw Error('PRIVACY_REVIEW_NOT_PASSED');
const env = { ...process.env, GIT_AUTHOR_NAME: 'chat-bot contributors', GIT_COMMITTER_NAME: 'chat-bot contributors', GIT_AUTHOR_EMAIL: 'chat-bot@users.noreply.github.com', GIT_COMMITTER_EMAIL: 'chat-bot@users.noreply.github.com' };
function git(args) { const result = spawnSync('git', ['-C', target, ...args], { env, encoding: 'utf8', windowsHide: true }); if (result.status !== 0) throw Error('PUBLIC_REPOSITORY_PREPARATION_FAILED'); return result.stdout.trim(); }
git(['init', '--initial-branch=main']); git(['config', 'core.autocrlf', 'false']); git(['config', 'core.hooksPath', '.githooks']);
git(['add', '.']); git(['update-index', '--chmod=+x', '.githooks/pre-push']);
git(['-c', 'commit.gpgsign=false', 'commit', '-m', 'Package chat-bot desktop application and release safeguards']);
git(['remote', 'add', 'origin', 'https://github.com/superapple180-arch/chat-bot.git']);
console.log(JSON.stringify({ preparedLocalRepository: path.relative(root, target), commit: git(['rev-parse', 'HEAD']), remoteConfigured: true, pushed: false }));
