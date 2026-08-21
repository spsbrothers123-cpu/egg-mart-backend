import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { assertShopOwnedByAdmin } from '../utils/shop-scope.js'

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
}
