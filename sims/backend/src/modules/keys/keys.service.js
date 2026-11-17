'use strict';
/**
 * Unique-key service: issue, rotate, revoke, redeem, log.
 *
 * Security model (see docs/ARCHITECTURE.md §5):
 *   - redeeming a key never grants access by itself — callers create a PENDING
 *     membership that a human one level up must approve;
 *   - redemption is a single atomic UPDATE ... RETURNING, so max_uses can't be
 *     exceeded by concurrent requests;
 *   - failed attempts are logged OUTSIDE the transaction (they must survive rollback)
 *     and trigger a persistent lockout per IP / account;
 *   - the error for "unknown", "revoked", "expired", "used up" and "organisation
 *     inactive" is identical, so the API is not a key-guessing oracle.
 */
const env = require('../../config/env');
const { pool, tx } = require('../../db/pool');
const { AppError, notFound, badRequest } = require('../../utils/errors');
const { generateKey, normalizeKey, PREFIXES } = require('../../utils/keygen');

const SCOPES = Object.freeze({
  university: { prefix: PREFIXES.university, column: 'university_id' },
  college: { prefix: PREFIXES.college, column: 'college_id' },
  class: { prefix: PREFIXES.class, column: 'class_id' },
});

const publicKey = (r) => r && ({
  id: r.id, keyValue: r.key_value, status: r.status, expiresAt: r.expires_at,
  maxUses: r.max_uses, useCount: r.use_count, createdAt: r.created_at,
});

// ---------------------------------------------------------------- logging
async function logKeyEvent(db, { keyId = null, attemptedValue = null, userId = null, event, detail = null, ip = null, userAgent = null }) {
  await db.query(
    `INSERT INTO key_usage_logs (key_id, attempted_value, user_id, event, detail, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [keyId, attemptedValue && String(attemptedValue).slice(0, 24), userId, event, detail, ip, userAgent && userAgent.slice(0, 255)]);
}

// ---------------------------------------------------------------- issuing
/**
 * Create a new ACTIVE key for a scope object. Retries on the (astronomically unlikely)
 * key_value collision using a savepoint so the surrounding transaction survives.
 * Fails with 409 (uq_active_key_*) if the scope already has an active key.
 */
async function issueKey(db, { scope, scopeId, createdBy, expiresAt = null, maxUses = null }) {
  const { prefix, column } = SCOPES[scope];
  for (let attempt = 0; attempt < 5; attempt++) {
    await db.query('SAVEPOINT issue_key');
    try {
      const { rows } = await db.query(
        `INSERT INTO access_keys (key_value, ${column}, created_by, expires_at, max_uses)
         VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [generateKey(prefix), scopeId, createdBy, expiresAt, maxUses]);
      await db.query('RELEASE SAVEPOINT issue_key');
      await logKeyEvent(db, { keyId: rows[0].id, userId: createdBy, event: 'created' });
      return rows[0];
    } catch (err) {
      await db.query('ROLLBACK TO SAVEPOINT issue_key');
      if (err.code === '23505' && err.constraint === 'access_keys_key_value_key') continue; // collision → retry
      throw err;
    }
  }
  throw new AppError(500, 'KEY_GENERATION_FAILED', 'Could not generate a unique key');
}

async function getActiveKey(db, scope, scopeId) {
  const { column } = SCOPES[scope];
  const { rows } = await db.query(
    `SELECT * FROM access_keys WHERE ${column} = $1 AND status = 'active'`, [scopeId]);
  return rows[0] || null;
}

/** Replace the active key with a fresh one. The old key stops working immediately. */
async function rotateKey({ scope, scopeId, actor, ip, expiresAt = null, maxUses = null }) {
  return tx(async (c) => {
    const { column } = SCOPES[scope];
    const { rows } = await c.query(
      `UPDATE access_keys SET status = 'rotated' WHERE ${column} = $1 AND status = 'active' RETURNING id`, [scopeId]);
    const oldId = rows[0]?.id;
    const fresh = await issueKey(c, { scope, scopeId, createdBy: actor.id, expiresAt, maxUses });
    if (oldId) {
      await c.query('UPDATE access_keys SET replaced_by = $1 WHERE id = $2', [fresh.id, oldId]);
      await logKeyEvent(c, { keyId: oldId, userId: actor.id, event: 'rotated', detail: `replaced by ${fresh.id}`, ip });
    }
    return fresh;
  });
}

async function revokeKey({ scope, scopeId, actor, ip }) {
  return tx(async (c) => {
    const { column } = SCOPES[scope];
    const { rows } = await c.query(
      `UPDATE access_keys SET status = 'revoked', revoked_at = now()
        WHERE ${column} = $1 AND status = 'active' RETURNING *`, [scopeId]);
    if (!rows[0]) throw new AppError(409, 'NO_ACTIVE_KEY', 'There is no active key to revoke');
    await logKeyEvent(c, { keyId: rows[0].id, userId: actor.id, event: 'revoked', ip });
    return rows[0];
  });
}

/** Change expiry / usage cap of the ACTIVE key. `null` clears a limit; `undefined` leaves it. */
async function updateKeySettings({ keyId, expiresAt, maxUses }) {
  const { rows } = await pool.query('SELECT * FROM access_keys WHERE id = $1', [keyId]);
  const key = rows[0];
  if (!key) throw notFound('Key');
  if (key.status !== 'active') throw new AppError(409, 'KEY_NOT_ACTIVE', 'Only an active key can be edited');
  if (expiresAt && new Date(expiresAt) <= new Date()) throw badRequest('INVALID_EXPIRY', 'Expiry must be in the future');
  if (maxUses != null && maxUses < key.use_count) {
    throw badRequest('INVALID_MAX_USES', `Max uses cannot be below the current use count (${key.use_count})`);
  }
  const upd = await pool.query(
    `UPDATE access_keys
        SET expires_at = CASE WHEN $2::boolean THEN $3 ELSE expires_at END,
            max_uses   = CASE WHEN $4::boolean THEN $5 ELSE max_uses END
      WHERE id = $1 RETURNING *`,
    [keyId, expiresAt !== undefined, expiresAt ?? null, maxUses !== undefined, maxUses ?? null]);
  return upd.rows[0];
}

// ---------------------------------------------------------------- redeeming
const invalidKey = (reason) => Object.assign(
  new AppError(400, 'KEY_INVALID', 'This key is invalid, expired or no longer available'), { reason });

/**
 * Atomically consume one use of a key. Throws KEY_INVALID (uniform message) if the key
 * is malformed, unknown, revoked, rotated, expired or used up.
 */
async function redeemKey(db, rawKey, scope) {
  const { prefix, column } = SCOPES[scope];
  const value = normalizeKey(rawKey);
  if (!value) throw invalidKey('malformed');
  if (!value.startsWith(`${prefix}-`)) throw invalidKey('wrong_type');

  const { rows } = await db.query(
    `UPDATE access_keys SET use_count = use_count + 1
      WHERE key_value = $1 AND status = 'active' AND ${column} IS NOT NULL
        AND (expires_at IS NULL OR expires_at > now())
        AND (max_uses IS NULL OR use_count < max_uses)
      RETURNING *`, [value]);
  if (rows[0]) return rows[0];

  // Work out WHY (for the log only — never returned to the caller).
  const why = await pool.query('SELECT id, status, expires_at, max_uses, use_count FROM access_keys WHERE key_value = $1', [value]);
  const k = why.rows[0];
  const reason = !k ? 'unknown'
    : k.status !== 'active' ? k.status
      : k.expires_at && new Date(k.expires_at) <= new Date() ? 'expired' : 'max_uses';
  if (k && reason === 'expired') await pool.query(`UPDATE access_keys SET status = 'expired' WHERE id = $1 AND status = 'active'`, [k.id]);
  throw Object.assign(invalidKey(reason), { keyId: k?.id });
}

/** Persistent lockout: too many failed guesses from this IP or account in 15 minutes. */
async function assertNotLocked({ ip, userId }) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM key_usage_logs
      WHERE event = 'join_denied' AND created_at > now() - interval '15 minutes'
        AND ( ($1::inet IS NOT NULL AND ip = $1::inet) OR ($2::uuid IS NOT NULL AND user_id = $2::uuid) )`,
    [ip ?? null, userId ?? null]);
  if (rows[0].n >= env.KEY_MAX_FAILED_ATTEMPTS) {
    throw new AppError(429, 'KEY_LOCKED', 'Too many failed key attempts. Try again in 15 minutes.');
  }
}

/**
 * Run `work` inside a transaction that first redeems a key.
 *   work(client, key) must return { data, userId }  (userId for the usage log)
 * If anything in `work` throws, the use_count increment is rolled back too.
 * A failed redemption is logged (outside the transaction) and counts toward the lockout.
 */
async function joinWithKey({ scope, rawKey, ctx, work }) {
  await assertNotLocked(ctx);
  try {
    return await tx(async (client) => {
      const key = await redeemKey(client, rawKey, scope);
      const { data, userId } = await work(client, key);
      await logKeyEvent(client, { keyId: key.id, userId: userId ?? ctx.userId, event: 'joined', ip: ctx.ip, userAgent: ctx.userAgent });
      return data;
    });
  } catch (err) {
    if (err instanceof AppError && err.code === 'KEY_INVALID') {
      await logKeyEvent(pool, {
        keyId: err.keyId ?? null, attemptedValue: typeof rawKey === 'string' ? rawKey : null,
        userId: ctx.userId ?? null, event: 'join_denied', detail: err.reason, ip: ctx.ip, userAgent: ctx.userAgent,
      }).catch(() => {});
    }
    throw err;
  }
}

// ---------------------------------------------------------------- authorisation
/** Can this caller manage the key of (scope, id)? Throws 404 otherwise. */
async function assertCanManage(reqScope, scope, id) {
  const { role } = reqScope;
  let ok = false;
  if (scope === 'university') {
    ok = role === 'university_head' && reqScope.universityId === id;
  } else if (scope === 'college') {
    if (role === 'college_admin') ok = reqScope.collegeId === id && reqScope.status === 'active';
    else if (role === 'university_head') {
      const { rows } = await pool.query('SELECT 1 FROM colleges WHERE id = $1 AND university_id = $2', [id, reqScope.universityId]);
      ok = rows.length > 0;
    }
  } else if (scope === 'class') {
    ok = role === 'instructor' && reqScope.classIds.includes(id);
  }
  if (!ok) throw notFound('Key target');
}

/** Active keys belonging to the caller. */
async function getMyKeys(reqScope) {
  const { role } = reqScope;
  if (role === 'university_head') {
    const k = reqScope.universityId && await getActiveKey(pool, 'university', reqScope.universityId);
    return [{ scope: 'university', scopeId: reqScope.universityId, key: publicKey(k) }];
  }
  if (role === 'college_admin') {
    if (!reqScope.collegeId) return [];
    const k = await getActiveKey(pool, 'college', reqScope.collegeId);
    return [{ scope: 'college', scopeId: reqScope.collegeId, key: publicKey(k) }];
  }
  if (role === 'instructor') {
    const { rows } = await pool.query(
      `SELECT c.id AS class_id, c.name AS class_name, k.* FROM classes c
         LEFT JOIN access_keys k ON k.class_id = c.id AND k.status = 'active'
        WHERE c.id = ANY($1::uuid[]) ORDER BY c.created_at`, [reqScope.classIds]);
    // k.* supplies id/key_value/...; class identity is carried in class_id/class_name
    return rows.map((r) => ({ scope: 'class', scopeId: r.class_id, label: r.class_name, key: r.key_value ? publicKey(r) : null }));
  }
  return [];
}

async function getKeyLogs(keyId, limit = 50) {
  const { rows } = await pool.query(
    `SELECT l.id, l.event, l.detail, l.created_at, u.full_name AS user_name, u.role AS user_role
       FROM key_usage_logs l LEFT JOIN users u ON u.id = l.user_id
      WHERE l.key_id = $1 ORDER BY l.created_at DESC LIMIT $2`, [keyId, limit]);
  return rows.map((r) => ({ id: r.id, event: r.event, detail: r.detail, at: r.created_at, user: r.user_name, userRole: r.user_role }));
}

module.exports = {
  SCOPES, publicKey, logKeyEvent, issueKey, getActiveKey, rotateKey, revokeKey, updateKeySettings,
  redeemKey, joinWithKey, invalidKey, assertCanManage, getMyKeys, getKeyLogs,
};
