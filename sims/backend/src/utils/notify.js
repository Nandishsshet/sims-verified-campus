'use strict';

/**
 * Persist an in-app notification. (Real-time SSE push is layered on top in a later
 * phase; the row is the source of truth.)
 */
async function notify(db, userId, { type, title, body = null, link = null }) {
  await db.query(
    'INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)',
    [userId, type, title, body, link],
  );
}

/** Same notification for many users in one statement. */
async function notifyMany(db, userIds, { type, title, body = null, link = null }) {
  if (!userIds.length) return;
  await db.query(
    'INSERT INTO notifications (user_id, type, title, body, link) SELECT u, $2, $3, $4, $5 FROM unnest($1::uuid[]) AS u',
    [userIds, type, title, body, link],
  );
}

module.exports = { notify, notifyMany };
