import 'dotenv/config'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import sensible from '@fastify/sensible'
import helmet from '@fastify/helmet'
import compress from '@fastify/compress'
import rateLimit from '@fastify/rate-limit'

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
import dashboardRoutes from './routes/dashboard.js'
import purchaseRoutes  from './routes/purchases.js'

// ── Fail fast on missing required secrets ───────────────────────────────────
// A fallback JWT secret is a critical vulnerability: it lets anyone who reads
// the source code forge valid tokens for any account. The app must refuse to
// start rather than silently run insecurely.
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 16) {
  console.error('❌ JWT_SECRET is missing or too short (min 16 chars). Refusing to start.')
  console.error('   Set JWT_SECRET in your environment (.env) before starting the server.')
  process.exit(1)
}

if (!process.env.DATABASE_URL) {
  console.error('❌ DATABASE_URL is missing. Refusing to start.')
  process.exit(1)
}

const isProd = process.env.NODE_ENV === 'production'

const fastify = Fastify({
  logger: isProd
    ? { level: process.env.LOG_LEVEL || 'info' }
    : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
        },
      },
  trustProxy: true, // needed for correct req.ip behind a reverse proxy / load balancer
})

// ── Plugins ──────────────────────────────────────────────────────────────────
await fastify.register(sensible)
await fastify.register(helmet, { global: true })
await fastify.register(compress, { global: true, encodings: ['br', 'gzip', 'deflate'] })

// ── CORS: explicit allow-list only ──────────────────────────────────────────
// Previously any *.vercel.app subdomain was trusted, which means anyone who
// deploys a Vercel app could make credentialed cross-origin requests against
// this API. Restrict to explicitly configured origins.
const allowedOrigins = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean)

if (!isProd) {
  allowedOrigins.push('http://localhost:5173', 'http://localhost:4173')
}

await fastify.register(cors, {
  // Standard pattern: for a disallowed origin we simply omit the
  // Access-Control-Allow-* headers (cb(null, false)) rather than throwing.
  // CORS is enforced by the browser reading those headers, not by the
  // server refusing the request — throwing here just produces a confusing
  // 500 for non-browser clients (mobile apps, server-to-server calls)
  // that don't send an Origin header at all and aren't subject to CORS.
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) {
      cb(null, true)
    } else {
      cb(null, false)
    }
  },
  credentials: true,
})

await fastify.register(jwt, {
  secret: process.env.JWT_SECRET,
})

// ── Rate limiting (global default; login route has a stricter override) ────
await fastify.register(rateLimit, {
  global: true,
  max: 300,
  timeWindow: '1 minute',
})

// ── Health check ─────────────────────────────────────────────────────────────
fastify.get('/health', { config: { rateLimit: false } }, async () => ({
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
await fastify.register(dashboardRoutes, { prefix: '/api/dashboard' })
await fastify.register(purchaseRoutes,  { prefix: '/api/purchases' })

// ── Global error handler ─────────────────────────────────────────────────────
fastify.setErrorHandler((error, request, reply) => {
  fastify.log.error({ err: error, path: request.url, method: request.method }, 'request error')

  if (error.validation) {
    return reply.code(400).send({ error: 'Validation error', details: error.validation })
  }

  if (error.code === '23505') {
    return reply.code(409).send({ error: 'Duplicate entry — record already exists' })
  }

  if (error.code === '23503') {
    return reply.code(400).send({ error: 'Referenced record does not exist' })
  }

  if (error.statusCode === 429) {
    return reply.code(429).send({ error: 'Too many requests — please slow down' })
  }

  if (error.message === 'Not allowed by CORS') {
    return reply.code(403).send({ error: 'Origin not allowed' })
  }

  const statusCode = error.statusCode ?? 500

  // Never leak raw internal error messages (stack traces, SQL, file paths) to
  // the client on unexpected 5xx errors — only for well-formed 4xx errors
  // that were deliberately thrown with a safe message by route handlers.
  const message = statusCode < 500 ? (error.message ?? 'Request error') : 'Internal Server Error'

  reply.code(statusCode).send({ error: message })
})

// ── Graceful shutdown ────────────────────────────────────────────────────────
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`)
    await fastify.close()
    process.exit(0)
  })
}

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
