'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const { pool, tx } = require('../../db/pool');
const { AppError, badRequest } = require('../../utils/errors');
const { signAccessToken, randomToken, sha256 } = require('../../utils/tokens');
const { audit } = require('../../utils/audit');
const mailer = require('../../utils/mailer');
const keys = require('../keys/keys.service');
const { requestInstructorMembership } = require('../keys/join.service');

// Compared against when the email is unknown so login timing doesn't reveal which emails exist.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', env.BCRYPT_ROUNDS);

const hashPassword = (pw) => bcrypt.hash(pw, env.BCRYPT_ROUNDS);

const publicUser = (u) => ({ id: u.id, email: u.email, role: u.role, fullName: u.full_name, phone: u.phone ?? null, avatarUrl: u.avatar_url ?? null });

async function createUser(db, { email, passwordHash, role, fullName, phone }) {
  const { rows } = await db.query(
    `INSERT INTO users (email, password_hash, role, full_name, phone) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, email, role, full_name, phone, avatar_url`,
    [email, passwordHash, role, fullName, phone ?? null]); // duplicate email → 23505 → 409 EMAIL_TAKEN
  return rows[0];
}

// ------------------------------------------------------------------ sessions
/** Issue an access token + a new refresh token (stored hashed). `familyId` links rotations. */
async function createSession(db, user, ctx, familyId = crypto.randomUUID()) {
  const refreshToken = randomToken(48);
  await db.query(
    `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1,$2,$3, now() + make_interval(days => $4::int), $5, $6)`,
    [user.id, familyId, sha256(refreshToken), env.REFRESH_TOKEN_TTL_DAYS, ctx.userAgent ?? null, ctx.ip ?? null]);
  return { accessToken: signAccessToken(user), refreshToken, user: publicUser(user) };
}

// ------------------------------------------------------------------ signup
async function signupUniversityHead(body, ctx) {
  const passwordHash = await hashPassword(body.password);
  const { user, university, key } = await tx(async (c) => {
    const u = await createUser(c, { email: body.email, passwordHash, role: 'university_head', fullName: body.fullName, phone: body.phone });
    const uni = (await c.query(
      `INSERT INTO universities (head_user_id, name, head_title, head_name, address, contact_email, contact_phone)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name, status`,
      [u.id, body.university.name, body.university.headTitle, body.university.headName || body.fullName,
        body.university.address ?? null, body.university.contactEmail ?? null, body.university.contactPhone ?? null])).rows[0];
    const k = await keys.issueKey(c, { scope: 'university', scopeId: uni.id, createdBy: u.id });
    await audit(c, { actorId: u.id, actorRole: u.role, ip: ctx.ip, action: 'university.create', entityType: 'university', entityId: uni.id, universityId: uni.id });
    return { user: u, university: uni, key: k };
  });
  const session = await createSession(pool, user, ctx);
  return { session, extra: { university, universityKey: key.key_value } };
}

async function signupCollegeAdmin(body, ctx) {
  const passwordHash = await hashPassword(body.password);
  const data = await keys.joinWithKey({
    scope: 'university', rawKey: body.universityKey, ctx,
    work: async (c, key) => {
      const uni = (await c.query('SELECT id, status FROM universities WHERE id = $1', [key.university_id])).rows[0];
      if (!uni || uni.status !== 'active') throw keys.invalidKey('org_inactive');
      const u = await createUser(c, { email: body.email, passwordHash, role: 'college_admin', fullName: body.fullName, phone: body.phone });
      const col = (await c.query(
        `INSERT INTO colleges (university_id, admin_user_id, name, address, affiliation, principal_name, contact_email, contact_phone)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, name, status`,
        [uni.id, u.id, body.college.name, body.college.address ?? null, body.college.affiliation ?? null,
          body.college.principalName, body.college.contactEmail ?? null, body.college.contactPhone ?? null])).rows[0];
      await audit(c, { actorId: u.id, actorRole: u.role, ip: ctx.ip, action: 'college.create', entityType: 'college', entityId: col.id, collegeId: col.id, universityId: uni.id });
      // Tell the university head there is a college waiting for approval.
      const head = (await c.query('SELECT head_user_id FROM universities WHERE id = $1', [uni.id])).rows[0];
      await c.query(
        `INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,'college_request','New college awaiting approval',$2,'/university/colleges')`,
        [head.head_user_id, `${col.name} requested to join your university.`]);
      return { data: { user: u, college: col }, userId: u.id };
    },
  });
  const session = await createSession(pool, data.user, ctx);
  // The College Key is issued when the university head approves the college.
  return { session, extra: { college: data.college } };
}

async function signupInstructor(body, ctx) {
  const passwordHash = await hashPassword(body.password);
  const data = await keys.joinWithKey({
    scope: 'college', rawKey: body.collegeKey, ctx,
    work: async (c, key) => {
      const u = await createUser(c, { email: body.email, passwordHash, role: 'instructor', fullName: body.fullName, phone: body.phone });
      const { membership, college } = await requestInstructorMembership(c, {
        userId: u.id, userName: u.full_name, collegeId: key.college_id, departmentId: body.departmentId ?? null,
      });
      await audit(c, { actorId: u.id, actorRole: u.role, ip: ctx.ip, action: 'instructor.join_request', entityType: 'college_instructors', entityId: membership.id, collegeId: college.id });
      return { data: { user: u, membership, college }, userId: u.id };
    },
  });
  const session = await createSession(pool, data.user, ctx);
  return { session, extra: { membership: { status: data.membership.status, college: { id: data.college.id, name: data.college.name } } } };
}

async function signupStudent(body, ctx) {
  const passwordHash = await hashPassword(body.password);
  const user = await tx(async (c) => {
    const u = await createUser(c, { email: body.email, passwordHash, role: 'student', fullName: body.fullName, phone: body.phone });
    await c.query('INSERT INTO student_profiles (user_id) VALUES ($1)', [u.id]);
    return u;
  });
  const session = await createSession(pool, user, ctx);
  return { session, extra: {} };
}

// ------------------------------------------------------------------ login / refresh / logout
async function login({ email, password }, ctx) {
  const user = (await pool.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  if (!user.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been disabled');
  await pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
  return createSession(pool, user, ctx);
}

/**
 * Rotate a refresh token. Presenting an already-revoked token means it leaked (or a
 * stale tab replayed it) → the whole token family is revoked and the user must sign in again.
 */
async function refresh(rawToken, ctx) {
  const fail = () => new AppError(401, 'INVALID_REFRESH', 'Session expired. Please sign in again.');
  if (!rawToken) throw fail();

  const outcome = await tx(async (c) => {
    const t = (await c.query('SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE', [sha256(rawToken)])).rows[0];
    if (!t) return { error: true };
    if (t.revoked_at) {
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family_id = $1 AND revoked_at IS NULL', [t.family_id]);
      return { error: true };                                  // committed: family stays revoked
    }
    if (new Date(t.expires_at) <= new Date()) return { error: true };
    const u = (await c.query('SELECT * FROM users WHERE id = $1', [t.user_id])).rows[0];
    if (!u || !u.is_active) return { error: true };
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [t.id]);
    return { session: await createSession(c, u, ctx, t.family_id) };
  });
  if (outcome.error) throw fail();
  return outcome.session;
}

async function logout(rawToken) {
  if (!rawToken) return;
  await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [sha256(rawToken)]);
}

// ------------------------------------------------------------------ password reset / change
/** Always resolves quietly — callers respond 200 whether or not the email exists. */
async function forgotPassword({ email }) {
  const user = (await pool.query('SELECT id, email, full_name FROM users WHERE email = $1 AND is_active', [email])).rows[0];
  if (!user) return;
  const token = randomToken(32);
  await tx(async (c) => {
    await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [user.id]);
    await c.query(
      `INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')`,
      [user.id, sha256(token)]);
  });
  await mailer.send({
    to: user.email,
    subject: 'Reset your SIMS password',
    text: `Hi ${user.full_name},\n\nUse this link within 1 hour to choose a new password:\n${env.APP_URL}/reset-password?token=${token}\n\nIf you didn't ask for this, ignore this email.`,
  });
}

async function resetPassword({ token, password }) {
  const passwordHash = await hashPassword(password);
  await tx(async (c) => {
    const t = (await c.query(
      `SELECT id, user_id FROM password_reset_tokens
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() FOR UPDATE`, [sha256(token)])).rows[0];
    if (!t) throw badRequest('INVALID_TOKEN', 'This reset link is invalid or has expired');
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, t.user_id]);
    await c.query('UPDATE password_reset_tokens SET used_at = now() WHERE id = $1', [t.id]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [t.user_id]);
  });
}

/** Changing the password signs out every session; the client must log in again. */
async function changePassword(userId, { currentPassword, newPassword }) {
  const user = (await pool.query('SELECT id, password_hash FROM users WHERE id = $1', [userId])).rows[0];
  if (!(await bcrypt.compare(currentPassword, user.password_hash))) {
    throw new AppError(400, 'WRONG_PASSWORD', 'Current password is incorrect');
  }
  const passwordHash = await hashPassword(newPassword);
  await tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [passwordHash, userId]);
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  });
}

module.exports = {
  publicUser, createSession,
  signupUniversityHead, signupCollegeAdmin, signupInstructor, signupStudent,
  login, refresh, logout, forgotPassword, resetPassword, changePassword,
};
