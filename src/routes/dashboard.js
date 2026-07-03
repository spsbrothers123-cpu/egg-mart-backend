import sql from '../config/db.js'
import { authenticate } from '../middleware/auth.js'
import { cached } from '../utils/cache.js'

// Single dashboard endpoint that replaces what used to require 6+ separate
// round trips from the frontend (today's sales, expenses, profit, inventory
// summary, low stock count, sessions, recent bills). All queries run
// concurrently via Promise.all instead of sequentially, and the combined
// result is cached briefly since the dashboard is polled frequently.
export default async function dashboardRoutes(fastify) {
  fastify.get('/summary', { preHandler: authenticate }, async () => {
    return cached('dashboard:summary', 10_000, async () => {
      const [
        [today],
        [expenses],
        [inventory],
        [lowStock],
        recentBills,
        openSessions,
      ] = await Promise.all([
        sql`
          SELECT
            COUNT(*)::int                       AS bill_count,
            COALESCE(SUM(total), 0)::numeric    AS revenue,
            COALESCE(SUM(discount_amt), 0)::numeric AS discounts,
            COALESCE(SUM(tax_amt), 0)::numeric  AS tax
          FROM bills
          WHERE created_at::date = CURRENT_DATE AND payment_status != 'voided'
        `,
        sql`
          SELECT COALESCE(SUM(amount), 0)::numeric AS total
          FROM expenses WHERE expense_date = CURRENT_DATE
        `,
        sql`
          SELECT
            COUNT(*)::int                      AS product_count,
            COALESCE(SUM(stock), 0)::int        AS total_units,
            COALESCE(SUM(stock * price), 0)::numeric AS inventory_value
          FROM products WHERE active = TRUE
        `,
        sql`
          SELECT COUNT(*)::int AS count FROM products WHERE active = TRUE AND stock < 50
        `,
        sql`
          SELECT b.id, b.invoice_number, b.total, b.payment_method, b.payment_status,
                 b.created_at, c.name AS customer_name, u.name AS cashier_name
          FROM bills b
          LEFT JOIN customers c ON c.id = b.customer_id
          LEFT JOIN users u ON u.id = b.cashier_id
          ORDER BY b.created_at DESC
          LIMIT 10
        `,
        sql`
          SELECT s.id, s.cashier_id, u.name AS cashier_name, s.opening_cash, s.opened_at
          FROM sessions s
          LEFT JOIN users u ON u.id = s.cashier_id
          WHERE s.status = 'open'
          ORDER BY s.opened_at DESC
        `,
      ])

      const revenue = parseFloat(today.revenue)
      const expenseTotal = parseFloat(expenses.total)

      return {
        date: new Date().toISOString().slice(0, 10),
        sales: {
          revenue,
          bill_count: today.bill_count,
          discounts: parseFloat(today.discounts),
          tax: parseFloat(today.tax),
        },
        expenses: { total: expenseTotal },
        profit: revenue - expenseTotal,
        inventory: {
          product_count: inventory.product_count,
          total_units: inventory.total_units,
          inventory_value: parseFloat(inventory.inventory_value),
        },
        low_stock_count: lowStock.count,
        open_sessions: openSessions,
        recent_bills: recentBills,
      }
    })
  })
}
