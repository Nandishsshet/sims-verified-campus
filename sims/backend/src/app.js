'use strict';
const fs = require('fs');
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const env = require('./config/env');
const routes = require('./routes');
const { errorHandler, notFoundHandler } = require('./middleware/error');

/**
 * Where the built web app lives: FRONTEND_DIST if set, else ../../frontend/dist — but only in production, so
 * `npm start` in development and the tests never serve a stale build. "off" (or a folder without index.html) = API only.
 */
function resolveFrontendDir(explicit) {
  const wanted = explicit ?? env.FRONTEND_DIST ?? (env.NODE_ENV === 'production' ? path.join(__dirname, '../../frontend/dist') : 'off');
  if (wanted === 'off') return null;
  const dir = path.resolve(wanted);
  return fs.existsSync(path.join(dir, 'index.html')) ? dir : null;
}

/**
 * Serve the built SPA from the same origin as the API:
 *  · /assets/* are content-hashed by Vite → cached for a year, and a missing one is a real 404 (never index.html)
 *  · every other GET that is not /api falls back to index.html so client-side routes survive a refresh
 *  · index.html itself is never cached, so a deploy is picked up immediately
 */
function mountFrontend(app, dir) {
  app.use('/assets', express.static(path.join(dir, 'assets'), { immutable: true, maxAge: '365d' }));
  app.use(express.static(dir, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!api(\/|$)|assets\/).*/, (req, res, next) => {
    if (path.extname(req.path)) return next();                 // a missing file (/favicon.png, /x.js) is a 404, not the app
    res.set('Cache-Control', 'no-cache').sendFile(path.join(dir, 'index.html'));
  });
}

function createApp({ frontendDir } = {}) {
  const app = express();
  app.disable('x-powered-by');
  // Behind a proxy/load balancer, set TRUST_PROXY so req.ip (rate limits, key lockout, audit) is the real client.
  if (env.TRUST_PROXY > 0) app.set('trust proxy', env.TRUST_PROXY);

  // helmet's CSP (script-src 'self', no inline scripts) suits the built SPA as is. `upgrade-insecure-requests`
  // would break a production build opened over plain http, so it only stays on when cookies are Secure too.
  // (helmet merges its defaults back in for any directive left out, so the way to switch one off is `null`.)
  // `img-src blob:` is needed because protected files (the student's own photo) are fetched with the bearer token
  // and shown from an object URL; scripts, frames and everything else stay locked to our own origin.
  const directives = { 'img-src': ["'self'", 'data:', 'blob:'], ...(env.COOKIE_SECURE ? {} : { 'upgrade-insecure-requests': null }) };
  app.use(helmet({ contentSecurityPolicy: { directives }, hsts: env.COOKIE_SECURE }));
  app.use(cors({ origin: env.CORS_ORIGIN.split(',').map((s) => s.trim()), credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());

  app.use('/api/v1', routes);
  const dir = resolveFrontendDir(frontendDir);
  if (dir) mountFrontend(app, dir);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
