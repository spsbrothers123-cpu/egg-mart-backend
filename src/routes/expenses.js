import sql from '../config/db.js'
import { requireRole } from '../middleware/auth.js'
import { logActivity } from '../utils/audit.js'

// Whitelisted expense categories. Previously this field was free-text, so
// "Transport" / "transport" / "Transportation" all showed up as separate
// buckets in /reports/expenses, fragmenting the breakdown over time.
export const EXPENSE_CATEGORIES = [
  'Transport', 'Labour', 'Packaging', 'Utilities', 'Rent', 'Maintenance', 'Miscellaneous',
]

export default async function expenseRoutes(fastify) {
  // GET /api/expenses — paginated, filterable
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const { from, to, category, limit = 50, offset = 0 } = req.query
    const safeLimit = Math.min(200, Math.max(1, parseInt(limit) || 50))
    const safeOffset = Math.max(0, parseInt(offset) || 0)

    const [rows, [{ total }]] = await Promise.all([
      sql`
        SELECT e.*, u.name AS created_by_name
        FROM expenses e
        LEFT JOIN users u ON u.id = e.created_by
        WHERE (${from ?? null}::date IS NULL OR e.expense_date >= ${from ?? null}::date)
          AND (${to   ?? null}::date IS NULL OR e.expense_date <= ${to   ?? null}::date)
          AND (${category ?? null}::text IS NULL OR e.category = ${category ?? null})
        ORDER BY e.expense_date DESC, e.id DESC
        LIMIT ${safeLimit} OFFSET ${safeOffset}
      `,
      sql`
        SELECT COUNT(*)::int AS total FROM expenses e
        WHERE (${from ?? null}::date IS NULL OR e.expense_date >= ${from ?? null}::date)
          AND (${to   ?? null}::date IS NULL OR e.expense_date <= ${to   ?? null}::date)
          AND (${category ?? null}::text IS NULL OR e.category = ${category ?? null})
      `,
    ])

    return { data: rows, total, limit: safeLimit, offset: safeOffset }
  })

  // POST /api/expenses
  fastify.post('/', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        required: ['category', 'amount'],
        properties: {
          category: { type: 'string', enum: EXPENSE_CATEGORIES },
          amount: { type: 'number', exclusiveMinimum: 0 },
          note: { type: ['string', 'null'] },
          expense_date: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { category, amount, note, expense_date } = req.body
    const [expense] = await sql`
      INSERT INTO expenses (category, amount, note, expense_date, created_by)
      VALUES (${category}, ${amount}, ${note ?? null}, ${expense_date ?? null}, ${req.user.id})
      RETURNING *
    `

    await logActivity(sql, {
      userId: req.user.id, action: 'expense_created', entity: 'expense',
      entityId: expense.id, meta: { category, amount }, ip: req.ip,
    })

    return reply.code(201).send(expense)
  })

  // PUT /api/expenses/:id
  fastify.put('/:id', {
    preHandler: requireRole('admin'),
    schema: {
      body: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: EXPENSE_CATEGORIES },
          amount: { type: 'number', exclusiveMinimum: 0 },
          note: { type: ['string', 'null'] },
          expense_date: { type: ['string', 'null'] },
        },
      },
    },
  }, async (req, reply) => {
    const { category, amount, note, expense_date } = req.body
    const [expense] = await sql`
      UPDATE expenses SET
        category     = COALESCE(${category     ?? null}, category),
        amount       = COALESCE(${amount       ?? null}::numeric, amount),
        note         = COALESCE(${note         ?? null}, note),
        expense_date = COALESCE(${expense_date ?? null}::date, expense_date),
        updated_at   = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!expense) return reply.code(404).send({ error: 'Expense not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'expense_updated', entity: 'expense',
      entityId: expense.id, meta: { category: expense.category, amount: expense.amount }, ip: req.ip,
    })

    return expense
  })

  // DELETE /api/expenses/:id
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [expense] = await sql`DELETE FROM expenses WHERE id = ${req.params.id} RETURNING id, category, amount`
    if (!expense) return reply.code(404).send({ error: 'Expense not found' })

    await logActivity(sql, {
      userId: req.user.id, action: 'expense_deleted', entity: 'expense',
      entityId: expense.id, meta: { category: expense.category, amount: expense.amount }, ip: req.ip,
    })

    return reply.code(204).send()
  })
}
