'use strict';
const { z } = require('zod');
const router = require('express').Router();
const { asyncHandler } = require('../../utils/errors');
const { protect } = require('../../middleware/auth');
const { requireRole } = require('../../middleware/rbac');
const { validate } = require('../../middleware/validate');
const { joinLimiter } = require('../../middleware/rateLimit');
const { shared } = require('../auth/auth.schema');
const join = require('./join.service');

const ctxOf = (req) => ({ ip: req.ip, userAgent: (req.get('user-agent') || '').slice(0, 255) });

router.use(...protect);

router.post('/class', requireRole('student'), joinLimiter,
  validate({ body: z.object({ classKey: shared.keyString, rollNumber: z.string().trim().min(1).max(40).optional() }) }),
  asyncHandler(async (req, res) => {
    const data = await join.joinClass({ user: req.user, ...req.body, ctx: ctxOf(req) });
    res.status(201).json(data);
  }));

router.post('/instructor', requireRole('instructor'), joinLimiter,
  validate({ body: z.object({ collegeKey: shared.keyString, departmentId: shared.uuid.optional() }) }),
  asyncHandler(async (req, res) => {
    const data = await join.joinCollegeAsInstructor({ user: req.user, ...req.body, ctx: ctxOf(req) });
    res.status(201).json(data);
  }));

router.get('/status', asyncHandler(async (req, res) => {
  res.json(await join.getJoinStatus(req.user, req.scope));
}));

module.exports = router;
