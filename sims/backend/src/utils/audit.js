'use strict';

/** Pull the audit-relevant bits out of a request: who, from where, and their scope. */
function ctxOf(req) {
  return {
    actorId: req.user?.id ?? null,
    actorRole: req.user?.role ?? null,
    ip: req.ip ?? null,
    universityId: req.scope?.universityId ?? null,
    collegeId: req.scope?.collegeId ?? null,
  };
}

/**
 * Append an audit-log row. Pass the transaction client so the log commits (or rolls
 * back) together with the change it describes.
 */
async function audit(db, e) {
  await db.query(
    `INSERT INTO audit_logs
       (actor_id, actor_role, action, entity_type, entity_id, class_id, college_id, university_id, metadata, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [e.actorId ?? null, e.actorRole ?? null, e.action, e.entityType ?? null, e.entityId ?? null,
      e.classId ?? null, e.collegeId ?? null, e.universityId ?? null,
      JSON.stringify(e.metadata ?? {}), e.ip ?? null],
  );
}

module.exports = { audit, ctxOf };
