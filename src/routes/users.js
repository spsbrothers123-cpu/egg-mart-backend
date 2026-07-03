import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { validatePasswordPolicy } from '../utils/password.js'
import { logActivity } from '../utils/audit.js'

export default async function userRoutes(fastify) {
  // GET /api/users
  fastify.get('/', { preHandler: requireRole('admin') }, async () => {
    return sql`SELECT id, name, username, role, active, created_at FROM users ORDER BY id`
  })

  // GET /api/users/activity-logs  (must be registered before /:id-style routes are relevant;
  // Fastify matches static paths before params so this is safe regardless of order)
  fastify.get('/activity-logs', { preHandler: requireRole('admin') }, async (req) => {
    const { limit = 100, offset = 0 } = req.query
    const safeLimit = Math.min(500, Math.max(1, parseInt(limit) || 100))
    const safeOffset = Math.max(0, parseInt(offset) || 0)
    return sql`
      SELECT al.*, u.name AS user_name
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `
  })

  // POST /api/users  — create cashier/admin
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['name', 'username', 'password'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_.-]+$' },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['admin', 'cashier'] },
        },
      },
    },
  }, async (req, reply) => {
    const { name, username, password, role = 'cashier' } = req.body

    const policyError = validatePasswordPolicy(password)
    if (policyError) return reply.code(400).send({ error: policyError })

    const [dup] = await sql`SELECT id FROM users WHERE username = ${username}`
    if (dup) return reply.code(409).send({ error: 'Username already exists' })

    const hashed = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, username, password, role)
      VALUES (${name}, ${username}, ${hashed}, ${role})
      RETURNING id, name, username, role, active, created_at
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'user_created', entity: 'user',
      entityId: user.id, meta: { username: user.username, role: user.role }, ip: req.ip,
    })

    return reply.code(201).send(user)
  })

  // PUT /api/users/:id
  fastify.put('/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { name, active } = req.body
    const [user] = await sql`
      UPDATE users SET
        name       = COALESCE(${name   ?? null}, name),
        active     = COALESCE(${active ?? null}::boolean, active),
        updated_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING id, name, username, role, active
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'user_updated', entity: 'user',
      entityId: user.id, meta: { active: user.active }, ip: req.ip,
    })

    return user
  })

  // POST /api/users/:id/reset-password
  fastify.post('/:id/reset-password', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['newPassword'],
        properties: { newPassword: { type: 'string', minLength: 8 } },
      },
    },
  }, async (req, reply) => {
    const { newPassword } = req.body

    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) return reply.code(400).send({ error: policyError })

    const hashed = await bcrypt.hash(newPassword, 10)
    const [user] = await sql`
      UPDATE users SET password = ${hashed}, updated_at = NOW() WHERE id = ${req.params.id}
      RETURNING id, username
    `
    if (!user) return reply.code(404).send({ error: 'User not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'password_reset', entity: 'user',
      entityId: user.id, meta: { target_username: user.username }, ip: req.ip,
    })

    return { success: true }
  })
}
