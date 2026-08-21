import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { getOwnedShopIds, assertShopOwnedByAdmin, resolveAdminShopId } from '../utils/shop-scope.js'

export default async function supplierRoutes(fastify) {
  // GET /api/suppliers
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const shopIds = await getOwnedShopIds(sql, req.user.id)
    if (shopIds.length === 0) return []
    return sql`SELECT * FROM suppliers WHERE active = TRUE AND shop_id = ANY(${shopIds}) ORDER BY name`
  })

  // GET /api/suppliers/:id
  fastify.get('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const shopIds = await getOwnedShopIds(sql, req.user.id)
    const [supplier] = await sql`SELECT * FROM suppliers WHERE id = ${req.params.id} AND shop_id = ANY(${shopIds})`
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // POST /api/suppliers
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          contact: { type: ['string', 'null'] },
          phone: { type: ['string', 'null'] },
          email: { type: ['string', 'null'] },
          address: { type: ['string', 'null'] },
          products: { type: ['string', 'null'] },
          shop_id: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { name, contact, phone, email, address, products } = req.body
    const shop_id = await resolveAdminShopId(fastify, sql, req.user.id, req.body.shop_id)

    const [supplier] = await sql`
      INSERT INTO suppliers (name, contact, phone, email, address, products, shop_id)
      VALUES (${name}, ${contact ?? null}, ${phone ?? null}, ${email ?? null},
              ${address ?? null}, ${products ?? null}, ${shop_id})
      RETURNING *
    `
    return reply.code(201).send(supplier)
  })

  // PUT /api/suppliers/:id
  fastify.put('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, contact, phone, email, address, products } = req.body
    const shopIds = await getOwnedShopIds(sql, req.user.id)

    const [supplier] = await sql`
      UPDATE suppliers SET
        name     = COALESCE(${name     ?? null}, name),
        contact  = COALESCE(${contact  ?? null}, contact),
        phone    = COALESCE(${phone    ?? null}, phone),
        email    = COALESCE(${email    ?? null}, email),
        address  = COALESCE(${address  ?? null}, address),
        products = COALESCE(${products ?? null}, products),
        updated_at = NOW()
      WHERE id = ${req.params.id} AND shop_id = ANY(${shopIds})
      RETURNING *
    `
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // DELETE /api/suppliers/:id (soft)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const shopIds = await getOwnedShopIds(sql, req.user.id)
    const [supplier] = await sql`UPDATE suppliers SET active = FALSE WHERE id = ${req.params.id} AND shop_id = ANY(${shopIds}) RETURNING id`
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return reply.code(204).send()
  })
}
