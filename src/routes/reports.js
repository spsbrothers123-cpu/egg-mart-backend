import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'

export default async function reportRoutes(fastify) {
  // GET /api/reports/summary?date=YYYY-MM-DD
  fastify.get('/summary', { preHandler: requireRole('admin') }, async (req) => {
    const date = req.query.date ?? new Date().toISOString().slice(0, 10)

    const [daily] = await sql`
      SELECT
        COUNT(*)::int                            AS bills,
        COALESCE(SUM(total), 0)                  AS revenue,
        COALESCE(SUM(discount_amt), 0)           AS discounts,
        COALESCE(SUM(tax_amt), 0)                AS tax,
        COALESCE(AVG(total), 0)                  AS avg_bill,
        COALESCE(SUM(
          (SELECT SUM(qty) FROM bill_items bi WHERE bi.bill_id = b.id)
        ), 0)::int                               AS items_sold
      FROM bills b
      WHERE b.created_at::date = ${date}::date
        AND b.payment_status != 'voided'
    `

    const [expenses] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses WHERE expense_date = ${date}::date
    `

    const topProducts = await sql`
      SELECT bi.name, bi.pack, SUM(bi.qty)::int AS qty_sold, SUM(bi.total) AS revenue
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.created_at::date = ${date}::date AND b.payment_status != 'voided'
      GROUP BY bi.name, bi.pack
      ORDER BY qty_sold DESC
      LIMIT 5
    `

    return {
      date,
      revenue:      parseFloat(daily.revenue),
      bills:        daily.bills,
      items_sold:   daily.items_sold,
      avg_bill:     parseFloat(daily.avg_bill),
      discounts:    parseFloat(daily.discounts),
      tax:          parseFloat(daily.tax),
      expenses:     parseFloat(expenses.total),
      profit:       parseFloat(daily.revenue) - parseFloat(expenses.total),
      top_products: topProducts,
    }
  })

  // GET /api/reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day|month
  fastify.get('/range', { preHandler: requireRole('admin') }, async (req) => {
    const {
      from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      to   = new Date().toISOString().slice(0, 10),
      group_by = 'day',
    } = req.query

    const format = group_by === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'

    const rows = await sql`
      SELECT
        TO_CHAR(created_at, ${format})    AS period,
        COUNT(*)::int                     AS bills,
        SUM(total)                        AS revenue,
        SUM(discount_amt)                 AS discounts
      FROM bills
      WHERE created_at::date BETWEEN ${from}::date AND ${to}::date
        AND payment_status != 'voided'
      GROUP BY period
      ORDER BY period
    `
    return rows
  })

  // GET /api/reports/products?from=&to=
  fastify.get('/products', { preHandler: requireRole('admin') }, async (req) => {
    const {
      from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      to   = new Date().toISOString().slice(0, 10),
    } = req.query

    return sql`
      SELECT
        bi.product_id,
        bi.name,
        bi.pack,
        SUM(bi.qty)::int   AS qty_sold,
        SUM(bi.total)      AS revenue
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.created_at::date BETWEEN ${from}::date AND ${to}::date
        AND b.payment_status != 'voided'
      GROUP BY bi.product_id, bi.name, bi.pack
      ORDER BY qty_sold DESC
    `
  })

  // GET /api/reports/expenses?from=&to=
  fastify.get('/expenses', { preHandler: requireRole('admin') }, async (req) => {
    const { from, to } = req.query
    const [totals] = await sql`
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::int            AS count
      FROM expenses
      WHERE (${from ?? null}::date IS NULL OR expense_date >= ${from ?? null}::date)
        AND (${to   ?? null}::date IS NULL OR expense_date <= ${to   ?? null}::date)
    `

    const byCategory = await sql`
      SELECT category, SUM(amount) AS total, COUNT(*)::int AS count
      FROM expenses
      WHERE (${from ?? null}::date IS NULL OR expense_date >= ${from ?? null}::date)
        AND (${to   ?? null}::date IS NULL OR expense_date <= ${to   ?? null}::date)
      GROUP BY category ORDER BY total DESC
    `

    return { ...totals, by_category: byCategory }
  })
}
