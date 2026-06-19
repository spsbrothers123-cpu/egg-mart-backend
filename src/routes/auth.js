import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { authenticate } from '../middleware/auth.js'

export default async function authRoutes(fastify) {
  // POST /api/auth/login
  fastify.post('/login', {
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string' },
          password: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const { username, password } = req.body

    const [user] = await sql`
      SELECT id, name, username, password, role, active
      FROM users WHERE username = ${username}
    `

    if (!user || !user.active) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    const valid = await bcrypt.compare(password, user.password)
    if (!valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    // Log login
    await sql`
      INSERT INTO activity_logs (user_id, action, entity, ip)
      VALUES (${user.id}, 'login', 'user', ${req.ip})
    `

    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name },
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    return {
      token,
      user: { id: user.id, name: user.name, username: user.username, role: user.role },
    }
  })

  // GET /api/auth/me
  fastify.get('/me', { preHandler: authenticate }, async (req) => {
    const [user] = await sql`
      SELECT id, name, username, role, active, created_at
      FROM users WHERE id = ${req.user.id}
    `
    return user
  })

  // POST /api/auth/change-password
  fastify.post('/change-password', { preHandler: authenticate }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body

    const [user] = await sql`SELECT password FROM users WHERE id = ${req.user.id}`
    const valid  = await bcrypt.compare(currentPassword, user.password)

    if (!valid) return reply.code(400).send({ error: 'Current password is incorrect' })

    const hashed = await bcrypt.hash(newPassword, 10)
    await sql`UPDATE users SET password = ${hashed}, updated_at = NOW() WHERE id = ${req.user.id}`

    return { success: true }
  })
}
