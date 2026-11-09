import fs from 'node:fs';
import path from 'node:path';
import { Voice } from '../dist/voice.js';
import { readConfig } from '../dist/config.js';

process.chdir(path.resolve(import.meta.dirname, '..'));
const config = readConfig('config.local.json');
const service = new Voice();
service.cleanup();
let prepared;
try {
  const text = '你好，这是机器人的语音测试。现在可以用自然的中文和你聊天了。';
  prepared = await service.prepare({ kind: 'tts', text }, config.voice ?? { enabled: true });
  fs.mkdirSync('artifacts', { recursive: true });
  fs.copyFileSync(prepared.file, 'artifacts/voice-sample.wav');
  const report = { at: new Date().toISOString(), provider: 'edge-tts', voice: config.voice?.voice ?? 'zh-CN-XiaoxiaoNeural', text, sample: path.resolve('artifacts/voice-sample.wav'), bytes: fs.statSync(prepared.file).size, realQQ: false, result: 'passed' };
  fs.writeFileSync('artifacts/voice-validation.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} catch (e) { console.error(e.code ?? 'VOICE_VALIDATION_FAILED'); process.exitCode = 1; }
finally { prepared?.dispose(); }
