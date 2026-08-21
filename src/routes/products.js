import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { cached, cacheInvalidate } from '../utils/cache.js'
import { resolveShopScope, assertShopOwnedByAdmin, resolveAdminShopId } from '../utils/shop-scope.js'

export default async function productRoutes(fastify) {
  // GET /api/products
  // The unfiltered, active-only product list is the single most-hit read in
  // the app (billing screen re-fetches it constantly), so it's cached for a
  // short TTL and invalidated immediately on any product write. The cache
  // key includes the requester's shop scope — otherwise a cashier in Shop A
  // could be served Shop B's cached product list.
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { category, search, active = 'true' } = req.query
    const { shopIds } = await resolveShopScope(sql, req)
    if (shopIds.length === 0) return []

    const cacheKey = `products:list:${shopIds.join(',')}:${active}:${category ?? ''}:${search ?? ''}`

    return cached(cacheKey, 15_000, () => sql`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.shop_id = ANY(${shopIds})
        AND p.active = ${active === 'true'}
        AND (${category ?? null}::text IS NULL OR c.slug = ${category ?? null})
        AND (${search ?? null}::text IS NULL
             OR p.name ILIKE ${'%' + (search ?? '') + '%'}
             OR p.sku  ILIKE ${'%' + (search ?? '') + '%'})
      ORDER BY p.id
    `)
  })

  // GET /api/products/:id
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { shopIds } = await resolveShopScope(sql, req)
    const [product] = await sql`
      SELECT p.*, c.name AS category_name, c.slug AS category_slug
      FROM products p
      LEFT JOIN categories c ON c.id = p.category_id
      WHERE p.id = ${req.params.id} AND p.shop_id = ANY(${shopIds})
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
          shop_id: { type: ['integer', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { name, pack, sku, barcode, category_id, price, stock, emoji } = req.body
    // The frontend doesn't have a shop-picker yet, so shop_id is optional
    // here: it defaults to the admin's sole shop when they only have one,
    // and only demands an explicit shop_id once they own more than one.
    const shop_id = await resolveAdminShopId(fastify, sql, req.user.id, req.body.shop_id)

    // Check across active AND inactive (soft-deleted) rows, scoped to this
    // shop only — the same product name is fine in two different shops.
    const [dup] = await sql`SELECT id, active FROM products WHERE LOWER(name) = LOWER(${name}) AND shop_id = ${shop_id}`
    if (dup) {
      const msg = dup.active
        ? `A product named "${name}" already exists in this shop`
        : `A product named "${name}" already exists in this shop (currently inactive/deleted) — reactivate it instead of creating a new one`
      return reply.code(409).send({ error: msg })
    }

    const [product] = await sql`
      INSERT INTO products (name, pack, sku, barcode, category_id, price, stock, emoji, shop_id)
      VALUES (${name}, ${pack}, ${sku ?? null}, ${barcode ?? null}, ${category_id ?? null}, ${price}, ${stock ?? 0}, ${emoji ?? '🥚'}, ${shop_id})
      RETURNING *
    `

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_created', entity: 'product',
      entityId: product.id, meta: { name: product.name, shop_id }, ip: req.ip,
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

    const [existing] = await sql`SELECT shop_id FROM products WHERE id = ${req.params.id}`
    if (!existing) return reply.code(404).send({ error: 'Product not found' })
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, existing.shop_id)

    if (name) {
      // Same active+inactive check as create, scoped to this shop.
      const [dup] = await sql`
        SELECT id, active FROM products WHERE LOWER(name) = LOWER(${name}) AND shop_id = ${existing.shop_id} AND id != ${req.params.id}
      `
      if (dup) {
        const msg = dup.active
          ? `A product named "${name}" already exists in this shop`
          : `A product named "${name}" already exists in this shop (currently inactive/deleted) — reactivate it instead of renaming to it`
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

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_updated', entity: 'product',
      entityId: product.id, meta: { name: product.name }, ip: req.ip,
    })

    return product
  })

  // DELETE /api/products/:id  (soft delete)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [existing] = await sql`SELECT shop_id FROM products WHERE id = ${req.params.id}`
    if (!existing) return reply.code(404).send({ error: 'Product not found' })
    await assertShopOwnedByAdmin(fastify, sql, req.user.id, existing.shop_id)

    const [product] = await sql`UPDATE products SET active = FALSE WHERE id = ${req.params.id} RETURNING id, name`

    cacheInvalidate('products:')

    await logActivity(sql, {
      userId: req.user.id, action: 'product_deleted', entity: 'product',
      entityId: product.id, meta: { name: product.name }, ip: req.ip,
    })

    return reply.code(204).send()
  })

  // GET /api/products/categories/list — categories are a shared, unscoped
  // taxonomy (not per-shop data), so no shop filtering applies here.
  fastify.get('/categories/list', { preHandler: authenticate }, async () => {
    return cached('categories:list', 60_000, () => sql`SELECT * FROM categories ORDER BY name`)
  })
}
