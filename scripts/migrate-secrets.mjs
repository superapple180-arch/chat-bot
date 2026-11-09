import path from 'node:path';
import { migrateLegacyConfig } from '../dist/secrets.js';
try {
  const file = path.resolve(process.argv[2] ?? 'config.local.json');
  const migrated = migrateLegacyConfig(file);
  console.log(JSON.stringify({ migrated, credentialsPrinted: false }));
} catch (error) {
  console.error(/^[A-Z_0-9]+$/.test(error.code ?? '') ? error.code : 'SECRET_MIGRATION_FAILED');
  process.exitCode = 1;
}
