'use strict';
/**
 * Mail placeholder. Swap `send` for Nodemailer/SES/SendGrid in deployment (Phase 7).
 * - development: prints the message to the console
 * - test: keeps messages in `outbox` so tests can read reset tokens
 * - production: refuses to silently drop mail
 */
const env = require('../config/env');

const outbox = [];

async function send({ to, subject, text }) {
  if (env.NODE_ENV === 'test') {
    outbox.push({ to, subject, text });
  } else if (env.NODE_ENV === 'development') {
    console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
  } else {
    console.warn(`[mail] No mail transport configured; message to ${to} was NOT sent`);
  }
}

module.exports = { send, outbox };
