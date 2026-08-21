import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { authenticate } from '../middleware/auth.js'
import { validatePasswordPolicy } from '../utils/password.js'
import { logActivity } from '../utils/audit.js'

// Resolves a free-text `shop_location` (from public cashier signup) to a
// shop_id, without ever letting a stranger attach themselves to an
// existing shop just by guessing its name. See the /register route
// comment for the full reasoning.
async function resolveShopForSignup(sql, location) {
  const matches = await sql`
    SELECT id FROM shops WHERE active = TRUE AND LOWER(location) = LOWER(${location})
  `
  if (matches.length === 1) {
    return { shopId: matches[0].id }
  }
  if (matches.length > 1) {
    return {
      error: `More than one shop is named "${location}" — ask your admin for an invite instead of signing up directly`,
      statusCode: 409,
    }
  }

  // No existing shop with this name — only safe to auto-create it when
  // there's exactly one Admin account in the system to own it.
  const admins = await sql`SELECT id FROM users WHERE role = 'admin' LIMIT 2`
  if (admins.length === 0) {
    return { error: 'No admin account exists yet — an admin must sign up first', statusCode: 400 }
  }
  if (admins.length > 1) {
    return {
      error: `"${location}" isn't a recognized shop yet — ask your admin to create it first`,
      statusCode: 400,
    }
  }

  const [shop] = await sql`
    INSERT INTO shops (admin_id, name, location) VALUES (${admins[0].id}, ${location}, ${location}) RETURNING id
  `
  return { shopId: shop.id }
}

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
  // accounts, matching the frontend's single-endpoint contract
  // (`{ username, password, role, shop_location? }`, `name` optional).
  //
  // Admin signup just creates a standalone account (no shop yet — shops are
  // created afterward via POST /api/shops).
  //
  // Cashier signup is trickier: it's public and unauthenticated, so there's
  // no admin session to derive shop ownership from, and the frontend only
  // gives a free-text `shop_location` (not a shop_id). To resolve that
  // without ever letting a stranger attach themselves to an arbitrary
  // existing shop by guessing its name (which would defeat the whole
  // isolation model), this endpoint:
  //   1. Looks for an existing *active* shop whose location matches
  //      case-insensitively. Exactly one match -> join it.
  //   2. Multiple matches (rare — two different admins each named a shop
  //      the same thing) -> refuse; ambiguous, needs an admin-issued invite.
  //   3. No match -> only auto-creates the shop (and joins it) when there is
  //      currently exactly one Admin account in the whole system. That's
  //      the common single-business deployment this app is built for. If
  //      there's more than one Admin, auto-assigning a stranger to "the"
  //      shop would be a guess about which business they mean, so it's
  //      refused instead — an admin must create the shop first.
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
          shop_location: { type: ['string', 'null'], maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { username, password, role, shop_location } = req.body
    const name = req.body.name?.trim() || username

    const policyError = validatePasswordPolicy(password)
    if (policyError) return reply.code(400).send({ error: policyError })

    const [dup] = await sql`SELECT id FROM users WHERE username = ${username}`
    if (dup) return reply.code(409).send({ error: 'Username already exists' })

    let shopId = null
    if (role === 'cashier') {
      const location = shop_location?.trim()
      if (!location) return reply.code(400).send({ error: 'shop_location is required for a cashier account' })

      const resolved = await resolveShopForSignup(sql, location)
      if (resolved.error) return reply.code(resolved.statusCode).send({ error: resolved.error })
      shopId = resolved.shopId
    }

    const hashed = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, username, password, role, shop_id)
      VALUES (${name}, ${username}, ${hashed}, ${role}, ${shopId})
      RETURNING id, name, username, role, active, shop_id, created_at
    `

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
