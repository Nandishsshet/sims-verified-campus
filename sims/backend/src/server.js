'use strict';
const env = require('./config/env');
const { createApp } = require('./app');
const db = require('./db/pool');
const { startCleanup } = require('./jobs/cleanup');

const server = createApp().listen(env.PORT, () => {
  console.log(`SIMS API listening on http://localhost:${env.PORT}/api/v1  (${env.NODE_ENV})`);
  startCleanup();
});

// Graceful shutdown: stop accepting requests, let in-flight ones finish, close the DB pool.
function shutdown(signal) {
  console.log(`${signal} received, shutting down`);
  server.close(async () => { await db.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
