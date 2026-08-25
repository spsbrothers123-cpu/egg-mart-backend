import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { authenticate } from '../middleware/auth.js'
import { validatePasswordPolicy } from '../utils/password.js'
import { logActivity } from '../utils/audit.js'
import { consumeShopInvite } from '../utils/shop-scope.js'

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
      SELECT id, name, username, password, role, active, shop_id
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

    // shop_id is embedded in the token so every downstream route can derive
    // a cashier's shop authorization straight from the JWT — never from a
    // client-supplied field.
    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, shop_id: user.shop_id ?? null },
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    let shop = null
    if (user.shop_id) {
      [shop] = await sql`SELECT id, name, location FROM shops WHERE id = ${user.shop_id}`
    }

    return {
      token,
      user: {
        id: user.id, name: user.name, username: user.username, role: user.role,
        shop, shop_location: shop?.location ?? null,
      },
    }
  })

  // POST /api/auth/register — public signup for both Admin and Cashier
  // accounts.
  //
  // Admin signup just creates a standalone account (no shop yet — shops are
  // created afterward via POST /api/shops).
  //
  // Cashier signup is invite-only. This endpoint used to resolve a
  // free-text `shop_location` field to a shop by case-insensitive name
  // match — but a shop's location/name is public-facing text (it's printed
  // on receipts and storefront signage), so that was effectively
  // "authorization by guessable string": anyone who saw a receipt could
  // self-register as a cashier for that shop and immediately get read
  // access to its products, customers, and bills. Location text is NEVER
  // used for authorization anywhere in this codebase now.
  //
  // Instead, cashier signup requires `invite_code` — an unguessable,
  // single-use, expiring token an admin explicitly issued for one specific
  // shop_id via POST /api/shops/:id/invites. See shop-scope.js
  // (createShopInvite / consumeShopInvite) for the enforcement.
  fastify.post('/register', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password', 'role'],
        properties: {
          name: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
          username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_.-]+$' },
          password: { type: 'string', minLength: 8 },
          role: { type: 'string', enum: ['admin', 'cashier'] },
          invite_code: { type: ['string', 'null'], maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { username, password, role, invite_code } = req.body
    const name = req.body.name?.trim() || username

    const policyError = validatePasswordPolicy(password)
    if (policyError) return reply.code(400).send({ error: policyError })

    if (role === 'cashier' && !invite_code?.trim()) {
      return reply.code(400).send({ error: 'invite_code is required for a cashier account — ask your admin for an invite link' })
    }

    const [dup] = await sql`SELECT id FROM users WHERE username = ${username}`
    if (dup) return reply.code(409).send({ error: 'Username already exists' })

    const hashed = await bcrypt.hash(password, 10)

    let user, shopId = null
    try {
      user = await sql.begin(async tx => {
        if (role === 'cashier') {
          // Validate + consume the invite inside the same transaction as
          // user creation, so a code can never be redeemed twice even
          // under concurrent requests, and a failed user insert can never
          // leave an invite burned with no account to show for it.
          const resolved = await consumeShopInvite(tx, invite_code.trim(), null)
          if (resolved.error) {
            throw Object.assign(new Error(resolved.error), { statusCode: resolved.statusCode })
          }
          shopId = resolved.shopId
        }

        const [u] = await tx`
          INSERT INTO users (name, username, password, role, shop_id)
          VALUES (${name}, ${username}, ${hashed}, ${role}, ${shopId})
          RETURNING id, name, username, role, active, shop_id, created_at
        `

        if (role === 'cashier') {
          await tx`UPDATE shop_invites SET used_by = ${u.id} WHERE shop_id = ${shopId} AND used_at IS NOT NULL AND used_by IS NULL`
        }

        return u
      })
    } catch (err) {
      if (err.statusCode) return reply.code(err.statusCode).send({ error: err.message })
      throw err
    }

    await logActivity(sql, {
      userId: user.id, action: role === 'admin' ? 'admin_registered' : 'cashier_registered',
      entity: 'user', entityId: user.id, meta: { shop_id: shopId }, ip: req.ip,
    })

    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, shop_id: shopId },
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    let shop = null
    if (shopId) {
      [shop] = await sql`SELECT id, name, location FROM shops WHERE id = ${shopId}`
    }

    return reply.code(201).send({
      token,
      user: { ...user, shop, shop_location: shop?.location ?? null },
    })
  })

  // POST /api/auth/register-admin — kept as a direct, explicit alias for
  // admin-only signup (no role field to get wrong). Internally identical to
  // POST /api/auth/register with role: 'admin'.
  fastify.post('/register-admin', {
    config: {
      rateLimit: { max: 5, timeWindow: '1 minute' },
    },
    schema: {
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          name: { type: ['string', 'null'], minLength: 1, maxLength: 200 },
          username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_.-]+$' },
          password: { type: 'string', minLength: 8 },
        },
      },
    },
  }, async (req, reply) => {
    const { username, password } = req.body
    const name = req.body.name?.trim() || username

    const policyError = validatePasswordPolicy(password)
    if (policyError) return reply.code(400).send({ error: policyError })

    const [dup] = await sql`SELECT id FROM users WHERE username = ${username}`
    if (dup) return reply.code(409).send({ error: 'Username already exists' })

    const hashed = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, username, password, role)
      VALUES (${name}, ${username}, ${hashed}, 'admin')
      RETURNING id, name, username, role, active, created_at
    `

    await logActivity(sql, {
      userId: user.id, action: 'admin_registered', entity: 'user', entityId: user.id, ip: req.ip,
    })

    const token = fastify.jwt.sign(
      { id: user.id, username: user.username, role: user.role, name: user.name, shop_id: null },
      { expiresIn: process.env.JWT_EXPIRES_IN || '8h' }
    )

    return reply.code(201).send({ token, user })
  })

  // GET /api/auth/me
  fastify.get('/me', { preHandler: authenticate }, async (req) => {
    const [user] = await sql`
      SELECT id, name, username, role, active, shop_id, created_at
      FROM users WHERE id = ${req.user.id}
    `
    if (user?.shop_id) {
      const [shop] = await sql`SELECT id, name, location FROM shops WHERE id = ${user.shop_id}`
      return { ...user, shop, shop_location: shop?.location ?? null }
    }
    return { ...user, shop_location: null }
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
