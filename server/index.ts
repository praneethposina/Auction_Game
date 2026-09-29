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

const { httpServer } = createApp({ store, vault: new Vault(secret) });

httpServer.listen(PORT, () => {
  const client = existsSync(path.resolve('dist')) ? 'serving the built client' : 'API only (run the Vite dev server for the UI)';
  const db = store.db.kind === 'postgres' ? 'Postgres' : `SQLite at ${path.join(dataDir, 'auction.db')}`;
  console.log(`🔨 Company Auction on http://localhost:${PORT} · ${client} · ${db}`);
});
