'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { protect } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const keys = require('./keys.service');

const scopeParam = z.object({ scope: z.enum(['university', 'college', 'class']), id: z.string().uuid() });
const idParam = z.object({ id: z.string().uuid() });
const limits = z.object({
  expiresAt: z.coerce.date().nullable().optional(),
  maxUses: z.number().int().min(1).max(100000).nullable().optional(),
});
const MANAGERS = ['university_head', 'college_admin', 'instructor'];

router.use(...protect, requireRole(...MANAGERS));

// GET /keys/mine — active key(s) for my scope
router.get('/mine', asyncHandler(async (req, res) => {
  res.json({ keys: await keys.getMyKeys(req.scope) });
}));

// POST /keys/:scope/:id/regenerate — rotate (old key dies immediately)
router.post('/:scope/:id/regenerate', validate({ params: scopeParam, body: limits }), asyncHandler(async (req, res) => {
  const { scope, id } = req.params;
  await keys.assertCanManage(req.scope, scope, id);
  const fresh = await keys.rotateKey({ scope, scopeId: id, actor: req.user, ip: req.ip, ...req.body });
  await audit(pool, { ...ctxOf(req), action: 'key.regenerate', entityType: `${scope}_key`, entityId: fresh.id,
    classId: scope === 'class' ? id : null, metadata: { scope, scopeId: id } });
  res.status(201).json({ key: keys.publicKey(fresh) });
}));

// POST /keys/:scope/:id/revoke
router.post('/:scope/:id/revoke', validate({ params: scopeParam }), asyncHandler(async (req, res) => {
  const { scope, id } = req.params;
  await keys.assertCanManage(req.scope, scope, id);
  const revoked = await keys.revokeKey({ scope, scopeId: id, actor: req.user, ip: req.ip });
  await audit(pool, { ...ctxOf(req), action: 'key.revoke', entityType: `${scope}_key`, entityId: revoked.id,
    classId: scope === 'class' ? id : null, metadata: { scope, scopeId: id } });
  res.json({ key: keys.publicKey(revoked) });
}));

/** Resolve a key id to its (scope, scopeId) and make sure the caller may manage it. */
async function loadManagedKey(req) {
  const { rows } = await pool.query('SELECT * FROM access_keys WHERE id = $1', [req.params.id]);
  const k = rows[0];
  if (!k) throw notFound('Key');
  const scope = k.university_id ? 'university' : k.college_id ? 'college' : 'class';
  await keys.assertCanManage(req.scope, scope, k.university_id || k.college_id || k.class_id);
  return k;
}

// PATCH /keys/:id — expiry / usage cap
router.patch('/:id', validate({ params: idParam, body: limits }), asyncHandler(async (req, res) => {
  const k = await loadManagedKey(req);
  const updated = await keys.updateKeySettings({ keyId: k.id, ...req.body });
  await audit(pool, { ...ctxOf(req), action: 'key.update', entityType: 'access_key', entityId: k.id, metadata: req.body });
  res.json({ key: keys.publicKey(updated) });
}));

// GET /keys/:id/logs — joins, rotations, revocations
router.get('/:id/logs', validate({ params: idParam }), asyncHandler(async (req, res) => {
  const k = await loadManagedKey(req);
  res.json({ logs: await keys.getKeyLogs(k.id) });
}));

module.exports = router;
