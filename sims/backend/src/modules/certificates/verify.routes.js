'use strict';
/**
 * PUBLIC certificate authenticity check — the target of the QR code on a verified certificate.
 * Returns the minimum needed to confirm authenticity: no email, phone, roll number or file.
 */
const router = require('express').Router();
const { pool } = require('../../db/pool');
const { asyncHandler } = require('../../utils/errors');
const { CERT_CODE_REGEX } = require('../../utils/keygen');

router.get('/:code', asyncHandler(async (req, res) => {
  const code = String(req.params.code).trim().toUpperCase();
  const none = () => res.status(404).json({ valid: false, message: 'No verified certificate matches this code' });
  if (!CERT_CODE_REGEX.test(code)) return none();

  const { rows } = await pool.query(
    `SELECT c.title, c.issuer, c.category, c.issue_date, c.verified_at, u.full_name AS holder,
            verifier.full_name AS verified_by, col.name AS institution
       FROM certificates c
       JOIN users u ON u.id = c.student_id
       LEFT JOIN users verifier ON verifier.id = c.verified_by
       LEFT JOIN class_enrollments e ON e.student_id = c.student_id AND e.status = 'approved'
       LEFT JOIN classes cl ON cl.id = e.class_id
       LEFT JOIN colleges col ON col.id = cl.college_id
      WHERE c.verification_code = $1 AND c.verification_status = 'verified'`, [code]);
  const r = rows[0];
  if (!r) return none();
  res.json({
    valid: true, code, holder: r.holder, title: r.title, issuer: r.issuer, category: r.category,
    issuedOn: r.issue_date, verifiedBy: r.verified_by, verifiedAt: r.verified_at, institution: r.institution,
  });
}));

module.exports = router;
