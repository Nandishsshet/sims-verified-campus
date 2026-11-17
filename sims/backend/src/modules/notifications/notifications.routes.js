'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler, notFound } = require('../../utils/errors');
const { protect } = require('../../middleware/auth');
const { validate } = require('../../middleware/validate');

router.use(...protect);

// GET /notifications?unread=true&limit=30   — the SPA polls this (cheap, indexed)
router.get('/', validate({ query: z.object({
  unread: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(30),
}) }), asyncHandler(async (req, res) => {
  const [list, count] = await Promise.all([
    pool.query(
      `SELECT id, type, title, body, link, is_read, created_at FROM notifications
        WHERE user_id = $1 AND ($2::boolean = false OR NOT is_read) ORDER BY created_at DESC LIMIT $3`,
      [req.user.id, req.query.unread === 'true', req.query.limit]),
    pool.query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND NOT is_read', [req.user.id]),
  ]);
  res.json({
    unread: count.rows[0].n,
    notifications: list.rows.map((n) => ({ id: n.id, type: n.type, title: n.title, body: n.body, link: n.link, read: n.is_read, createdAt: n.created_at })),
  });
}));

router.post('/read-all', asyncHandler(async (req, res) => {
  await pool.query('UPDATE notifications SET is_read = true WHERE user_id = $1 AND NOT is_read', [req.user.id]);
  res.json({ ok: true });
}));

router.post('/:id/read', validate({ params: z.object({ id: z.string().uuid() }) }), asyncHandler(async (req, res) => {
  const { rowCount } = await pool.query('UPDATE notifications SET is_read = true WHERE id = $1 AND user_id = $2', [req.params.id, req.user.id]);
  if (!rowCount) throw notFound('Notification');
  res.json({ ok: true });
}));

module.exports = router;
