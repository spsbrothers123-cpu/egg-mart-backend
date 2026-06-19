import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'

export default async function userRoutes(fastify) {
  // GET /api/users
  fastify.get('/', { preHandler: requireRole('admin') }, async () => {
    return sql`SELECT id, name, username, role, active, created_at FROM users ORDER BY id`
  })

  // POST /api/users  — create cashier
  fastify.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, username, password, role = 'cashier' } = req.body
    const hashed = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, username, password, role)
      VALUES (${name}, ${username}, ${hashed}, ${role})
      RETURNING id, name, username, role, active, created_at
    `
    return reply.code(201).send(user)
  })

  // PUT /api/users/:id
  fastify.put('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
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
    return user
  })

  // POST /api/users/:id/reset-password
  fastify.post('/:id/reset-password', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { newPassword } = req.body
    const hashed = await bcrypt.hash(newPassword, 10)
    await sql`UPDATE users SET password = ${hashed}, updated_at = NOW() WHERE id = ${req.params.id}`
    return { success: true }
  })

  // GET /api/users/activity-logs
  fastify.get('/activity-logs', { preHandler: requireRole('admin') }, async () => {
    return sql`
      SELECT al.*, u.name AS user_name
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      ORDER BY al.created_at DESC
      LIMIT 100
    `
  })
}
