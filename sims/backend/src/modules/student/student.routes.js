'use strict';
/** /api/v1/student/* — every student-facing endpoint. Each sub-router applies its own guards. */
const router = require('express').Router();
const profile = require('./profile.routes');
const skills = require('../skills/skills.routes');

router.use('/profile', profile.router);
router.use('/class', profile.leave);
router.use('/attendance', require('./attendance.routes'));
router.use('/academics', require('./academics.routes'));
router.use('/certificates', require('./certificates.routes'));
router.use('/portfolio', require('./portfolio.routes'));
router.use('/resumes', require('../resume/resume.routes'));
router.use('/', skills.student);          // /skills, /target-role, /skill-gap…
router.use('/', require('./extras.routes'));

module.exports = router;
