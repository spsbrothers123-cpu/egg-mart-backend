import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'
import { cacheInvalidate } from '../utils/cache.js'

// Generates an atomic, gap-free invoice number in the form YYYYMMDD-00001.
// MUST be called with `tx` (the transaction client for the bill being
// created) so the counter increment and the bill insert commit or roll back
// together, and so concurrent checkouts serialize on the counter row lock
// instead of racing on a plain COUNT(*) read.
async function generateInvoiceNumber(tx) {
  const now = new Date()
  const isoDate = now.toISOString().slice(0, 10)
  const compact = isoDate.replaceAll('-', '')

  const [row] = await tx`
    INSERT INTO daily_invoice_counters (invoice_date, counter)
    VALUES (${isoDate}, 1)
    ON CONFLICT (invoice_date)
    DO UPDATE SET counter = daily_invoice_counters.counter + 1
    RETURNING counter
  `
  return `${compact}-${String(row.counter).padStart(5, '0')}`
}

export default async function billRoutes(fastify) {
  // GET /api/bills — paginated, filterable.
  // Returns a bare array (unchanged response shape, for frontend
  // backward-compatibility) with the total row count exposed via the
  // X-Total-Count header for callers that want to paginate.
  fastify.get('/', { preHandler: authenticate }, async (req, reply) => {
    const { date, customer_id, status, limit = 50, offset = 0 } = req.query
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit) || 50))
    const safeOffset = Math.max(0, parseInt(offset) || 0)

    const [rows, [{ total }]] = await Promise.all([
      sql`
        SELECT b.*, c.name AS customer_name, u.name AS cashier_name,
               COUNT(bi.id)::int AS item_count
        FROM bills b
        LEFT JOIN customers c  ON c.id  = b.customer_id
        LEFT JOIN users     u  ON u.id  = b.cashier_id
        LEFT JOIN bill_items bi ON bi.bill_id = b.id
        WHERE (${date ?? null}::date IS NULL OR b.created_at::date = ${date ?? null}::date)
          AND (${customer_id ?? null}::int IS NULL OR b.customer_id = ${customer_id ?? null}::int)
          AND (${status ?? null}::text IS NULL OR b.payment_status = ${status ?? null})
        GROUP BY b.id, c.name, u.name
        ORDER BY b.created_at DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `,
      sql`
        SELECT COUNT(*)::int AS total
        FROM bills b
        WHERE (${date ?? null}::date IS NULL OR b.created_at::date = ${date ?? null}::date)
          AND (${customer_id ?? null}::int IS NULL OR b.customer_id = ${customer_id ?? null}::int)
          AND (${status ?? null}::text IS NULL OR b.payment_status = ${status ?? null})
      `,
    ])

    reply.header('X-Total-Count', total)
    return rows
  })

  // GET /api/bills/:id  (with items)
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const [bill] = await sql`
      SELECT b.*, c.name AS customer_name, c.phone AS customer_phone, u.name AS cashier_name
      FROM bills b
      LEFT JOIN customers c ON c.id = b.customer_id
      LEFT JOIN users     u ON u.id = b.cashier_id
      WHERE b.id = ${req.params.id}
    `
    if (!bill) return reply.code(404).send({ error: 'Bill not found' })

    const items = await sql`SELECT * FROM bill_items WHERE bill_id = ${bill.id}`
    return { ...bill, items }
  })

  // POST /api/bills — create a new bill
  fastify.post('/', {
    preHandler: authenticate,
    schema: {
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          customer_id: { type: ['integer', 'null'] },
          items: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['name', 'price', 'qty'],
              properties: {
                product_id: { type: ['integer', 'null'] },
                name: { type: 'string', minLength: 1 },
                pack: { type: ['string', 'null'] },
                price: { type: 'number', minimum: 0 },
                qty: { type: 'number', exclusiveMinimum: 0 },
              },
            },
          },
          discount_pct: { type: 'number', minimum: 0, maximum: 100 },
          tax_pct: { type: 'number', minimum: 0, maximum: 100 },
          payment_method: { type: 'string', enum: ['cash', 'card', 'upi', 'net_banking', 'split', 'credit'] },
          notes: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const {
      customer_id,
      items,
      discount_pct = 0,
      tax_pct      = 0,
      payment_method = 'cash',
      notes,
    } = req.body

    const subtotal     = items.reduce((s, i) => s + i.price * i.qty, 0)
    const discount_amt = Math.round(subtotal * discount_pct / 100 * 100) / 100
    const tax_amt      = Math.round((subtotal - discount_amt) * tax_pct / 100 * 100) / 100
    const total        = subtotal - discount_amt + tax_amt

    let bill
    try {
      bill = await sql.begin(async tx => {
        const invoice_number = await generateInvoiceNumber(tx)

        const [b] = await tx`
          INSERT INTO bills
            (invoice_number, customer_id, cashier_id, subtotal, discount_pct, discount_amt,
             tax_pct, tax_amt, total, payment_method, notes)
          VALUES
            (${invoice_number}, ${customer_id ?? null}, ${req.user.id},
             ${subtotal}, ${discount_pct}, ${discount_amt},
             ${tax_pct}, ${tax_amt}, ${total}, ${payment_method}, ${notes ?? null})
          RETURNING *
        `

        for (const item of items) {
          await tx`
            INSERT INTO bill_items (bill_id, product_id, name, pack, price, qty, total)
            VALUES (${b.id}, ${item.product_id ?? null}, ${item.name}, ${item.pack ?? null},
                    ${item.price}, ${item.qty}, ${item.price * item.qty})
          `

          if (item.product_id) {
            // Atomic stock check-and-deduct: the WHERE clause guarantees we
            // never go negative even under concurrent checkouts, because the
            // row lock serializes competing UPDATEs on the same product.
            const [updated] = await tx`
              UPDATE products SET stock = stock - ${item.qty}, updated_at = NOW()
              WHERE id = ${item.product_id} AND stock >= ${item.qty}
              RETURNING id, name, stock
            `
            if (!updated) {
              const [product] = await tx`SELECT name, stock FROM products WHERE id = ${item.product_id}`
              const available = product?.stock ?? 0
              const label = product?.name ?? item.name
              throw fastify.httpErrors.badRequest(
                `Insufficient stock for "${label}": ${available} available, ${item.qty} requested`
              )
            }

            await tx`
              INSERT INTO stock_movements (product_id, type, qty, note, ref_id, created_by)
              VALUES (${item.product_id}, 'sale', ${-item.qty}, ${`Bill ${invoice_number}`}, ${b.id}, ${req.user.id})
            `
          }
        }

        if (payment_method === 'credit' && customer_id) {
          await tx`
            UPDATE customers SET credit_used = credit_used + ${total} WHERE id = ${customer_id}
          `
        }

        return b
      })
    } catch (err) {
      if (err.statusCode) throw err // validation error thrown above, already safe to surface
      throw err
    }

    cacheInvalidate('products:')
    cacheInvalidate('dashboard:')

    await logActivity(sql, {
      userId: req.user.id,
      action: 'bill_created',
      entity: 'bill',
      entityId: bill.id,
      meta: { invoice_number: bill.invoice_number, total: bill.total, payment_method },
      ip: req.ip,
    })

    return reply.code(201).send(bill)
  })

  // PATCH /api/bills/:id/void
  fastify.patch('/:id/void', { preHandler: requireRole('admin') }, async (req, reply) => {
    const bill = await sql.begin(async tx => {
      const [existing] = await tx`SELECT * FROM bills WHERE id = ${req.params.id}`
      if (!existing) return null
      if (existing.payment_status === 'voided') return existing // idempotent

      const [voided] = await tx`
        UPDATE bills SET payment_status = 'voided' WHERE id = ${req.params.id} RETURNING *
      `

      // Restore stock for any items that were deducted at sale time, so
      // inventory stays accurate after a void (previously stock was never
      // returned, silently corrupting stock counts for every voided bill).
      const items = await tx`SELECT * FROM bill_items WHERE bill_id = ${voided.id} AND product_id IS NOT NULL`
      for (const item of items) {
        await tx`UPDATE products SET stock = stock + ${item.qty}, updated_at = NOW() WHERE id = ${item.product_id}`
        await tx`
          INSERT INTO stock_movements (product_id, type, qty, note, ref_id, created_by)
          VALUES (${item.product_id}, 'return', ${item.qty}, ${`Void of bill ${voided.invoice_number}`}, ${voided.id}, ${req.user.id})
        `
      }

      if (voided.payment_method === 'credit' && voided.customer_id) {
        await tx`UPDATE customers SET credit_used = credit_used - ${voided.total} WHERE id = ${voided.customer_id}`
      }

      return voided
    })

    if (!bill) return reply.code(404).send({ error: 'Bill not found' })

    cacheInvalidate('products:')
    cacheInvalidate('dashboard:')

    await logActivity(sql, {
      userId: req.user.id,
      action: 'bill_voided',
      entity: 'bill',
      entityId: bill.id,
      meta: { invoice_number: bill.invoice_number },
      ip: req.ip,
    })

    return bill
  })
}
