import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { cacheInvalidate } from '../utils/cache.js'

export default async function inventoryRoutes(fastify) {
  // GET /api/inventory  — current stock levels
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { search, limit = 100, offset = 0 } = req.query
    const safeLimit = Math.min(500, Math.max(1, parseInt(limit) || 100))
    const safeOffset = Math.max(0, parseInt(offset) || 0)

    return sql`
      SELECT p.id, p.name, p.pack, p.sku, p.stock, p.emoji,
             c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = TRUE
        AND (${search ?? null}::text IS NULL OR p.name ILIKE ${'%' + (search ?? '') + '%'})
      ORDER BY p.stock ASC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `
  })

  // GET /api/inventory/low-stock
  fastify.get('/low-stock', { preHandler: authenticate }, async (req) => {
    const threshold = Math.max(0, parseInt(req.query.threshold) || 50)
    return sql`
      SELECT p.id, p.name, p.pack, p.stock, p.emoji, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = TRUE AND p.stock < ${threshold}
      ORDER BY p.stock ASC
    `
  })

  // POST /api/inventory/adjust  — stock in / out / adjustment
  fastify.post('/adjust', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['product_id', 'type', 'qty'],
        properties: {
          product_id: { type: 'integer' },
          type: { type: 'string', enum: ['in', 'out', 'adjustment'] },
          qty: { type: 'number' },
          note: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { product_id, type, qty, note } = req.body
    const delta = type === 'out' ? -Math.abs(qty) : Math.abs(qty)

    const product = await sql.begin(async tx => {
      // Row-locked, atomic check-and-update: prevents stock from ever going
      // negative even if two adjustments for the same product race.
      const [updated] = await tx`
        UPDATE products SET stock = stock + ${delta}, updated_at = NOW()
        WHERE id = ${product_id} AND stock + ${delta} >= 0
        RETURNING id, name, stock
      `
      if (!updated) {
        const [existing] = await tx`SELECT name, stock FROM products WHERE id = ${product_id}`
        if (!existing) throw fastify.httpErrors.notFound('Product not found')
        throw fastify.httpErrors.badRequest(
          `Adjustment would make stock negative for "${existing.name}" (currently ${existing.stock})`
        )
      }

      await tx`
        INSERT INTO stock_movements (product_id, type, qty, note, created_by)
        VALUES (${product_id}, ${type}, ${delta}, ${note ?? null}, ${req.user.id})
      `
      return updated
    })

    cacheInvalidate('products:')
    cacheInvalidate('dashboard:')

    await logActivity(sql, {
      userId: req.user.id,
      action: 'inventory_adjusted',
      entity: 'product',
      entityId: product_id,
      meta: { type, delta, note },
      ip: req.ip,
    })

    return reply.code(201).send(product)
  })

  // GET /api/inventory/:product_id/history
  fastify.get('/:product_id/history', { preHandler: requireRole('admin') }, async (req) => {
    const { limit = 50, offset = 0 } = req.query
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit) || 50))
    const safeOffset = Math.max(0, parseInt(offset) || 0)

    return sql`
      SELECT sm.*, u.name AS created_by_name
      FROM stock_movements sm
      LEFT JOIN users u ON u.id = sm.created_by
      WHERE sm.product_id = ${req.params.product_id}
      ORDER BY sm.created_at DESC
      LIMIT ${safeLimit} OFFSET ${safeOffset}
    `
  })
}
