import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { assertShopOwnedByAdmin, createShopInvite } from '../utils/shop-scope.js'

export default async function shopRoutes(fastify) {
  // GET /api/shops — admin's own shops, with cashier + today's bill counts
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    return sql`
      SELECT
        s.*,
        COUNT(DISTINCT u.id)::int AS cashier_count
      FROM shops s
      LEFT JOIN users u ON u.shop_id = s.id AND u.role = 'cashier'
      WHERE s.admin_id = ${req.user.id}
      GROUP BY s.id
      ORDER BY s.id
    `
  })

  // GET /api/shops/:id
  fastify.get('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [shop] = await sql`SELECT * FROM shops WHERE id = ${req.params.id} AND admin_id = ${req.user.id}`
    if (!shop) return reply.code(404).send({ error: 'Shop not found' })

    const cashiers = await sql`
      SELECT id, name, username, active FROM users WHERE shop_id = ${shop.id} AND role = 'cashier' ORDER BY id
    `
    return { ...shop, cashiers }
  })

  // POST /api/shops
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['location'],
        properties: {
          name: { type: ['string', 'null'], maxLength: 200 },
          location: { type: 'string', minLength: 1, maxLength: 200 },
        },
      },
    },
  }, async (req, reply) => {
    const { name, location } = req.body
    const [shop] = await sql`
      INSERT INTO shops (admin_id, name, location)
      VALUES (${req.user.id}, ${name ?? null}, ${location})
      RETURNING *
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'shop_created', entity: 'shop',
      entityId: shop.id, meta: { location: shop.location }, ip: req.ip,
    })

    return reply.code(201).send(shop)
  })

  // PUT /api/shops/:id
  fastify.put('/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: ['string', 'null'], maxLength: 200 },
          location: { type: 'string', minLength: 1, maxLength: 200 },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, req.params.id)
    const { name, location, active } = req.body

    const [shop] = await sql`
      UPDATE shops SET
        name       = COALESCE(${name     ?? null}, name),
        location   = COALESCE(${location ?? null}, location),
        active     = COALESCE(${active   ?? null}::boolean, active),
        updated_at = NOW()
      WHERE id = ${req.params.id} AND admin_id = ${req.user.id}
      RETURNING *
    `
    if (!shop) return reply.code(404).send({ error: 'Shop not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'shop_updated', entity: 'shop', entityId: shop.id, ip: req.ip,
    })

    return shop
  })

  // DELETE /api/shops/:id (soft — deactivate; cashiers/data stay linked for history)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, req.params.id)

    const [shop] = await sql`
      UPDATE shops SET active = FALSE, updated_at = NOW()
      WHERE id = ${req.params.id} AND admin_id = ${req.user.id}
      RETURNING id
    `
    if (!shop) return reply.code(404).send({ error: 'Shop not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'shop_deactivated', entity: 'shop', entityId: shop.id, ip: req.ip,
    })

    return reply.code(204).send()
  })

  // ── Cashier signup invites ────────────────────────────────────────────
  // The only mechanism that can ever attach a public /api/auth/register
  // signup to a shop. Every invite is scoped to exactly one shop_id that's
  // already been verified to belong to the calling admin, is single-use,
  // and expires — never derived from shop name/location text.

  // POST /api/shops/:id/invites — create a new invite for this shop
  fastify.post('/:id/invites', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          expires_in_hours: { type: 'integer', minimum: 1, maximum: 24 * 30 },
        },
      },
    },
  }, async (req, reply) => {
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, req.params.id)
    const expiresInHours = req.body?.expires_in_hours ?? 24

    const invite = await createShopInvite(sql, {
      shopId: req.params.id,
      createdBy: req.user.id,
      expiresInHours,
    })

    await logActivity(sql, {
      userId: req.user.id, action: 'shop_invite_created', entity: 'shop_invite',
      entityId: invite.id, meta: { shop_id: invite.shop_id, expires_at: invite.expires_at }, ip: req.ip,
    })

    return reply.code(201).send(invite)
  })

  // GET /api/shops/:id/invites — list invites for this shop (admin manages/audits them)
  fastify.get('/:id/invites', { preHandler: requireRole('admin') }, async (req) => {
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, req.params.id)
    return sql`
      SELECT id, shop_id, expires_at, used_at, used_by, revoked_at, created_at
      FROM shop_invites
      WHERE shop_id = ${req.params.id}
      ORDER BY created_at DESC
    `
    // Note: the invite `code` itself is intentionally never returned here —
    // it was only ever shown once, at creation time, in the POST response.
    // Re-listing it would turn "read access to the shop" into "ability to
    // mint working signup links", which is a bigger permission than
    // viewing invite history should grant.
  })

  // DELETE /api/shops/:id/invites/:inviteId — revoke an unused invite
  fastify.delete('/:id/invites/:inviteId', { preHandler: requireRole('admin') }, async (req, reply) => {
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, req.params.id)

    const [invite] = await sql`
      UPDATE shop_invites SET revoked_at = NOW()
      WHERE id = ${req.params.inviteId} AND shop_id = ${req.params.id} AND used_at IS NULL AND revoked_at IS NULL
      RETURNING id
    `
    if (!invite) return reply.code(404).send({ error: 'Invite not found, already used, or already revoked' })

    await logActivity(sql, {
      userId: req.user.id, action: 'shop_invite_revoked', entity: 'shop_invite',
      entityId: invite.id, meta: { shop_id: req.params.id }, ip: req.ip,
    })

    return reply.code(204).send()
  })
}
