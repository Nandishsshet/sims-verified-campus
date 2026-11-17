'use strict';
/**
 * npm run dev:db
 *
 * A persistent, zero-install PostgreSQL for local development (embedded-postgres).
 * First run: initialises ./.pgdata-dev, creates the `sims` database, loads schema + catalogue.
 * Later runs: just starts it again with your data intact. Ctrl-C stops it cleanly.
 * To reset everything: stop it and delete backend/.pgdata-dev (and backend/uploads).
 *
 * Connection string (matches .env.example):  postgresql://postgres:postgres@localhost:54330/sims
 * Already have Postgres? You don't need this — point DATABASE_URL at yours and run `npm run db:init`.
 */
const fs = require('fs');
const path = require('path');
const mod = require('embedded-postgres');
const EmbeddedPostgres = mod.default || mod;

const PORT = Number(process.env.DEV_PG_PORT || 54330);
const dataDir = path.resolve(__dirname, '../.pgdata-dev');
const sql = (f) => fs.readFileSync(path.join(__dirname, '../../database', f), 'utf8');

(async () => {
  const fresh = !fs.existsSync(path.join(dataDir, 'PG_VERSION'));
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: true, initdbFlags: ['--encoding=UTF8'],   // names in any script must round-trip (Windows defaults to WIN1252)
    onLog: () => {}, onError: (e) => { if (process.env.DEBUG_PG) console.error(e); },
  });
  if (fresh) await pg.initialise();
  await pg.start();

  if (fresh) {
    await pg.createDatabase('sims');
    const c = pg.getPgClient('sims');
    await c.connect();
    await c.query(sql('schema.sql'));
    await c.query(sql('seeds/catalog.sql'));
    await c.end();
    console.log('Created database "sims" (schema + catalogue loaded).');
  } else {
    const c = pg.getPgClient('sims');
    await c.connect();
    await c.query(sql('seeds/catalog.sql'));            // idempotent: picks up catalogue edits
    await c.end();
  }

  console.log(`PostgreSQL is running → postgresql://postgres:postgres@localhost:${PORT}/sims`);
  console.log('Leave this window open. Press Ctrl-C to stop.');

  let stopping = false;
  const stop = async () => {
    if (stopping) return; stopping = true;
    console.log('\nStopping PostgreSQL…');
    try { await pg.stop(); } catch { /* already stopped */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
})().catch((e) => { console.error('dev-db failed:', e.message); process.exit(1); });
