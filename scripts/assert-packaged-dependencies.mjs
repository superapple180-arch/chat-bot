import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

export function assertPackagedDependencies(backend) {
  const root = fs.realpathSync(backend), manifest = path.join(root, 'package.json');
  const require = createRequire(manifest), dependencies = JSON.parse(fs.readFileSync(manifest)).dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    let entry;
    try { entry = fs.realpathSync(require.resolve(name)); }
    catch { throw Error('PACKAGED_DEPENDENCY_MISSING'); }
    const relative = path.relative(root, entry);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('PACKAGED_DEPENDENCY_OUTSIDE_APPLICATION');
  }
  return Object.keys(dependencies).length;
}
