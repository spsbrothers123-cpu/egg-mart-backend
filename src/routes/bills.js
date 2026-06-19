import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

async function generateInvoiceNumber() {
  const [row] = await sql`SELECT COUNT(*) AS cnt FROM bills`
  const num = parseInt(row.cnt) + 1
  return `INV-${String(num).padStart(6, '0')}`
}

export default async function billRoutes(fastify) {
  // GET /api/bills
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { date, customer_id, status, limit = 50, offset = 0 } = req.query

    return sql`
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
      LIMIT ${limit} OFFSET ${offset}
    `
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

  // POST /api/bills  — create a new bill
  fastify.post('/', { preHandler: authenticate }, async (req, reply) => {
    const {
      customer_id,
      items,           // [{ product_id, name, pack, price, qty }]
      discount_pct = 0,
      tax_pct      = 0,
      payment_method = 'cash',
      notes,
    } = req.body

    if (!items || items.length === 0) {
      return reply.code(400).send({ error: 'Bill must have at least one item' })
    }

    const subtotal     = items.reduce((s, i) => s + i.price * i.qty, 0)
    const discount_amt = Math.round(subtotal * discount_pct / 100 * 100) / 100
    const tax_amt      = Math.round((subtotal - discount_amt) * tax_pct / 100 * 100) / 100
    const total        = subtotal - discount_amt + tax_amt
    const invoice_number = await generateInvoiceNumber()

    // Use a transaction
    const [bill] = await sql.begin(async tx => {
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
        // Deduct stock
        if (item.product_id) {
          await tx`
            UPDATE products SET stock = stock - ${item.qty}, updated_at = NOW()
            WHERE id = ${item.product_id}
          `
          await tx`
            INSERT INTO stock_movements (product_id, type, qty, note, ref_id, created_by)
            VALUES (${item.product_id}, 'sale', ${-item.qty}, ${`Bill ${invoice_number}`}, ${b.id}, ${req.user.id})
          `
        }
      }

      // If credit payment, increase customer credit_used
      if (payment_method === 'credit' && customer_id) {
        await tx`
          UPDATE customers SET credit_used = credit_used + ${total} WHERE id = ${customer_id}
        `
      }

      return [b]
    })

    return reply.code(201).send({ ...bill, invoice_number })
  })

  // PATCH /api/bills/:id/void
  fastify.patch('/:id/void', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [bill] = await sql`
      UPDATE bills SET payment_status = 'voided' WHERE id = ${req.params.id} RETURNING *
    `
    if (!bill) return reply.code(404).send({ error: 'Bill not found' })
    return bill
  })
}
