'use strict';
/**
 * npm run db:init      load database/schema.sql (refuses if the schema already exists)
 * npm run db:catalog   (re)load database/seeds/catalog.sql — skills, roles, courses, badges (idempotent)
 */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
require('dotenv').config({ quiet: true });

const only = process.argv[2];      // 'catalog' → catalogue only

(async () => {
  const url = process.env.DATABASE_URL;
  if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
  // In a container the database may still be starting: retry for ~1 minute before giving up.
  let client;
  for (let attempt = 1; ; attempt += 1) {
    client = new Client({ connectionString: url });
    try { await client.connect(); break; } catch (e) {
      await client.end().catch(() => {});
      if (attempt >= 30) throw e;
      console.log(`Database not reachable yet (${e.code || e.message}) — retrying (${attempt}/30)`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  try {
    if (only !== 'catalog') {
      const { rows } = await client.query(`SELECT to_regclass('public.users') AS t`);
      if (rows[0].t) console.log('Schema already present — skipping.');
      else {
        await client.query(fs.readFileSync(path.join(__dirname, '../../database/schema.sql'), 'utf8'));
        console.log('Schema created.');
      }
    }
    await client.query(fs.readFileSync(path.join(__dirname, '../../database/seeds/catalog.sql'), 'utf8'));
    console.log('Catalogue loaded (skills, roles, courses, badges).');
  } finally {
    await client.end();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
