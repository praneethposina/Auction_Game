// Load .env before anything reads process.env.
import './env.ts';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createApp } from './app.ts';
import { openStore } from './db/store.ts';
import { resolveAppSecret, Vault } from './security.ts';

const PORT = Number(process.env.PORT ?? 3001);
const dataDir = path.resolve(process.env.DATA_DIR ?? 'data');

const store = await openStore({
  databaseUrl: process.env.DATABASE_URL?.trim() || undefined,
  sqliteFile: path.join(dataDir, 'auction.db'),
});
const { secret, fromEnv } = await resolveAppSecret(store);
if (!fromEnv) {
  console.warn('⚠️  APP_SECRET is not set: saved API keys are encrypted with a key stored in the database. Set APP_SECRET in production.');
}

const { httpServer, drain } = createApp({ store, vault: new Vault(secret) });

// Railway sends SIGTERM to the old process once a new deploy is healthy. Save running games so
// the new process picks them up, instead of ending them.
let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: saving games and handing them to the next server…`);
    const force = setTimeout(() => process.exit(1), 10000);
    drain()
      .catch((err: unknown) => console.error('Shutdown error:', err))
      .finally(async () => {
        await store.db.close().catch(() => {});
        clearTimeout(force);
        console.log('Games saved. Bye.');
        process.exit(0);
      });
  });
}

httpServer.listen(PORT, () => {
  const client = existsSync(path.resolve('dist')) ? 'serving the built client' : 'API only (run the Vite dev server for the UI)';
  const db = store.db.kind === 'postgres' ? 'Postgres' : `SQLite at ${path.join(dataDir, 'auction.db')}`;
  console.log(`🔨 Company Auction on http://localhost:${PORT} · ${client} · ${db}`);
});
