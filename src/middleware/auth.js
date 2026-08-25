import sql from '../config/db.js'

// Every authenticated request re-checks users.active, not just the JWT
// signature/expiry. A JWT is a bearer credential that stays valid for its
// full lifetime (JWT_EXPIRES_IN, default 8h) regardless of what happens to
// the account afterward — without this check, deactivating a user (e.g. a
// fired cashier, a compromised account) would have no effect until their
// existing token happened to expire. This is the minimal-change approach:
// the token itself is still short-lived-ish and stateless, but a revoked
// account is locked out on its very next request instead of up to 8 hours
// later.
export async function authenticate(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
  }

  const [user] = await sql`SELECT active FROM users WHERE id = ${request.user.id}`
  if (!user || !user.active) {
    return reply.code(401).send({ error: 'Account has been deactivated' })
  }
}

export function requireRole(...roles) {
  return async function (request, reply) {
    await authenticate(request, reply)
    if (reply.sent) return
    if (!roles.includes(request.user.role)) {
      return reply.code(403).send({ error: 'Forbidden: insufficient permissions' })
    }
  }
}
