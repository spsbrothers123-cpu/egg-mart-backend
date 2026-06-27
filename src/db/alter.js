import 'dotenv/config'
import sql from '../config/db.js'

async function alter() {
  console.log('🔄 Running alterations...')

  // Add drawer_counts column to sessions if not exists
  await sql`
    ALTER TABLE sessions
    ADD COLUMN IF NOT EXISTS drawer_counts JSONB
  `
  console.log('✅ drawer_counts column ready.')

  // Fix bill_items: make product_id nullable (allow walk-in / custom items)
  await sql`
    ALTER TABLE bill_items
    ALTER COLUMN product_id DROP NOT NULL
  `
  console.log('✅ bill_items.product_id nullable.')

  // ── Purchases (supplier purchase orders) ─────────────────────────────────
  // Previously the app had an orphaned Mongoose model for this that was
  // never wired into the Postgres schema, so "Submit Purchase" had nowhere
  // real to save to. These tables give it a real home, following the same
  // bills / bill_items pattern already used elsewhere in this schema.
  await sql`
    CREATE TABLE IF NOT EXISTS purchases (
      id            SERIAL PRIMARY KEY,
      invoice_no    TEXT,
      supplier      TEXT,
      purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
      subtotal      NUMERIC(10,2) NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'received' CHECK (status IN ('pending','received','cancelled')),
      notes         TEXT,
      created_by    INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  console.log('✅ purchases table ready.')

  await sql`
    CREATE TABLE IF NOT EXISTS purchase_items (
      id           SERIAL PRIMARY KEY,
      purchase_id  INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      product_id   INTEGER REFERENCES products(id) ON DELETE SET NULL,
      name         TEXT NOT NULL,
      pack         TEXT,
      unit_price   NUMERIC(10,2) NOT NULL,
      qty          NUMERIC(10,3) NOT NULL,
      total        NUMERIC(10,2) NOT NULL
    )
  `
  console.log('✅ purchase_items table ready.')

  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_created_at      ON purchases(created_at)`
  await sql`CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase_id ON purchase_items(purchase_id)`
  console.log('✅ purchases indexes ready.')

  await sql.end()
}

alter().catch(err => {
  console.error('❌ Alter failed:', err)
  process.exit(1)
})
