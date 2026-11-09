import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inventory, sourceExclusions } from './release-privacy.mjs';
import { isReleaseFile } from './release-files.mjs';
const directory = path.resolve('artifacts/desktop');
const files = fs.readdirSync(directory).filter(isReleaseFile).sort().map(name => ({ file: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex') }));
if (!files.length || !process.env.GITHUB_SHA || !process.env.GITHUB_RUN_ID) throw Error('CI_BUILD_CONTEXT_REQUIRED');
fs.writeFileSync(path.join(directory, 'build-platform.json'), JSON.stringify({ sourceCommit: process.env.GITHUB_SHA, runId: process.env.GITHUB_RUN_ID, sourceDigest: inventory(process.cwd(), [], sourceExclusions).digest, platform: process.platform, arch: process.arch, formal: process.env.CHAT_BOT_FORMAL === '1', privacyAndGuardianPassed: true, files }, null, 2));
