import { spawn } from 'node:child_process';
import path from 'node:path';
import { BridgeError, type Desktop, type View } from './types.js';
export class UiaDesktop implements Desktop {
  constructor(private directory: string, private executable = path.resolve('bin/GeminiDriver.exe')) {}
  call(input: Record<string, unknown>, signal?: AbortSignal): Promise<View> {
    if (signal?.aborted) return Promise.reject(new BridgeError('PAUSED', 'GENERATION_FAILED', true));
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      let out = ''; let done = false;
      const finish = (error?: BridgeError, view?: View) => {
        if (done) return; done = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(view!);
      };
      const abort = () => { child.kill(); finish(new BridgeError('PAUSED', 'GENERATION_FAILED', true)); };
      const timer = setTimeout(() => { child.kill(); finish(new BridgeError('DRIVER_TIMEOUT', 'READ_FAILED', true)); }, Number(input.timeoutMs ?? 15000) + 25000);
      signal?.addEventListener('abort', abort, { once: true });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', data => { out += data; if (out.length > 2097152) { child.kill(); finish(new BridgeError('DRIVER_OUTPUT_LIMIT', 'READ_FAILED', true)); } });
      child.stderr.resume(); // Never forward raw UI/provider output to logs.
      child.on('error', () => finish(new BridgeError('DRIVER_START_FAILED', 'READ_FAILED')));
      child.on('close', () => {
        if (done) return;
        try {
          const result = JSON.parse(out.replace(/^\uFEFF/, '').trim());
          if (result.error) return finish(new BridgeError(result.error, result.category, result.submitted));
          if (!result.url || !result.fingerprint || !result.mode) throw new Error();
          finish(undefined, result);
        } catch { finish(new BridgeError('DRIVER_INVALID_RESULT', 'READ_FAILED', true)); }
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...input, directory: this.directory }));
    });
  }
}
