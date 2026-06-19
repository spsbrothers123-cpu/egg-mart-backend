import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function sessionRoutes(fastify) {
  // GET /api/sessions — list all sessions with revenue (admin only)
  fastify.get('/', { preHandler: requireRole('admin') }, async (req) => {
    const sessions = await sql`
      SELECT
        s.*,
        u.name AS cashier_name,
        COUNT(b.id)::int                        AS bill_count,
        COALESCE(SUM(b.total), 0)::numeric      AS total_revenue,
        EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))::int AS duration_seconds
      FROM sessions s
      LEFT JOIN users u ON u.id = s.cashier_id
      LEFT JOIN bills b
        ON b.cashier_id = s.cashier_id
        AND b.created_at >= s.opened_at
        AND b.created_at <= COALESCE(s.closed_at, NOW())
        AND b.payment_status != 'voided'
      GROUP BY s.id, u.name
      ORDER BY s.opened_at DESC
    `
    return sessions
  })

  // GET /api/sessions/current — get open session for current cashier
  fastify.get('/current', { preHandler: authenticate }, async (req, reply) => {
    const [session] = await sql`
      SELECT
        s.*,
        u.name AS cashier_name,
        COUNT(b.id)::int                        AS bill_count,
        COALESCE(SUM(b.total), 0)::numeric      AS total_revenue,
        EXTRACT(EPOCH FROM (NOW() - s.opened_at))::int AS duration_seconds
      FROM sessions s
      LEFT JOIN users u ON u.id = s.cashier_id
      LEFT JOIN bills b
        ON b.cashier_id = s.cashier_id
        AND b.created_at >= s.opened_at
        AND b.payment_status != 'voided'
      WHERE s.cashier_id = ${req.user.id} AND s.status = 'open'
      GROUP BY s.id, u.name
      ORDER BY s.opened_at DESC LIMIT 1
    `
    if (!session) return reply.code(404).send({ error: 'No open session' })
    return session
  })

  // GET /api/sessions/my — cashier's own session history with revenue
  fastify.get('/my', { preHandler: authenticate }, async (req) => {
    const sessions = await sql`
      SELECT
        s.*,
        COUNT(b.id)::int                        AS bill_count,
        COALESCE(SUM(b.total), 0)::numeric      AS total_revenue,
        EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))::int AS duration_seconds
      FROM sessions s
      LEFT JOIN bills b
        ON b.cashier_id = s.cashier_id
        AND b.created_at >= s.opened_at
        AND b.created_at <= COALESCE(s.closed_at, NOW())
        AND b.payment_status != 'voided'
      WHERE s.cashier_id = ${req.user.id}
      GROUP BY s.id
      ORDER BY s.opened_at DESC
    `
    return sessions
  })

  // POST /api/sessions/open
  fastify.post('/open', { preHandler: authenticate }, async (req, reply) => {
    const { opening_cash = 0, drawer_counts = null } = req.body

    const [existing] = await sql`
      SELECT id FROM sessions WHERE cashier_id = ${req.user.id} AND status = 'open'
    `
    if (existing) return reply.code(400).send({ error: 'Session already open' })

    const [session] = await sql`
      INSERT INTO sessions (cashier_id, opening_cash, drawer_counts)
      VALUES (
        ${req.user.id},
        ${opening_cash},
        ${drawer_counts ? JSON.stringify(drawer_counts) : null}
      )
      RETURNING *
    `
    return reply.code(201).send(session)
  })

  // POST /api/sessions/:id/close
  fastify.post('/:id/close', { preHandler: authenticate }, async (req, reply) => {
    const { closing_cash, drawer_counts } = req.body

    const [session] = await sql`
      UPDATE sessions SET
        status        = 'closed',
        closing_cash  = ${closing_cash ?? null},
        drawer_counts = ${drawer_counts ? JSON.stringify(drawer_counts) : null},
        closed_at     = NOW()
      WHERE id = ${req.params.id} AND cashier_id = ${req.user.id}
      RETURNING *
    `
    if (!session) return reply.code(404).send({ error: 'Session not found' })
    return session
  })
}