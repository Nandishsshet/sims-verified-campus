'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { pool, tx } = require('../../db/pool');
const { AppError, asyncHandler, notFound } = require('../../utils/errors');
const { audit, ctxOf } = require('../../utils/audit');
const { notify } = require('../../utils/notify');
const { protect } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const keys = require('../keys/keys.service');

router.use(...protect, requireRole('university_head'));

const idParam = z.object({ id: z.string().uuid() });

// GET /university
router.get('/', asyncHandler(async (req, res) => {
  const u = (await pool.query(
    `SELECT id, name, head_title, head_name, address, contact_email, contact_phone, status
       FROM universities WHERE id = $1`, [req.scope.universityId])).rows[0];
  if (!u) throw notFound('University');
  const key = await keys.getActiveKey(pool, 'university', u.id);
  res.json({ university: u, key: keys.publicKey(key) });
}));

// GET /university/colleges
router.get('/colleges', asyncHandler(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT col.id, col.name, col.status, col.address, col.affiliation, col.principal_name,
            col.contact_email, col.contact_phone, col.approved_at, col.created_at,
            u.full_name AS admin_name, u.email AS admin_email,
            k.id AS key_id, k.key_value, k.use_count, k.expires_at,
            (SELECT count(*)::int FROM classes c WHERE c.college_id = col.id) AS class_count,
            (SELECT count(*)::int FROM departments d WHERE d.college_id = col.id) AS department_count,
            (SELECT count(*)::int FROM class_enrollments e JOIN classes c ON c.id = e.class_id WHERE c.college_id = col.id AND c.status = 'active' AND e.status = 'approved') AS student_count,
            (SELECT count(*)::int FROM college_instructors ci WHERE ci.college_id = col.id AND ci.status = 'approved') AS instructor_count,
            (SELECT count(*)::int FROM college_instructors ci WHERE ci.college_id = col.id AND ci.status = 'pending') AS pending_instructors
       FROM colleges col
       JOIN users u ON u.id = col.admin_user_id
       LEFT JOIN access_keys k ON k.college_id = col.id AND k.status = 'active'
      WHERE col.university_id = $1
      ORDER BY (col.status = 'pending') DESC, col.created_at DESC`, [req.scope.universityId]);
  res.json({ colleges: rows });
}));

/**
 * College lifecycle:  pending --approve--> active <--suspend / reinstate--> suspended
 * Approval is where the College Key is issued; suspension leaves the key in place but
 * unusable (redemption checks the college is active), so reinstating restores it.
 */
const TRANSITIONS = {
  approve: { from: 'pending', to: 'active', action: 'college.approve' },
  suspend: { from: 'active', to: 'suspended', action: 'college.suspend' },
  reinstate: { from: 'suspended', to: 'active', action: 'college.reinstate' },
};

for (const [verb, t] of Object.entries(TRANSITIONS)) {
  router.post(`/colleges/:id/${verb}`, validate({ params: idParam }), asyncHandler(async (req, res) => {
    const out = await tx(async (c) => {
      const { rows } = await c.query(
        `UPDATE colleges SET status = $1, approved_at = CASE WHEN $4 = 'approve' THEN now() ELSE approved_at END
          WHERE id = $2 AND university_id = $3 AND status = $5 RETURNING id, name, status, admin_user_id`,
        [t.to, req.params.id, req.scope.universityId, verb, t.from]);
      const college = rows[0];
      if (!college) {
        const exists = await c.query('SELECT status FROM colleges WHERE id = $1 AND university_id = $2', [req.params.id, req.scope.universityId]);
        if (!exists.rows[0]) throw notFound('College');
        throw new AppError(409, 'INVALID_STATE', `Cannot ${verb} a college that is ${exists.rows[0].status}`);
      }
      let key = null;
      if (verb === 'approve') key = await keys.issueKey(c, { scope: 'college', scopeId: college.id, createdBy: req.user.id });
      await audit(c, { ...ctxOf(req), action: t.action, entityType: 'college', entityId: college.id, collegeId: college.id });
      await notify(c, college.admin_user_id, {
        type: `college_${verb}`, title: `College ${t.to}`,
        body: verb === 'approve' ? `${college.name} was approved. Your College Key is ready.` : `${college.name} is now ${t.to}.`,
        link: '/college',
      });
      return { college, key };
    });
    res.json({ college: out.college, ...(out.key ? { collegeKey: out.key.key_value } : {}) });
  }));
}

// Phase 6 sub-routers (profile, announcements · overview, leaderboards, analytics, alerts, exports, audit)
router.use(require('./university.manage.routes'));
router.use(require('./university.analytics.routes'));

module.exports = router;
