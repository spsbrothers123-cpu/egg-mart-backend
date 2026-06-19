import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function inventoryRoutes(fastify) {
  // GET /api/inventory  — current stock levels
  fastify.get('/', { preHandler: authenticate }, async () => {
    return sql`
      SELECT p.id, p.name, p.pack, p.sku, p.stock, p.emoji,
             c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = TRUE
      ORDER BY p.stock ASC
    `
  })

  // GET /api/inventory/low-stock
  fastify.get('/low-stock', { preHandler: authenticate }, async () => {
    return sql`
      SELECT p.id, p.name, p.pack, p.stock, p.emoji, c.name AS category_name
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = TRUE AND p.stock < 50
      ORDER BY p.stock ASC
    `
  })

  // POST /api/inventory/adjust  — stock in / out / adjustment
  fastify.post('/adjust', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { product_id, type, qty, note } = req.body
    // type: 'in' | 'out' | 'adjustment'

    const delta = type === 'out' ? -Math.abs(qty) : Math.abs(qty)

    await sql.begin(async tx => {
      await tx`
        UPDATE products SET stock = stock + ${delta}, updated_at = NOW()
        WHERE id = ${product_id}
      `
      await tx`
        INSERT INTO stock_movements (product_id, type, qty, note, created_by)
        VALUES (${product_id}, ${type}, ${delta}, ${note ?? null}, ${req.user.id})
      `
    })

    const [product] = await sql`SELECT id, name, stock FROM products WHERE id = ${product_id}`
    return reply.code(201).send(product)
  })

  // GET /api/inventory/:product_id/history
  fastify.get('/:product_id/history', { preHandler: requireRole('admin') }, async (req) => {
    return sql`
      SELECT sm.*, u.name AS created_by_name
      FROM stock_movements sm
      LEFT JOIN users u ON u.id = sm.created_by
      WHERE sm.product_id = ${req.params.product_id}
      ORDER BY sm.created_at DESC
      LIMIT 50
    `
  })
}
