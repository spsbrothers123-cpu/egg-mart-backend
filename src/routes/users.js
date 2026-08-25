import bcrypt from 'bcryptjs'
import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { validatePasswordPolicy } from '../utils/password.js'
import { logActivity } from '../utils/audit.js'
import { getOwnedShopIds, assertShopOwnedByAdmin, assertCashierVisibleToAdmin } from '../utils/shop-scope.js'

export default async function userRoutes(fastify) {
  // GET /api/users — "Users & Sessions": cashiers belonging to this admin's
  // shops (never another admin's cashiers, never other admin accounts).
  //
  // Uses a LEFT JOIN (not INNER JOIN) against shops so that a cashier whose
  // shop_id has gone NULL — e.g. their shop was deleted, which sets
  // users.shop_id to NULL via ON DELETE SET NULL — still appears instead of
  // silently vanishing from the list. Since such a cashier no longer has a
  // shop to derive ownership from, authorization for the NULL-shop_id case
  // falls back to activity_logs: only the admin who originally created that
  // cashier account can see it. This never exposes another admin's shops or
  // cashiers — a cashier is included only if it's currently in one of this
  // admin's shops OR this admin's own creation record says it's theirs.
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const shopIds = await getOwnedShopIds(sql, req.user.id)

    const rows = await sql`
      SELECT u.id, u.name, u.username, u.role, u.active, u.created_at, u.updated_at,
             s.id AS shop_id, s.name AS shop_name, s.location AS shop_location
      FROM users u
      LEFT JOIN shops s ON s.id = u.shop_id
      WHERE u.role = 'cashier'
        AND (
          u.shop_id = ANY(${shopIds})
          OR (
            u.shop_id IS NULL
            AND EXISTS (
              SELECT 1 FROM activity_logs al
              WHERE al.entity = 'user' AND al.entity_id = u.id
                AND al.action = 'user_created' AND al.user_id = ${req.user.id}
            )
          )
        )
      ORDER BY u.id
    `
    return rows.map(({ shop_id, shop_name, shop_location, ...u }) => ({
      ...u,
      state: shop_id ? 'assigned' : 'unassigned',
      shop_location, // flat field for convenience — same value as shop.location (null when unassigned)
      shop: shop_id ? { id: shop_id, name: shop_name, location: shop_location } : null,
    }))
  })

  // GET /api/users/activity-logs — scoped to this admin's own actions plus
  // their cashiers' actions, so one admin can't read another admin's audit
  // trail. (must be registered before /:id-style routes; Fastify matches
  // static paths before params so this is safe regardless of order)
  fastify.get('/activity-logs', { preHandler: requireRole('admin') }, async (req) => {
    const { limit = 100, offset = 0 } = req.query
    const safeLimit = Math.min(500, Math.max(1, parseInt(limit) || 100))
    const safeOffset = Math.max(0, parseInt(offset) || 0)
    const shopIds = await getOwnedShopIds(sql, req.user.id)

    return sql`
      SELECT al.*, u.name AS user_name
      FROM activity_logs al
      LEFT JOIN users u ON u.id = al.user_id
      WHERE al.user_id = ${req.user.id}
         OR (u.shop_id = ANY(${shopIds}) AND u.role = 'cashier')
      ORDER BY al.created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `
  })

  // GET /api/users/:userId/sessions — cashier's session history (section 11).
  // Authorization: the cashier must currently belong to a shop owned by this
  // admin, or — if orphaned (shop_id NULL, e.g. their shop was deleted) —
  // this admin's activity_logs record must show they created that cashier.
  // See assertCashierVisibleToAdmin for the full reasoning; this keeps the
  // session-history endpoint consistent with what GET /api/users now shows.
  fastify.get('/:userId/sessions', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [cashier] = await sql`
      SELECT id, name, username, shop_id FROM users WHERE id = ${req.params.userId} AND role = 'cashier'
    `
    if (!cashier) return reply.code(404).send({ error: 'Cashier not found' })

    await assertCashierVisibleToAdmin(fastify, sql, req.user.id, cashier)

    const sessions = await sql`
      SELECT
        s.*,
        COUNT(b.id)::int                        AS bill_count,
        COALESCE(SUM(b.total), 0)::numeric      AS total_revenue,
        EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))::int AS duration_seconds
      FROM sessions s
      LEFT JOIN bills b
        ON b.cashier_id = s.cashier_id
        AND b.created_at >= s.opened_at
        AND b.created_at <= COALESCE(s.closed_at, NOW())
        AND b.payment_status != 'voided'
      WHERE s.cashier_id = ${cashier.id}
      GROUP BY s.id
      ORDER BY s.opened_at DESC
    `
    return { cashier: { id: cashier.id, name: cashier.name, username: cashier.username }, sessions }
  })

  // POST /api/users — create a cashier for one of this admin's own shops.
  // Admin accounts are created only via POST /api/auth/register-admin (see
  // auth.js) — allowing them to be minted through this authenticated route
  // as before would let any admin silently create sibling admin accounts
  // with no shop ownership boundary, which breaks the isolation model this
  // whole feature depends on. This is a deliberate, documented breaking
  // change (see the "role" field below); everything else about this route
  // is unchanged.
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['name', 'username', 'password', 'shop_id'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_.-]+$' },
          password: { type: 'string', minLength: 8 },
          shop_id: { type: 'integer' },
        },
      },
    },
  }, async (req, reply) => {
    const { name, username, password, shop_id } = req.body

    // Shop access must be derived from the authenticated admin's own shops —
    // never trust that a client-supplied shop_id is actually theirs.
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, shop_id)

    const policyError = validatePasswordPolicy(password)
    if (policyError) return reply.code(400).send({ error: policyError })

    const [dup] = await sql`SELECT id FROM users WHERE username = ${username}`
    if (dup) return reply.code(409).send({ error: 'Username already exists' })

    const hashed = await bcrypt.hash(password, 10)
    const [user] = await sql`
      INSERT INTO users (name, username, password, role, shop_id)
      VALUES (${name}, ${username}, ${hashed}, 'cashier', ${shop_id})
      RETURNING id, name, username, role, active, shop_id, created_at
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'user_created', entity: 'user',
      entityId: user.id, meta: { username: user.username, role: user.role, shop_id }, ip: req.ip,
    })

    return reply.code(201).send(user)
  })

  // PUT /api/users/:id — edit a cashier's name/username (section 12).
  // Also registered as PATCH (identical handler) since the frontend's
  // Users & Sessions page calls PATCH — same semantics either way, this
  // route always does a partial/COALESCE update regardless of HTTP verb.
  // Historical bills/sessions reference the stable numeric cashier_id, not
  // the username, so renaming here never touches those foreign keys.
  const editCashierOpts = {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          username: { type: 'string', minLength: 3, maxLength: 50, pattern: '^[a-zA-Z0-9_.-]+$' },
          active: { type: 'boolean' },
        },
      },
    },
  }
  async function editCashierHandler(req, reply) {
    const { name, username, active } = req.body

    const [existing] = await sql`SELECT id, role, shop_id FROM users WHERE id = ${req.params.id}`
    if (!existing) return reply.code(404).send({ error: 'User not found' })
    if (existing.role !== 'cashier') {
      // Admins can only manage cashiers through this route, never other
      // admin accounts (including their own).
      return reply.code(403).send({ error: 'Only cashier accounts can be edited here' })
    }
    // Verifies the cashier's shop belongs to the authenticated admin.
    await assertCashierVisibleToAdmin(fastify, sql, req.user.id, existing)

    if (username) {
      const [dup] = await sql`SELECT id FROM users WHERE username = ${username} AND id != ${req.params.id}`
      if (dup) return reply.code(409).send({ error: 'Username already exists' })
    }

    const [user] = await sql`
      UPDATE users SET
        name       = COALESCE(${name     ?? null}, name),
        username   = COALESCE(${username ?? null}, username),
        active     = COALESCE(${active   ?? null}::boolean, active),
        updated_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING id, name, username, role, active, shop_id
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'user_updated', entity: 'user',
      entityId: user.id, meta: { active: user.active, username: user.username }, ip: req.ip,
    })

    return user
  }
  fastify.put('/:id', editCashierOpts, editCashierHandler)
  fastify.patch('/:id', editCashierOpts, editCashierHandler)

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

    const [existing] = await sql`SELECT id, role, shop_id FROM users WHERE id = ${req.params.id}`
    if (!existing) return reply.code(404).send({ error: 'User not found' })
    if (existing.role !== 'cashier') {
      return reply.code(403).send({ error: 'Only cashier accounts can be reset here' })
    }
    await assertCashierVisibleToAdmin(fastify, sql, req.user.id, existing)

    const policyError = validatePasswordPolicy(newPassword)
    if (policyError) return reply.code(400).send({ error: policyError })

    const hashed = await bcrypt.hash(newPassword, 10)
    const [user] = await sql`
      UPDATE users SET password = ${hashed}, updated_at = NOW() WHERE id = ${req.params.id}
      RETURNING id, username
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'password_reset', entity: 'user',
      entityId: user.id, meta: { target_username: user.username }, ip: req.ip,
    })

    return { success: true }
  })
}
