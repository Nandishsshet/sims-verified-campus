'use strict';
const { forbidden, notFound } = require('../utils/errors');

/** Allow only the listed roles. Usage: router.get('/x', ...protect, requireRole('instructor')) */
const requireRole = (...roles) => (req, res, next) =>
  roles.includes(req.user?.role) ? next() : next(forbidden('Your role cannot perform this action', 'ROLE_FORBIDDEN'));

/** College admin whose college has been approved (status = active). */
const requireActiveCollege = (req, res, next) =>
  req.user.role === 'college_admin' && req.scope.status === 'active'
    ? next()
    : next(forbidden('Your college is not active yet', 'ORG_NOT_ACTIVE'));

/** Instructor whose membership in a college has been approved. */
const requireApprovedInstructor = (req, res, next) =>
  req.user.role === 'instructor' && req.scope.status === 'approved'
    ? next()
    : next(forbidden('Your instructor account has not been approved by the college yet', 'MEMBERSHIP_NOT_APPROVED'));

/**
 * Instructor may only touch classes they own. A foreign / unknown class id returns 404
 * (not 403) so class ids cannot be probed.
 */
const requireOwnClass = (param = 'classId') => (req, res, next) =>
  req.scope.classIds.includes(req.params[param]) ? next() : next(notFound('Class'));

module.exports = { requireRole, requireActiveCollege, requireApprovedInstructor, requireOwnClass };
