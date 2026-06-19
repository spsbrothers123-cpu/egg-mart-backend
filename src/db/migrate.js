import 'dotenv/config'
import sql from '../config/db.js'

async function migrate() {
  console.log('🔄 Running migrations...')

  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      username    TEXT NOT NULL UNIQUE,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL CHECK (role IN ('admin', 'cashier')),
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS categories (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      slug        TEXT NOT NULL UNIQUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS products (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      pack         TEXT NOT NULL,
      sku          TEXT UNIQUE,
      barcode      TEXT UNIQUE,
      category_id  INTEGER REFERENCES categories(id) ON DELETE SET NULL,
      price        NUMERIC(10,2) NOT NULL,
      stock        INTEGER NOT NULL DEFAULT 0,
      emoji        TEXT DEFAULT '🥚',
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id           SERIAL PRIMARY KEY,
      name         TEXT NOT NULL,
      phone        TEXT,
      email        TEXT,
      address      TEXT,
      credit_limit NUMERIC(10,2) NOT NULL DEFAULT 0,
      credit_used  NUMERIC(10,2) NOT NULL DEFAULT 0,
      active       BOOLEAN NOT NULL DEFAULT TRUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS suppliers (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      contact     TEXT,
      phone       TEXT,
      email       TEXT,
      address     TEXT,
      products    TEXT,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS bills (
      id             SERIAL PRIMARY KEY,
      invoice_number TEXT NOT NULL UNIQUE,
      customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      cashier_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      subtotal       NUMERIC(10,2) NOT NULL,
      discount_pct   NUMERIC(5,2) NOT NULL DEFAULT 0,
      discount_amt   NUMERIC(10,2) NOT NULL DEFAULT 0,
      tax_pct        NUMERIC(5,2) NOT NULL DEFAULT 0,
      tax_amt        NUMERIC(10,2) NOT NULL DEFAULT 0,
      total          NUMERIC(10,2) NOT NULL,
      payment_method TEXT NOT NULL DEFAULT 'cash' CHECK (payment_method IN ('cash','card','upi','net_banking','split')),
      payment_status TEXT NOT NULL DEFAULT 'paid' CHECK (payment_status IN ('paid','credit','refunded','voided')),
      notes          TEXT,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS bill_items (
      id          SERIAL PRIMARY KEY,
      bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      product_id  INTEGER REFERENCES products(id) ON DELETE SET NULL,
      name        TEXT NOT NULL,
      pack        TEXT,
      price       NUMERIC(10,2) NOT NULL,
      qty         INTEGER NOT NULL,
      total       NUMERIC(10,2) NOT NULL
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS stock_movements (
      id          SERIAL PRIMARY KEY,
      product_id  INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      type        TEXT NOT NULL CHECK (type IN ('in','out','adjustment','sale','return')),
      qty         INTEGER NOT NULL,
      note        TEXT,
      ref_id      INTEGER,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS expenses (
      id          SERIAL PRIMARY KEY,
      category    TEXT NOT NULL,
      amount      NUMERIC(10,2) NOT NULL,
      note        TEXT,
      expense_date DATE NOT NULL DEFAULT CURRENT_DATE,
      created_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id              SERIAL PRIMARY KEY,
      cashier_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      opening_cash    NUMERIC(10,2) NOT NULL DEFAULT 0,
      closing_cash    NUMERIC(10,2),
      status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
      opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at       TIMESTAMPTZ
    )
  `

  await sql`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
      action      TEXT NOT NULL,
      entity      TEXT,
      entity_id   INTEGER,
      meta        JSONB,
      ip          TEXT,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  // Indexes for performance
  await sql`CREATE INDEX IF NOT EXISTS idx_bills_created_at    ON bills(created_at)`
  await sql`CREATE INDEX IF NOT EXISTS idx_bills_customer_id   ON bills(customer_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_bill_items_bill_id  ON bill_items(bill_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_stock_product_id    ON stock_movements(product_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_expenses_date       ON expenses(expense_date)`

  console.log('✅ Migrations complete.')
  await sql.end()
}

migrate().catch(err => {
  console.error('❌ Migration failed:', err)
  process.exit(1)
})
