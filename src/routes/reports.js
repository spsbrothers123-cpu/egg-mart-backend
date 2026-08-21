import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { getOwnedShopIds } from '../utils/shop-scope.js'

export default async function reportRoutes(fastify) {
  // GET /api/reports/summary?date=YYYY-MM-DD&shop_id=
  fastify.get('/summary', { preHandler: requireRole('admin') }, async (req, reply) => {
    const date = req.query.date ?? new Date().toISOString().slice(0, 10)
    const shopIds = await resolveReportShopIds(req, reply)
    if (!shopIds) return
    if (shopIds.length === 0) {
      return { date, revenue: 0, bills: 0, items_sold: 0, avg_bill: 0, discounts: 0, tax: 0, expenses: 0, profit: 0, top_products: [] }
    }

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
      WHERE b.shop_id = ANY(${shopIds})
        AND b.created_at::date = ${date}::date
        AND b.payment_status != 'voided'
    `

    const [expenses] = await sql`
      SELECT COALESCE(SUM(amount), 0) AS total
      FROM expenses WHERE shop_id = ANY(${shopIds}) AND expense_date = ${date}::date
    `

    const topProducts = await sql`
      SELECT bi.name, bi.pack, SUM(bi.qty)::int AS qty_sold, SUM(bi.total) AS revenue
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.shop_id = ANY(${shopIds}) AND b.created_at::date = ${date}::date AND b.payment_status != 'voided'
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

  // GET /api/reports/range?from=YYYY-MM-DD&to=YYYY-MM-DD&group_by=day|month&shop_id=
  fastify.get('/range', { preHandler: requireRole('admin') }, async (req, reply) => {
    const {
      from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      to   = new Date().toISOString().slice(0, 10),
      group_by = 'day',
    } = req.query
    const shopIds = await resolveReportShopIds(req, reply)
    if (!shopIds) return
    if (shopIds.length === 0) return []

    const format = group_by === 'month' ? 'YYYY-MM' : 'YYYY-MM-DD'

    return sql`
      SELECT
        TO_CHAR(created_at, ${format})    AS period,
        COUNT(*)::int                     AS bills,
        SUM(total)                        AS revenue,
        SUM(discount_amt)                 AS discounts
      FROM bills
      WHERE shop_id = ANY(${shopIds})
        AND created_at::date BETWEEN ${from}::date AND ${to}::date
        AND payment_status != 'voided'
      GROUP BY period
      ORDER BY period
    `
  })

  // GET /api/reports/products?from=&to=&shop_id=
  fastify.get('/products', { preHandler: requireRole('admin') }, async (req, reply) => {
    const {
      from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      to   = new Date().toISOString().slice(0, 10),
    } = req.query
    const shopIds = await resolveReportShopIds(req, reply)
    if (!shopIds) return
    if (shopIds.length === 0) return []

    return sql`
      SELECT
        bi.product_id,
        bi.name,
        bi.pack,
        SUM(bi.qty)::int   AS qty_sold,
        SUM(bi.total)      AS revenue
      FROM bill_items bi
      JOIN bills b ON b.id = bi.bill_id
      WHERE b.shop_id = ANY(${shopIds})
        AND b.created_at::date BETWEEN ${from}::date AND ${to}::date
        AND b.payment_status != 'voided'
      GROUP BY bi.product_id, bi.name, bi.pack
      ORDER BY qty_sold DESC
    `
  })

  // GET /api/reports/expenses?from=&to=&shop_id=
  fastify.get('/expenses', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { from, to } = req.query
    const shopIds = await resolveReportShopIds(req, reply)
    if (!shopIds) return
    if (shopIds.length === 0) return { total: 0, count: 0, by_category: [] }

    const [totals] = await sql`
      SELECT
        COALESCE(SUM(amount), 0) AS total,
        COUNT(*)::int            AS count
      FROM expenses
      WHERE shop_id = ANY(${shopIds})
        AND (${from ?? null}::date IS NULL OR expense_date >= ${from ?? null}::date)
        AND (${to   ?? null}::date IS NULL OR expense_date <= ${to   ?? null}::date)
    `

    const byCategory = await sql`
      SELECT category, SUM(amount) AS total, COUNT(*)::int AS count
      FROM expenses
      WHERE shop_id = ANY(${shopIds})
        AND (${from ?? null}::date IS NULL OR expense_date >= ${from ?? null}::date)
        AND (${to   ?? null}::date IS NULL OR expense_date <= ${to   ?? null}::date)
      GROUP BY category ORDER BY total DESC
    `

    return { ...totals, by_category: byCategory }
  })

  // GET /api/reports/payment-methods?from=&to=&shop_id=
  // Breaks split-payment bills down into their real component methods
  // (Cash/Card/UPI) instead of collapsing them into an opaque "Split"
  // bucket — a ₹80 bill paid as ₹60 card + ₹20 cash contributes ₹60 to
  // Card and ₹20 to Cash here, matching how the money actually moved.
  fastify.get('/payment-methods', { preHandler: requireRole('admin') }, async (req, reply) => {
    const {
      from = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString().slice(0, 10),
      to   = new Date().toISOString().slice(0, 10),
    } = req.query
    const shopIds = await resolveReportShopIds(req, reply)
    if (!shopIds) return
    if (shopIds.length === 0) return { from, to, by_method: [], total: 0 }

    const rows = await sql`
      SELECT method, SUM(amount)::numeric AS total, COUNT(*)::int AS count
      FROM (
        -- Non-split bills contribute their single payment_method directly.
        SELECT b.payment_method AS method, b.total AS amount
        FROM bills b
        WHERE b.shop_id = ANY(${shopIds})
          AND b.created_at::date BETWEEN ${from}::date AND ${to}::date
          AND b.payment_status != 'voided'
          AND b.payment_method != 'split'

        UNION ALL

        -- Split bills contribute each of their individual portions.
        SELECT bp.method, bp.amount
        FROM bill_payments bp
        JOIN bills b ON b.id = bp.bill_id
        WHERE b.shop_id = ANY(${shopIds})
          AND b.created_at::date BETWEEN ${from}::date AND ${to}::date
          AND b.payment_status != 'voided'
      ) combined
      GROUP BY method
      ORDER BY total DESC
    `

    const total = rows.reduce((s, r) => s + Number(r.total), 0)
    return { from, to, by_method: rows.map(r => ({ ...r, total: Number(r.total) })), total }
  })
}

// Shared helper: resolves the admin's shop scope for a report request,
// optionally narrowed by ?shop_id=. Writes the 403 response itself and
// returns null when the requested shop isn't owned by this admin, so
// callers can just `if (!shopIds) return`.
async function resolveReportShopIds(req, reply) {
  let shopIds = await getOwnedShopIds(sql, req.user.id)
  if (req.query.shop_id) {
    const requested = parseInt(req.query.shop_id)
    if (!shopIds.includes(requested)) {
      reply.code(403).send({ error: 'That shop does not belong to your account' })
      return null
    }
    shopIds = [requested]
  }
  return shopIds
}
