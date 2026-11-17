'use strict';
const router = require('express').Router();
const env = require('../../config/env');
const { asyncHandler } = require('../../utils/errors');
const { validate } = require('../../middleware/validate');
const { authLimiter, refreshLimiter } = require('../../middleware/rateLimit');
const schema = require('./auth.schema');
const auth = require('./auth.service');

const REFRESH_COOKIE = 'sims_rt';
const cookieOptions = {
  httpOnly: true,                              // not readable by JS → XSS can't steal it
  secure: env.COOKIE_SECURE,
  sameSite: 'lax',                             // blocks cross-site POSTs (CSRF on /refresh)
  path: '/api/v1/auth',                        // only ever sent to the auth endpoints
  maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
};

const ctxOf = (req) => ({ ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 255) });

function sendSession(res, session, status = 200, extra = {}) {
  res.cookie(REFRESH_COOKIE, session.refreshToken, cookieOptions);
  res.status(status).json({ accessToken: session.accessToken, user: session.user, ...extra });
}

const signup = (fn, bodySchema) => [
  authLimiter, validate({ body: bodySchema }),
  asyncHandler(async (req, res) => {
    const { session, extra } = await fn(req.body, ctxOf(req));
    sendSession(res, session, 201, extra);
  }),
];

router.post('/signup/university-head', ...signup(auth.signupUniversityHead, schema.signupUniversityHead));
router.post('/signup/college-admin', ...signup(auth.signupCollegeAdmin, schema.signupCollegeAdmin));
router.post('/signup/instructor', ...signup(auth.signupInstructor, schema.signupInstructor));
router.post('/signup/student', ...signup(auth.signupStudent, schema.signupStudent));

router.post('/login', authLimiter, validate({ body: schema.login }), asyncHandler(async (req, res) => {
  sendSession(res, await auth.login(req.body, ctxOf(req)));
}));

router.post('/refresh', refreshLimiter, asyncHandler(async (req, res) => {
  const session = await auth.refresh(req.cookies?.[REFRESH_COOKIE], ctxOf(req));
  sendSession(res, session);
}));

router.post('/logout', asyncHandler(async (req, res) => {
  await auth.logout(req.cookies?.[REFRESH_COOKIE]);
  res.clearCookie(REFRESH_COOKIE, { ...cookieOptions, maxAge: undefined });
  res.status(204).end();
}));

router.post('/forgot-password', authLimiter, validate({ body: schema.forgotPassword }), asyncHandler(async (req, res) => {
  await auth.forgotPassword(req.body);
  res.json({ message: 'If that email is registered, a reset link has been sent.' });   // identical either way
}));

router.post('/reset-password', authLimiter, validate({ body: schema.resetPassword }), asyncHandler(async (req, res) => {
  await auth.resetPassword(req.body);
  res.json({ message: 'Password updated. Please sign in.' });
}));

module.exports = router;
