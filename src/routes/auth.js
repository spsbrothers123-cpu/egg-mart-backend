import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { authenticate } from '../middleware/auth.js'
import { validatePasswordPolicy } from '../utils/password.js'
import { logActivity } from '../utils/audit.js'

export default async function authRoutes(fastify) {
  // POST /api/auth/login — strict rate limit to slow down credential stuffing / brute force
  fastify.post('/login', {
    config: {
      rateLimit: { max: 8, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 1, maxLength: 100 },
          password: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { username, password } = req.body

    const [user] = await sql`
      SELECT id, name, username, password, role, active
      FROM users WHERE username = ${username}
    `

    // Always run bcrypt.compare, even for a nonexistent user, against a
    // fixed dummy hash — otherwise response time reveals whether a
    // username exists (a timing side-channel for username enumeration).
    const hashToCompare = user?.password ?? '$2a$10$7XiQ00QT9EieeQfjNHvBbeNpno8ut3v0o3r/1/Rj2eAcsKI0nzsqy'
    const valid = await bcrypt.compare(password, hashToCompare)

    if (!user || !user.active || !valid) {
      return reply.code(401).send({ error: 'Invalid credentials' })
    }

    await logActivity(sql, {
      userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip: req.ip,
    })

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
  fastify.post('/change-password', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['currentPassword', 'newPassword'],
        properties: {
          currentPassword: { type: 'string', minLength: 1 },
          newPassword: { type: 'string', minLength: 1 },
        },
      },
    },
  }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body

    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) return reply.code(400).send({ error: policyError })

    const [user] = await sql`SELECT password FROM users WHERE id = ${req.user.id}`
    const valid  = await bcrypt.compare(currentPassword, user.password)

    if (!valid) return reply.code(400).send({ error: 'Current password is incorrect' })

    const hashed = await bcrypt.hash(newPassword, 10)
    await sql`UPDATE users SET password = ${hashed}, updated_at = NOW() WHERE id = ${req.user.id}`

    await logActivity(sql, {
      userId: req.user.id, action: 'password_changed', entity: 'user', entityId: req.user.id, ip: req.ip,
    })

    return { success: true }
  })
}
