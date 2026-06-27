import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function purchaseRoutes(fastify) {
  // GET /api/purchases  — paginated list, newest first
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { limit = 50, offset = 0, supplier, status } = req.query

    const purchases = await sql`
      SELECT p.*, u.name AS created_by_name,
             COUNT(pi.id)::int AS item_count
      FROM purchases p
      LEFT JOIN users u ON u.id = p.created_by
      LEFT JOIN purchase_items pi ON pi.purchase_id = p.id
      WHERE (${supplier ?? null}::text IS NULL OR p.supplier ILIKE ${'%' + (supplier ?? '') + '%'})
        AND (${status ?? null}::text IS NULL OR p.status = ${status ?? null})
      GROUP BY p.id, u.name
      ORDER BY p.created_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `
    return purchases
  })

  // GET /api/purchases/:id  (with line items)
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const [purchase] = await sql`
      SELECT p.*, u.name AS created_by_name
      FROM purchases p
      LEFT JOIN users u ON u.id = p.created_by
      WHERE p.id = ${req.params.id}
    `
    if (!purchase) return reply.code(404).send({ error: 'Purchase not found' })

    const items = await sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchase.id}`
    return { ...purchase, items }
  })

  // POST /api/purchases  — create a new purchase and add stock
  fastify.post('/', { preHandler: authenticate }, async (req, reply) => {
    const {
      invoice_no,
      supplier,
      purchase_date,
      items,            // [{ product_id, name, pack, unit_price, qty }]
      notes,
    } = req.body

    if (!items || !Array.isArray(items) || items.length === 0) {
      return reply.code(400).send({ error: 'Purchase must have at least one item' })
    }

    for (const item of items) {
      if (!item.name || item.unit_price == null || item.qty == null) {
        return reply.code(400).send({ error: 'Each item needs name, unit_price, and qty' })
      }
    }

    const subtotal = items.reduce((s, i) => s + Number(i.unit_price) * Number(i.qty), 0)

    const [purchase] = await sql.begin(async tx => {
      const [p] = await tx`
        INSERT INTO purchases (invoice_no, supplier, purchase_date, subtotal, notes, created_by)
        VALUES (
          ${invoice_no ?? null}, ${supplier ?? null},
          ${purchase_date ?? new Date().toISOString().slice(0, 10)},
          ${subtotal}, ${notes ?? null}, ${req.user.id}
        )
        RETURNING *
      `

      for (const item of items) {
        const lineTotal = Number(item.unit_price) * Number(item.qty)

        await tx`
          INSERT INTO purchase_items (purchase_id, product_id, name, pack, unit_price, qty, total)
          VALUES (${p.id}, ${item.product_id ?? null}, ${item.name}, ${item.pack ?? null},
                  ${item.unit_price}, ${item.qty}, ${lineTotal})
        `

        // A received purchase adds stock back into inventory
        if (item.product_id) {
          await tx`
            UPDATE products SET stock = stock + ${item.qty}, updated_at = NOW()
            WHERE id = ${item.product_id}
          `
          await tx`
            INSERT INTO stock_movements (product_id, type, qty, note, ref_id, created_by)
            VALUES (${item.product_id}, 'in', ${item.qty},
                    ${`Purchase ${invoice_no || '#' + p.id}`}, ${p.id}, ${req.user.id})
          `
        }
      }

      return [p]
    })

    const items_saved = await sql`SELECT * FROM purchase_items WHERE purchase_id = ${purchase.id}`
    return reply.code(201).send({ ...purchase, items: items_saved })
  })

  // PATCH /api/purchases/:id  — update status / notes (admin only)
  fastify.patch('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { status, notes, supplier, invoice_no, purchase_date } = req.body

    const [purchase] = await sql`
      UPDATE purchases SET
        status        = COALESCE(${status        ?? null}, status),
        notes         = COALESCE(${notes         ?? null}, notes),
        supplier      = COALESCE(${supplier      ?? null}, supplier),
        invoice_no    = COALESCE(${invoice_no    ?? null}, invoice_no),
        purchase_date = COALESCE(${purchase_date ?? null}, purchase_date),
        updated_at    = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!purchase) return reply.code(404).send({ error: 'Purchase not found' })
    return purchase
  })

  // DELETE /api/purchases/:id  (admin only)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [purchase] = await sql`DELETE FROM purchases WHERE id = ${req.params.id} RETURNING id`
    if (!purchase) return reply.code(404).send({ error: 'Purchase not found' })
    return reply.code(204).send()
  })
}
