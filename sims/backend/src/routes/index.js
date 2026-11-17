'use strict';
const router = require('express').Router();
const { pool } = require('../db/pool');
const { apiLimiter } = require('../middleware/rateLimit');
const { college, departments } = require('../modules/colleges/colleges.routes');

// /health = the process is up (liveness). /health/ready = it can also reach the database (readiness) — what an
// orchestrator or load balancer should poll before sending traffic. Neither is rate limited or authenticated.
router.get('/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));
router.get('/health/ready', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ready', time: new Date().toISOString() });
  } catch {
    res.status(503).json({ status: 'unavailable', time: new Date().toISOString() });      // no error text: it can name hosts / users
  }
});

router.use(apiLimiter);
router.use('/auth', require('../modules/auth/auth.routes'));
router.use('/me', require('../modules/users/users.routes'));
router.use('/keys', require('../modules/keys/keys.routes'));
router.use('/join', require('../modules/keys/join.routes'));
router.use('/university', require('../modules/universities/universities.routes'));
router.use('/college', college);
router.use('/departments', departments);
router.use('/classes', require('../modules/classes/classes.routes'));
router.use('/student', require('../modules/student/student.routes'));
router.use('/', require('../modules/skills/skills.routes').catalog);        // /skills, /career-roles
router.use('/notifications', require('../modules/notifications/notifications.routes'));
router.use('/verify', require('../modules/certificates/verify.routes'));    // public QR target

module.exports = router;
