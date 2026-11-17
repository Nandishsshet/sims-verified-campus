'use strict';
/**
 * npm run test:integration
 *
 * Boots a throw-away PostgreSQL (embedded-postgres, no Docker / system install needed),
 * loads database/schema.sql, runs tests/integration/*.test.js against it, then tears
 * everything down. Nothing touches your real database.
 *
 * Already have Postgres? Skip this script and run:
 *   TEST_DATABASE_URL=postgresql://user:pass@host/emptydb node --test tests/integration/*.test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const mod = require('embedded-postgres');
const EmbeddedPostgres = mod.default || mod;

const PORT = Number(process.env.TEST_PG_PORT || 54329);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sims-pg-'));

(async () => {
  const pg = new EmbeddedPostgres({
    databaseDir: dataDir, user: 'postgres', password: 'postgres', port: PORT, persistent: false, initdbFlags: ['--encoding=UTF8'],   // names in any script must round-trip (Windows defaults to WIN1252)
    onLog: () => {}, onError: (e) => { if (process.env.DEBUG_PG) console.error(e); },
  });
  let code = 1;
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('sims_test');

    const client = pg.getPgClient('sims_test');
    await client.connect();
    await client.query(fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8'));
    await client.query(fs.readFileSync(path.join(__dirname, '../../database/seeds/catalog.sql'), 'utf8'));
    await client.end();
    console.log('Temporary PostgreSQL ready, schema loaded. Running integration tests...\n');

    const res = spawnSync(process.execPath, ['--test', 'tests/integration/*.test.js'], {
      cwd: path.join(__dirname, '..'), stdio: 'inherit',
      env: { ...process.env, TEST_DATABASE_URL: `postgresql://postgres:postgres@localhost:${PORT}/sims_test` },
    });
    code = res.status ?? 1;
  } catch (err) {
    console.error('Failed to run integration tests:', err.message);
  } finally {
    try { await pg.stop(); } catch { /* already stopped */ }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
  process.exit(code);
})();
