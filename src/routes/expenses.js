import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function expenseRoutes(fastify) {
  // GET /api/expenses
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const { from, to, category } = req.query
    return sql`
      SELECT e.*, u.name AS created_by_name
      FROM expenses e
      LEFT JOIN users u ON u.id = e.created_by
      WHERE (${from ?? null}::date IS NULL OR e.expense_date >= ${from ?? null}::date)
        AND (${to   ?? null}::date IS NULL OR e.expense_date <= ${to   ?? null}::date)
        AND (${category ?? null}::text IS NULL OR e.category = ${category ?? null})
      ORDER BY e.expense_date DESC, e.id DESC
    `
  })

  // POST /api/expenses
  fastify.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { category, amount, note, expense_date } = req.body
    const [expense] = await sql`
      INSERT INTO expenses (category, amount, note, expense_date, created_by)
      VALUES (${category}, ${amount}, ${note ?? null}, ${expense_date ?? null}, ${req.user.id})
      RETURNING *
    `
    return reply.code(201).send(expense)
  })

  // PUT /api/expenses/:id
  fastify.put('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
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
    return expense
  })

  // DELETE /api/expenses/:id
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await sql`DELETE FROM expenses WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })
}
