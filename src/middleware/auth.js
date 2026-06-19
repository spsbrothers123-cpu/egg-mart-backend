export async function authenticate(request, reply) {
  try {
    await request.jwtVerify()
  } catch {
    return reply.code(401).send({ error: 'Unauthorized' })
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
