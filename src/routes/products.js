import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function productRoutes(fastify) {
  // GET /api/products
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { category, search, active = 'true' } = req.query

    let products = await sql`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = ${active === 'true'}
        AND (${category ?? null}::text IS NULL OR c.slug = ${category ?? null})
        AND (${search ?? null}::text IS NULL
             OR p.name ILIKE ${'%' + (search ?? '') + '%'}
             OR p.sku  ILIKE ${'%' + (search ?? '') + '%'})
      ORDER BY p.id
    `
    return products
  })

  // GET /api/products/:id
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const [product] = await sql`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ${req.params.id}
    `
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    return product
  })

  // POST /api/products
  fastify.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, pack, sku, barcode, category_id, price, stock, emoji } = req.body

    const [product] = await sql`
      INSERT INTO products (name, pack, sku, barcode, category_id, price, stock, emoji)
      VALUES (${name}, ${pack}, ${sku ?? null}, ${barcode ?? null}, ${category_id ?? null}, ${price}, ${stock ?? 0}, ${emoji ?? '🥚'})
      RETURNING *
    `
    return reply.code(201).send(product)
  })

  // PUT /api/products/:id
  fastify.put('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, pack, sku, barcode, category_id, price, stock, emoji, active } = req.body

    const [product] = await sql`
      UPDATE products SET
        name        = COALESCE(${name        ?? null}, name),
        pack        = COALESCE(${pack        ?? null}, pack),
        sku         = COALESCE(${sku         ?? null}, sku),
        barcode     = COALESCE(${barcode     ?? null}, barcode),
        category_id = COALESCE(${category_id ?? null}, category_id),
        price       = COALESCE(${price       ?? null}, price),
        stock       = COALESCE(${stock       ?? null}::int, stock),
        emoji       = COALESCE(${emoji       ?? null}, emoji),
        active      = COALESCE(${active      ?? null}::boolean, active),
        updated_at  = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!product) return reply.code(404).send({ error: 'Product not found' })
    return product
  })

  // DELETE /api/products/:id  (soft delete)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await sql`UPDATE products SET active = FALSE WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })

  // GET /api/products/categories
  fastify.get('/categories/list', { preHandler: authenticate }, async () => {
    return sql`SELECT * FROM categories ORDER BY name`
  })
}
