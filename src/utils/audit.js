// Centralized audit-log writer. Never throws — a logging failure must not
// break the primary request. Call with either the pooled `sql` or a `tx`
// (transaction client) so log entries created inside a transaction only
// persist if the wider transaction commits.
export async function logActivity(db, { userId, action, entity, entityId = null, meta = null, ip = null }) {
  try {
    await db`
      INSERT INTO activity_logs (user_id, action, entity, entity_id, meta, ip)
      VALUES (${userId ?? null}, ${action}, ${entity ?? null}, ${entityId}, ${meta ? JSON.stringify(meta) : null}, ${ip})
    `
  } catch (err) {
    // Swallow — audit logging is best-effort and must never fail the request.
    console.error('audit log failed:', err.message)
  }
}
