'use strict';
const { ZodError } = require('zod');
const { AppError } = require('../utils/errors');

/** Friendly messages for DB constraint violations that users can realistically hit. */
const CONSTRAINTS = {
  users_email_key: [409, 'EMAIL_TAKEN', 'An account with this email already exists'],
  uq_student_one_class: [409, 'ALREADY_IN_CLASS', 'This student already belongs to (or has requested) a class'],
  uq_roll_in_class: [409, 'ROLL_NUMBER_TAKEN', 'That roll number is already used in this class'],
  uq_instructor_one_college: [409, 'ALREADY_IN_COLLEGE', 'This instructor already belongs to (or has requested) a college'],
  uq_active_key_university: [409, 'KEY_EXISTS', 'An active key already exists'],
  uq_active_key_college: [409, 'KEY_EXISTS', 'An active key already exists'],
  uq_active_key_class: [409, 'KEY_EXISTS', 'An active key already exists'],
  departments_college_id_code_key: [409, 'DEPARTMENT_EXISTS', 'A department with this code already exists'],
  colleges_university_id_name_key: [409, 'COLLEGE_EXISTS', 'A college with this name already exists in the university'],
  certificates_student_id_file_sha256_key: [409, 'DUPLICATE_CERTIFICATE', 'You have already uploaded this exact file'],
  uq_student_skill_manual: [409, 'SKILL_EXISTS', 'You have already added this skill'],
  uq_attendance_slot: [409, 'RECORD_EXISTS', 'An attendance record already exists for that class — ask your instructor to correct it'],
  marks_student_id_subject_id_attempt_key: [409, 'RECORD_EXISTS', 'Marks already exist for that subject'],
};

function notFoundHandler(req, res) {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const send = (status, code, message, details) =>
    res.status(status).json({ error: { code, message, ...(details ? { details } : {}) } });

  if (err instanceof ZodError) {
    return send(400, 'VALIDATION_ERROR', 'Invalid request',
      err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  }
  if (err.type === 'entity.parse.failed') return send(400, 'INVALID_JSON', 'Malformed JSON body');
  if (err.type === 'entity.too.large') return send(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
  if (err instanceof AppError) return send(err.status, err.code, err.message, err.details);
  if (err.name === 'MulterError') {
    return err.code === 'LIMIT_FILE_SIZE'
      ? send(413, 'FILE_TOO_LARGE', 'That file is too large')
      : send(400, 'UPLOAD_ERROR', 'Upload failed: ' + err.message);
  }

  // PostgreSQL error classes
  if (err.code === '23505') {
    const [status, code, message] = CONSTRAINTS[err.constraint] || [409, 'CONFLICT', 'Duplicate value'];
    return send(status, code, message);
  }
  if (err.code === '22P02') return send(400, 'INVALID_ID', 'Invalid identifier');
  if (err.code === '23514') return send(400, 'CONSTRAINT_VIOLATION', 'A value is outside the allowed range');

  console.error('[error]', req.method, req.originalUrl, err);
  return send(500, 'INTERNAL_ERROR', 'Something went wrong');
}

module.exports = { errorHandler, notFoundHandler };
