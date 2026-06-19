import sql from '../config/db.js'
import { authenticate, requireRole } from '../middleware/auth.js'

export default async function supplierRoutes(fastify) {
  // GET /api/suppliers
  fastify.get('/', { preHandler: requireRole('admin') }, async () => {
    return sql`SELECT * FROM suppliers WHERE active = TRUE ORDER BY name`
  })

  // GET /api/suppliers/:id
  fastify.get('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const [supplier] = await sql`SELECT * FROM suppliers WHERE id = ${req.params.id}`
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // POST /api/suppliers
  fastify.post('/', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, contact, phone, email, address, products } = req.body
    const [supplier] = await sql`
      INSERT INTO suppliers (name, contact, phone, email, address, products)
      VALUES (${name}, ${contact ?? null}, ${phone ?? null}, ${email ?? null},
              ${address ?? null}, ${products ?? null})
      RETURNING *
    `
    return reply.code(201).send(supplier)
  })

  // PUT /api/suppliers/:id
  fastify.put('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    const { name, contact, phone, email, address, products } = req.body
    const [supplier] = await sql`
      UPDATE suppliers SET
        name     = COALESCE(${name     ?? null}, name),
        contact  = COALESCE(${contact  ?? null}, contact),
        phone    = COALESCE(${phone    ?? null}, phone),
        email    = COALESCE(${email    ?? null}, email),
        address  = COALESCE(${address  ?? null}, address),
        products = COALESCE(${products ?? null}, products),
        updated_at = NOW()
      WHERE id = ${req.params.id}
      RETURNING *
    `
    if (!supplier) return reply.code(404).send({ error: 'Supplier not found' })
    return supplier
  })

  // DELETE /api/suppliers/:id (soft)
  fastify.delete('/:id', { preHandler: requireRole('admin') }, async (req, reply) => {
    await sql`UPDATE suppliers SET active = FALSE WHERE id = ${req.params.id}`
    return reply.code(204).send()
  })
}
