'use strict';
/**
 * Environment configuration, validated once at startup.
 * Fails fast with a readable message instead of crashing later on `undefined`.
 */
require('dotenv').config({ quiet: true });
const { z } = require('zod');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),
  CORS_ORIGIN: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  APP_URL: z.string().default('http://localhost:5173'),
  KEY_MAX_FAILED_ATTEMPTS: z.coerce.number().int().min(1).default(10),
  // Refresh cookie `Secure` flag + CSP `upgrade-insecure-requests`. Defaults to ON in production; set to
  // "false" only to try a production build over plain http (e.g. docker compose on localhost).
  COOKIE_SECURE: z.enum(['true', 'false']).optional(),
  // Folder with the built web app (frontend/dist). When it exists the API serves it too, so the SPA and the
  // API share one origin (no CORS, first-party refresh cookie). Set to "off" to serve the API only.
  FRONTEND_DIST: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`);
  throw new Error(`Invalid environment configuration:\n${lines.join('\n')}`);
}

const cfg = parsed.data;

// Refuse to boot a production server with a copied-from-the-example secret: anyone could forge access tokens.
if (cfg.NODE_ENV === 'production' && /change-me|example|secret-secret/i.test(cfg.JWT_ACCESS_SECRET)) {
  throw new Error('Invalid environment configuration:\n  - JWT_ACCESS_SECRET: still the placeholder from .env.example — generate a real one');
}

module.exports = Object.freeze({
  ...cfg,
  COOKIE_SECURE: cfg.COOKIE_SECURE ? cfg.COOKIE_SECURE === 'true' : cfg.NODE_ENV === 'production',
});
