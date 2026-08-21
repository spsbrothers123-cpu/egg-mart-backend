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

  // ── GST on purchases (needed by the admin Purchase History / Excel export) ──
  await sql`
    ALTER TABLE purchases
    ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS gst_amt NUMERIC(10,2) NOT NULL DEFAULT 0
  `
  console.log('✅ purchases.gst_pct / gst_amt ready.')

  // ── Daily invoice counters ────────────────────────────────────────────────
  // Backs atomic, gap-free invoice number generation (YYYYMMDD-00001).
  // A single UPSERT that increments this row is used *inside* the same
  // transaction as the bill insert, so concurrent checkouts serialize on the
  // row lock instead of racing on a COUNT(*) read (which produced duplicate
  // invoice numbers and 500 errors under concurrent load).
  await sql`
    CREATE TABLE IF NOT EXISTS daily_invoice_counters (
      invoice_date DATE PRIMARY KEY,
      counter      INTEGER NOT NULL DEFAULT 0
    )
  `
  console.log('✅ daily_invoice_counters table ready.')

  // Backfill from any existing bills so the counter doesn't restart at 0
  // and collide with already-issued invoice numbers on today's date.
  await sql`
    INSERT INTO daily_invoice_counters (invoice_date, counter)
    SELECT created_at::date, COUNT(*)
    FROM bills
    GROUP BY created_at::date
    ON CONFLICT (invoice_date) DO UPDATE SET counter = GREATEST(daily_invoice_counters.counter, EXCLUDED.counter)
  `
  console.log('✅ daily_invoice_counters backfilled.')

  // ── Performance indexes required by the optimization pass ───────────────
  await sql`CREATE INDEX IF NOT EXISTS idx_users_username        ON users(username)`
  await sql`CREATE INDEX IF NOT EXISTS idx_products_name         ON products(name)`
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_phone       ON customers(phone)`
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_purchase_date ON purchases(purchase_date)`
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_opened_at    ON sessions(opened_at)`
  await sql`CREATE INDEX IF NOT EXISTS idx_bills_payment_status  ON bills(payment_status)`
  await sql`CREATE INDEX IF NOT EXISTS idx_activity_logs_created_at ON activity_logs(created_at)`
  console.log('✅ additional performance indexes ready.')

  // ── Allow 'credit' as a valid payment_method ─────────────────────────────
  // bills.js already accepts 'credit' in its request schema and updates
  // customers.credit_used for it, but the original CHECK constraint never
  // included it, so every credit sale hit an unhandled 500 from Postgres.
  await sql`
    ALTER TABLE bills
    DROP CONSTRAINT IF EXISTS bills_payment_method_check
  `
  await sql`
    ALTER TABLE bills
    ADD CONSTRAINT bills_payment_method_check
    CHECK (payment_method IN ('cash','card','upi','net_banking','split','credit'))
  `
  console.log("✅ bills.payment_method CHECK now allows 'credit'.")

  // ── Enforce credit_used <= credit_limit at the DB level ──────────────────
  // Nothing previously stopped credit_used from exceeding credit_limit.
  // This is a safety net in addition to the app-layer check added in
  // bills.js; if that check is ever bypassed, the DB itself now refuses.
  await sql`
    ALTER TABLE customers
    DROP CONSTRAINT IF EXISTS customers_credit_used_within_limit
  `
  await sql`
    ALTER TABLE customers
    ADD CONSTRAINT customers_credit_used_within_limit
    CHECK (credit_used <= credit_limit)
  `
  console.log('✅ customers.credit_used constrained to <= credit_limit.')

  // ── Normalize pre-existing free-text expense categories ──────────────────
  // Now that expenses.category is whitelisted going forward (see expenses.js),
  // fold obvious casing/naming variants already in the table into the
  // canonical set so historical reports aren't fragmented.
  const categoryAliases = {
    transport: 'Transport', transportation: 'Transport',
    labour: 'Labour', labor: 'Labour',
    packaging: 'Packaging',
    utilities: 'Utilities', utility: 'Utilities',
    rent: 'Rent',
    maintenance: 'Maintenance', repair: 'Maintenance', repairs: 'Maintenance',
    misc: 'Miscellaneous', miscellaneous: 'Miscellaneous', other: 'Miscellaneous',
  }
  for (const [alias, canonical] of Object.entries(categoryAliases)) {
    await sql`
      UPDATE expenses SET category = ${canonical}
      WHERE LOWER(category) = ${alias} AND category != ${canonical}
    `
  }
  console.log('✅ Existing expense categories normalized to whitelist.')

  // ── Clamp and lock down negative product stock ───────────────────────────
  // The application layer (bills.js sale deduction, inventory.js /adjust)
  // already prevents stock from going negative going forward via atomic
  // row-locked UPDATE ... WHERE stock >= qty checks. But any product that
  // went negative *before* those checks existed is still sitting in the
  // table with a negative value, and nothing retroactively fixes it — it
  // just sits there showing as "Critical" forever until someone notices.
  // Clamp existing bad rows to 0, then add a CHECK constraint so it's
  // impossible for any future code path (including ones we haven't audited)
  // to write a negative value again.
  const clamped = await sql`
    UPDATE products SET stock = 0, updated_at = NOW()
    WHERE stock < 0
    RETURNING id, name
  `
  if (clamped.length) {
    console.log(`⚠️  Clamped ${clamped.length} product(s) with negative stock to 0:`,
      clamped.map(p => p.name).join(', '))
  }

  await sql`ALTER TABLE products DROP CONSTRAINT IF EXISTS products_stock_non_negative`
  await sql`
    ALTER TABLE products
    ADD CONSTRAINT products_stock_non_negative
    CHECK (stock >= 0)
  `
  console.log('✅ products.stock constrained to >= 0 at the database level.')

  // ── Credit bill settlement tracking ───────────────────────────────────────
  // Credit sales are recorded with payment_method='credit' at checkout time.
  // When an admin later settles one via "Mark as Paid" (Cash/UPI/Card), we
  // need to remember which method actually settled the debt — separately
  // from the original payment_method — so Sales History / Reports can show
  // the true settlement method while still preserving the fact that the
  // sale originated as a credit transaction (audit trail).
  await sql`
    ALTER TABLE bills
    ADD COLUMN IF NOT EXISTS settled_method TEXT,
    ADD COLUMN IF NOT EXISTS settled_at     TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS settled_by     INTEGER REFERENCES users(id) ON DELETE SET NULL
  `
  await sql`ALTER TABLE bills DROP CONSTRAINT IF EXISTS bills_settled_method_check`
  await sql`
    ALTER TABLE bills
    ADD CONSTRAINT bills_settled_method_check
    CHECK (settled_method IS NULL OR settled_method IN ('cash','card','upi'))
  `
  console.log('✅ bills.settled_method / settled_at / settled_by ready.')

  // ── Backfill: credit bills created before payment_status was set correctly ──
  // Earlier, POST /api/bills relied on the table default of payment_status =
  // 'paid' regardless of payment_method, so any pre-existing credit sale is
  // sitting there mislabeled as already paid. Bring those in line with the
  // 'credit' (pending) status so they now correctly surface on the admin
  // Credits page as outstanding.
  await sql`
    UPDATE bills SET payment_status = 'credit'
    WHERE payment_method = 'credit' AND payment_status = 'paid' AND settled_at IS NULL
  `
  console.log('✅ Backfilled payment_status for pre-existing credit bills.')

  await sql`CREATE INDEX IF NOT EXISTS idx_bills_payment_method ON bills(payment_method)`
  console.log('✅ idx_bills_payment_method ready.')

  // ── Multi-Admin / Multi-Shop / Multi-Cashier ─────────────────────────────
  // New hierarchy: Admin -> many Shops -> many Cashiers. Every shop-scoped
  // entity gets a shop_id. Existing (pre-migration) data belonged to a
  // single implicit shop, so it's backfilled into a real "Main Shop" owned
  // by the earliest admin account rather than left orphaned.
  await sql`
    CREATE TABLE IF NOT EXISTS shops (
      id          SERIAL PRIMARY KEY,
      admin_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT,
      location    TEXT NOT NULL,
      active      BOOLEAN NOT NULL DEFAULT TRUE,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_shops_admin_id ON shops(admin_id)`
  console.log('✅ shops table ready.')

  // Cashiers belong to exactly one shop at a time. Admins own shops via
  // shops.admin_id instead of belonging to one, so this stays nullable.
  await sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL`
  await sql`CREATE INDEX IF NOT EXISTS idx_users_shop_id ON users(shop_id)`
  console.log('✅ users.shop_id ready.')

  // Shop-scoped entities. Products/customers/suppliers cascade with their
  // shop (they're owned data); bills/expenses/purchases/sessions use
  // SET NULL so historical financial records are never silently deleted
  // just because a shop was removed.
  await sql`ALTER TABLE products  ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE`
  await sql`ALTER TABLE customers ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE`
  await sql`ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE CASCADE`
  await sql`ALTER TABLE bills     ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL`
  await sql`ALTER TABLE expenses  ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL`
  await sql`ALTER TABLE purchases ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL`
  await sql`ALTER TABLE sessions  ADD COLUMN IF NOT EXISTS shop_id INTEGER REFERENCES shops(id) ON DELETE SET NULL`
  await sql`CREATE INDEX IF NOT EXISTS idx_products_shop_id  ON products(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_customers_shop_id ON customers(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_suppliers_shop_id ON suppliers(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_bills_shop_id     ON bills(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_expenses_shop_id  ON expenses(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_purchases_shop_id ON purchases(shop_id)`
  await sql`CREATE INDEX IF NOT EXISTS idx_sessions_shop_id  ON sessions(shop_id)`
  console.log('✅ shop_id columns + indexes ready on all shop-scoped tables.')

  // ── Backfill: give pre-existing single-tenant data a real home shop ──────
  // Before this migration the app only ever had one implicit shop. Rather
  // than leave every existing row with shop_id = NULL (which would make it
  // invisible under the new shop-scoped queries), create a "Main Shop"
  // owned by the earliest admin account and attach all pre-existing
  // unscoped data — and cashiers — to it.
  const [earliestAdmin] = await sql`
    SELECT id FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1
  `
  if (earliestAdmin) {
    const [mainShop] = await sql`
      INSERT INTO shops (admin_id, name, location)
      SELECT ${earliestAdmin.id}, 'Main Shop', 'Main'
      WHERE NOT EXISTS (SELECT 1 FROM shops WHERE admin_id = ${earliestAdmin.id})
      RETURNING id
    `
    const shopId = mainShop?.id ?? (
      await sql`SELECT id FROM shops WHERE admin_id = ${earliestAdmin.id} ORDER BY id ASC LIMIT 1`
    )[0]?.id

    if (shopId) {
      await sql`UPDATE users     SET shop_id = ${shopId} WHERE role = 'cashier' AND shop_id IS NULL`
      await sql`UPDATE products  SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE customers SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE suppliers SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE bills     SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE expenses  SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE purchases SET shop_id = ${shopId} WHERE shop_id IS NULL`
      await sql`UPDATE sessions  SET shop_id = ${shopId} WHERE shop_id IS NULL`
      console.log(`✅ Backfilled pre-existing data into shop #${shopId} (owned by admin #${earliestAdmin.id}).`)
    }
  } else {
    console.log('ℹ️  No existing admin found — skipping shop backfill (fresh database).')
  }

  // ── Enforce the new isolation rules at the database level ───────────────
  // A cashier without a shop shouldn't exist going forward (they'd fall
  // through every shop-scoped query and effectively see nothing).
  await sql`ALTER TABLE users DROP CONSTRAINT IF EXISTS users_cashier_has_shop`
  await sql`
    ALTER TABLE users
    ADD CONSTRAINT users_cashier_has_shop
    CHECK (role != 'cashier' OR shop_id IS NOT NULL)
  `
  console.log('✅ users_cashier_has_shop constraint ready.')

  // Product/customer/supplier isolation is core to shop-level data
  // separation (rule 13) — these should never be shop-less going forward.
  await sql`ALTER TABLE products  ALTER COLUMN shop_id SET NOT NULL`
  await sql`ALTER TABLE customers ALTER COLUMN shop_id SET NOT NULL`
  await sql`ALTER TABLE suppliers ALTER COLUMN shop_id SET NOT NULL`
  console.log('✅ products/customers/suppliers.shop_id now NOT NULL.')

  // ── Split payments ────────────────────────────────────────────────────────
  // A bill with payment_method = 'split' now retains its individual payment
  // portions here instead of collapsing them into a single opaque amount.
  // 'gpay' is accepted as an input alias for 'upi' at the route layer (see
  // bills.js) so it lands in the same reporting bucket as existing UPI
  // sales rather than fragmenting payment-method reports.
  await sql`
    CREATE TABLE IF NOT EXISTS bill_payments (
      id          SERIAL PRIMARY KEY,
      bill_id     INTEGER NOT NULL REFERENCES bills(id) ON DELETE CASCADE,
      method      TEXT NOT NULL CHECK (method IN ('cash','card','upi','net_banking')),
      amount      NUMERIC(10,2) NOT NULL CHECK (amount > 0),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS idx_bill_payments_bill_id ON bill_payments(bill_id)`
  console.log('✅ bill_payments table ready.')

  await sql.end()
}

alter().catch(err => {
  console.error('❌ Alter failed:', err)
  process.exit(1)
})
