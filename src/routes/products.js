import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { cached, cacheInvalidate } from '../utils/cache.js'

export default async function productRoutes(fastify) {
  // GET /api/products
  // The unfiltered, active-only product list is the single most-hit read in
  // the app (billing screen re-fetches it constantly), so it's cached for a
  // short TTL and invalidated immediately on any product write.
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { category, search, active = 'true' } = req.query
    const cacheKey = `products:list:${active}:${category ?? ''}:${search ?? ''}`

    return cached(cacheKey, 15_000, () => sql`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.active = ${active === 'true'}
        AND (${category ?? null}::text IS NULL OR c.slug = ${category ?? null})
        AND (${search ?? null}::text IS NULL
             OR p.name ILIKE ${'%' + (search ?? '') + '%'}
             OR p.sku  ILIKE ${'%' + (search ?? '') + '%'})
      ORDER BY p.id
    `)
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
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['name', 'pack', 'price'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          pack: { type: 'string', minLength: 1, maxLength: 100 },
          sku: { type: ['string', 'null'] },
          barcode: { type: ['string', 'null'] },
          category_id: { type: ['integer', 'null'] },
          price: { type: 'number', minimum: 0 },
          stock: { type: 'integer', minimum: 0 },
          emoji: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { name, pack, sku, barcode, category_id, price, stock, emoji } = req.body

    // Check across active AND inactive (soft-deleted) rows — otherwise
    // soft-deleting a product and recreating one with the same name leaves
    // two rows sharing a name, which breaks anything joining by name instead
    // of product_id.
    const [dup] = await sql`SELECT id, active FROM products WHERE LOWER(name) = LOWER(${name})`
    if (dup) {
      const msg = dup.active
        ? `A product named "${name}" already exists`
        : `A product named "${name}" already exists (currently inactive/deleted) — reactivate it instead of creating a new one`
      return reply.code(409).send({ error: msg })
    }

    const [product] = await sql`
      INSERT INTO products (name, pack, sku, barcode, category_id, price, stock, emoji)
      VALUES (${name}, ${pack}, ${sku ?? null}, ${barcode ?? null}, ${category_id ?? null}, ${price}, ${stock ?? 0}, ${emoji ?? '🥚'})
      RETURNING *
    `

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_created', entity: 'product',
      entityId: product.id, meta: { name: product.name }, ip: req.ip,
    })

    return reply.code(201).send(product)
  })

  // PUT /api/products/:id
  fastify.put('/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 200 },
          pack: { type: 'string', minLength: 1, maxLength: 100 },
          sku: { type: ['string', 'null'] },
          barcode: { type: ['string', 'null'] },
          category_id: { type: ['integer', 'null'] },
          price: { type: 'number', minimum: 0 },
          stock: { type: 'integer', minimum: 0 },
          emoji: { type: ['string', 'null'] },
          active: { type: 'boolean' },
        },
      },
    },
  }, async (req, reply) => {
    const { name, pack, sku, barcode, category_id, price, stock, emoji, active } = req.body

    if (name) {
      // Same active+inactive check as create — see comment above.
      const [dup] = await sql`
        SELECT id, active FROM products WHERE LOWER(name) = LOWER(${name}) AND id != ${req.params.id}
      `
      if (dup) {
        const msg = dup.active
          ? `A product named "${name}" already exists`
          : `A product named "${name}" already exists (currently inactive/deleted) — reactivate it instead of renaming to it`
        return reply.code(409).send({ error: msg })
      }
    }

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

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_updated', entity: 'product',
      entityId: product.id, meta: { name: product.name }, ip: req.ip,
    })

    return product
  })

  // DELETE /api/products/:id  (soft delete)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [product] = await sql`UPDATE products SET active = FALSE WHERE id = ${req.params.id} RETURNING id, name`
    if (!product) return reply.code(404).send({ error: 'Product not found' })

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_deleted', entity: 'product',
      entityId: product.id, meta: { name: product.name }, ip: req.ip,
    })

    return reply.code(204).send()
  })

  // GET /api/products/categories/list
  fastify.get('/categories/list', { preHandler: authenticate }, async () => {
    return cached('categories:list', 60_000, () => sql`SELECT * FROM categories ORDER BY name`)
  })
}
