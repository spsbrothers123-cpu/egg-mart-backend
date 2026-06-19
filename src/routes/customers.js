import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function customerRoutes(fastify) {
  // GET /api/customers
  fastify.get('/', { preHandler: authenticate }, async (req) => {
    const { search } = req.query
    return sql`
      SELECT * FROM customers
      WHERE active = TRUE
        AND (${search ?? null}::text IS NULL
             OR name  ILIKE ${'%' + (search ?? '') + '%'}
             OR phone ILIKE ${'%' + (search ?? '') + '%'})
      ORDER BY id
    `
  })

  // GET /api/customers/:id
  fastify.get('/:id', { preHandler: authenticate }, async (req, reply) => {
    const [customer] = await sql`SELECT * FROM customers WHERE id = ${req.params.id}`
    if (!customer) return reply.code(404).send({ error: 'Customer not found' })

    const bills = await sql`
      SELECT id, invoice_number, total, payment_status, payment_method, created_at
      FROM bills WHERE customer_id = ${req.params.id} ORDER BY created_at DESC LIMIT 20
    `
    return { ...customer, bills }
  })

  // POST /api/customers
  fastify.post('/', { preHandler: authenticate }, async (req, reply) => {
    const { name, phone, email, address, credit_limit = 0 } = req.body
    const [customer] = await sql`
      INSERT INTO customers (name, phone, email, address, credit_limit)
      VALUES (${name}, ${phone ?? null}, ${email ?? null}, ${address ?? null}, ${credit_limit})
      RETURNING *
    `
    return reply.code(201).send(customer)
  })

  // PUT /api/customers/:id
  fastify.put('/:id', { preHandler: authenticate }, async (req, reply) => {
    const { name, phone, email, address, credit_limit } = req.body
    const [customer] = await sql`
      UPDATE customers SET
        name         = COALESCE(${name         ?? null}, name),
        phone        = COALESCE(${phone        ?? null}, phone),
        email        = COALESCE(${email        ?? null}, email),
        address      = COALESCE(${address      ?? null}, address),
        credit_limit = COALESCE(${credit_limit ?? null}::numeric, credit_limit),
        updated_at   = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!customer) return reply.code(404).send({ error: 'Customer not found' })
    return customer
  })

  // DELETE /api/customers/:id (soft)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await sql`UPDATE customers SET active = FALSE WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })
}
