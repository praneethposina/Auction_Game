import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** Minimal .env loader (KEY=value lines) so API keys can live in a local file. */
export function loadEnvFile(file = path.resolve(process.cwd(), '.env')) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const [, key, rawValue] = m;
    if (process.env[key] !== undefined) continue;
    process.env[key] = rawValue.replace(/^(['"])(.*)\1$/, '$2');
  }
}

loadEnvFile();
