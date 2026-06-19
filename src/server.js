import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'

import authRoutes      from './routes/auth.js'
import productRoutes   from './routes/products.js'
import billRoutes      from './routes/bills.js'
import customerRoutes  from './routes/customers.js'
import expenseRoutes   from './routes/expenses.js'
import inventoryRoutes from './routes/inventory.js'
import supplierRoutes  from './routes/suppliers.js'
import reportRoutes    from './routes/reports.js'
import userRoutes      from './routes/users.js'
import sessionRoutes   from './routes/sessions.js'

const fastify = Fastify({
  logger: {
    transport: {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
    },
  },
})

// ── Plugins ──────────────────────────────────────────────────────────────────
await fastify.register(sensible)

await fastify.register(cors, {
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  credentials: true,
})

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'dev_secret_change_me',
})

// ── Health check ─────────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status: 'ok',
  timestamp: new Date().toISOString(),
  service: 'egg-mart-pos-api',
}))

// ── Routes ───────────────────────────────────────────────────────────────────
await fastify.register(authRoutes,      { prefix: '/api/auth'      })
await fastify.register(productRoutes,   { prefix: '/api/products'  })
await fastify.register(billRoutes,      { prefix: '/api/bills'     })
await fastify.register(customerRoutes,  { prefix: '/api/customers' })
await fastify.register(expenseRoutes,   { prefix: '/api/expenses'  })
await fastify.register(inventoryRoutes, { prefix: '/api/inventory' })
await fastify.register(supplierRoutes,  { prefix: '/api/suppliers' })
await fastify.register(reportRoutes,    { prefix: '/api/reports'   })
await fastify.register(userRoutes,      { prefix: '/api/users'     })
await fastify.register(sessionRoutes,   { prefix: '/api/sessions'  })

// ── Global error handler ─────────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error(error)

  if (error.validation) {
    return reply.code(400).send({ error: 'Validation error', details: error.validation })
  }

  if (error.code === '23505') {
    return reply.code(409).send({ error: 'Duplicate entry — record already exists' })
  }

  if (error.code === '23503') {
    return reply.code(400).send({ error: 'Referenced record does not exist' })
  }

  reply.code(error.statusCode ?? 500).send({
    error: error.message ?? 'Internal Server Error',
  })
})

// ── Start ────────────────────────────────────────────────────────────────────
try {
  const port = parseInt(process.env.PORT ?? '3001')
  const host = process.env.HOST ?? '0.0.0.0'
  await fastify.listen({ port, host })
  console.log(`\n🥚 Egg Mart API running at http://${host}:${port}`)
  console.log(`📋 Health check: http://localhost:${port}/health\n`)
} catch (err) {
  fastify.log.error(err)
  process.exit(1)
}
