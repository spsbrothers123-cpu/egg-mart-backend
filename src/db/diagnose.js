// src/db/diagnose.js
//
// READ-ONLY diagnostic report for the multi-admin / multi-shop ownership
// model. This script never writes, updates, deletes, or alters anything —
// it only runs SELECT queries and prints a report.
//
// Usage:
//   node src/db/diagnose.js
//   node src/db/diagnose.js --json     (machine-readable output)
//
// Run this FIRST, before touching backfill-ownership.js or recover-products.js,
// so you know exactly what state the database is in.

import 'dotenv/config'
import sql from '../config/db.js'

const asJson = process.argv.includes('--json')

function section(title) {
  if (!asJson) {
    console.log('\n' + '─'.repeat(70))
    console.log(title)
    console.log('─'.repeat(70))
  }
}

async function main() {
  const report = {}

  // ── 1. All admins ─────────────────────────────────────────────────────
  const admins = await sql`
    SELECT id, name, username, active, created_at
    FROM users
    WHERE role = 'admin'
    ORDER BY id
  `
  report.admins = admins

  // ── 2. Shops per admin, with product/cashier counts ─────────────────────
  const shopRows = await sql`
    SELECT
      s.id                                   AS shop_id,
      s.admin_id,
      a.username                             AS admin_username,
      s.name                                 AS shop_name,
      s.location                             AS shop_location,
      s.active                               AS shop_active,
      COUNT(DISTINCT p.id) FILTER (WHERE p.active = TRUE)  AS active_product_count,
      COUNT(DISTINCT p.id) FILTER (WHERE p.active = FALSE) AS inactive_product_count,
      COUNT(DISTINCT c.id) FILTER (WHERE c.role = 'cashier') AS cashier_count
    FROM shops s
    LEFT JOIN users a ON a.id = s.admin_id
    LEFT JOIN products p ON p.shop_id = s.id
    LEFT JOIN users c ON c.shop_id = s.id AND c.role = 'cashier'
    GROUP BY s.id, s.admin_id, a.username, s.name, s.location, s.active
    ORDER BY s.admin_id, s.id
  `
  report.shops = shopRows

  // ── 3. Duplicate / phantom shop detection ────────────────────────────────
  // "Duplicate" = same admin_id + same location (case-insensitive).
  // "Phantom" = a shop with zero products, zero cashiers, and zero bills —
  // possibly created accidentally or left over from a bad migration.
  const duplicateShops = await sql`
    SELECT admin_id, LOWER(location) AS location, ARRAY_AGG(id ORDER BY id) AS shop_ids, COUNT(*)::int AS count
    FROM shops
    GROUP BY admin_id, LOWER(location)
    HAVING COUNT(*) > 1
  `
  report.duplicate_shops = duplicateShops

  const phantomShops = await sql`
    SELECT s.id AS shop_id, s.admin_id, s.name, s.location, s.created_at
    FROM shops s
    WHERE NOT EXISTS (SELECT 1 FROM products  p WHERE p.shop_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM users     u WHERE u.shop_id = s.id AND u.role = 'cashier')
      AND NOT EXISTS (SELECT 1 FROM bills     b WHERE b.shop_id = s.id)
      AND NOT EXISTS (SELECT 1 FROM customers cu WHERE cu.shop_id = s.id)
    ORDER BY s.id
  `
  report.phantom_shops = phantomShops

  // ── 4. Inactive (soft-deleted) products, globally and per shop ─────────
  const inactiveProducts = await sql`
    SELECT id, name, shop_id, stock, updated_at
    FROM products
    WHERE active = FALSE
    ORDER BY shop_id, id
  `
  report.inactive_products = inactiveProducts

  // ── 5. Products / customers / suppliers with NULL shop_id ───────────────
  // (Only possible pre-migration or mid-migration; the NOT NULL constraint
  // blocks this going forward once backfill is complete.)
  const unassignedProducts  = await sql`SELECT id, name FROM products  WHERE shop_id IS NULL ORDER BY id`
  const unassignedCustomers = await sql`SELECT id, name FROM customers WHERE shop_id IS NULL ORDER BY id`
  let unassignedSuppliers = []
  try {
    unassignedSuppliers = await sql`SELECT id, name FROM suppliers WHERE shop_id IS NULL ORDER BY id`
  } catch { /* suppliers.shop_id may not exist yet on very old schemas */ }
  report.unassigned_products = unassignedProducts
  report.unassigned_customers = unassignedCustomers
  report.unassigned_suppliers = unassignedSuppliers

  // ── 6. Cashiers with NULL shop_id ────────────────────────────────────────
  const unassignedCashiers = await sql`
    SELECT id, name, username, active, created_at
    FROM users
    WHERE role = 'cashier' AND shop_id IS NULL
    ORDER BY id
  `
  report.unassigned_cashiers = unassignedCashiers

  // ── 7. Bills / sessions with NULL shop_id (financial history at risk) ───
  const unassignedBills = await sql`SELECT COUNT(*)::int AS count FROM bills WHERE shop_id IS NULL`
  const unassignedSessions = await sql`SELECT COUNT(*)::int AS count FROM sessions WHERE shop_id IS NULL`
  report.unassigned_bills_count = unassignedBills[0].count
  report.unassigned_sessions_count = unassignedSessions[0].count

  // ── 8. Cross-check: any shop-scoped row pointing at a shop_id that
  //      doesn't belong to the admin who "owns" the data through a cashier?
  //      (sanity check for data crossing shop boundaries)
  const crossShopCashierBills = await sql`
    SELECT b.id AS bill_id, b.shop_id AS bill_shop_id, u.shop_id AS cashier_shop_id, b.cashier_id
    FROM bills b
    JOIN users u ON u.id = b.cashier_id
    WHERE b.shop_id IS NOT NULL AND u.shop_id IS NOT NULL AND b.shop_id != u.shop_id
    LIMIT 50
  `
  report.cross_shop_bill_mismatches = crossShopCashierBills

  // ── Print ─────────────────────────────────────────────────────────────
  if (asJson) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    section(`ADMINS (${admins.length})`)
    if (admins.length === 0) console.log('  (none — fresh database)')
    for (const a of admins) {
      console.log(`  #${a.id}  ${a.username}  active=${a.active}  created_at=${a.created_at.toISOString()}`)
    }

    section(`SHOPS × ADMIN OWNERSHIP (${shopRows.length})`)
    if (shopRows.length === 0) console.log('  (no shops exist yet)')
    for (const s of shopRows) {
      console.log(`  shop #${s.shop_id} "${s.shop_name ?? '(unnamed)'}" @ ${s.shop_location}` +
        `  owner=admin#${s.admin_id}(${s.admin_username ?? 'UNKNOWN'})  active=${s.shop_active}`)
      console.log(`      active_products=${s.active_product_count}  inactive_products=${s.inactive_product_count}  cashiers=${s.cashier_count}`)
    }

    section(`DUPLICATE SHOPS (same admin + same location) (${duplicateShops.length})`)
    if (duplicateShops.length === 0) console.log('  none found')
    for (const d of duplicateShops) {
      console.log(`  admin#${d.admin_id} location="${d.location}"  shop_ids=[${d.shop_ids.join(', ')}]  count=${d.count}`)
    }

    section(`PHANTOM SHOPS (no products/cashiers/bills/customers) (${phantomShops.length})`)
    if (phantomShops.length === 0) console.log('  none found')
    for (const p of phantomShops) {
      console.log(`  shop #${p.shop_id} "${p.name ?? '(unnamed)'}" @ ${p.location}  owner=admin#${p.admin_id}  created_at=${p.created_at.toISOString()}`)
    }

    section(`INACTIVE (SOFT-DELETED) PRODUCTS (${inactiveProducts.length})`)
    if (inactiveProducts.length === 0) console.log('  none found')
    for (const p of inactiveProducts.slice(0, 50)) {
      console.log(`  product #${p.id} "${p.name}"  shop_id=${p.shop_id}  stock=${p.stock}  updated_at=${p.updated_at.toISOString()}`)
    }
    if (inactiveProducts.length > 50) console.log(`  ... and ${inactiveProducts.length - 50} more (use --json to see all)`)

    section('UNASSIGNED (shop_id IS NULL) RECORDS')
    console.log(`  products:  ${unassignedProducts.length}`)
    console.log(`  customers: ${unassignedCustomers.length}`)
    console.log(`  suppliers: ${unassignedSuppliers.length}`)
    console.log(`  cashiers:  ${unassignedCashiers.length}`)
    console.log(`  bills:     ${unassignedBills[0].count}`)
    console.log(`  sessions:  ${unassignedSessions[0].count}`)
    if (unassignedCashiers.length) {
      for (const c of unassignedCashiers) console.log(`      cashier #${c.id} "${c.username}" active=${c.active}`)
    }

    section(`CROSS-SHOP BILL MISMATCHES (bill.shop_id != cashier.shop_id) (${crossShopCashierBills.length})`)
    if (crossShopCashierBills.length === 0) console.log('  none found')
    for (const m of crossShopCashierBills) {
      console.log(`  bill #${m.bill_id}: bill.shop_id=${m.bill_shop_id} but cashier#${m.cashier_id}.shop_id=${m.cashier_shop_id}`)
    }

    section('SUMMARY / NEXT STEPS')
    if (admins.length > 1 && (unassignedProducts.length || unassignedCustomers.length || unassignedCashiers.length)) {
      console.log('  Multiple admins exist AND unassigned (shop_id NULL) data exists.')
      console.log('  Do NOT run any auto-backfill. Run:')
      console.log('    node src/db/backfill-ownership.js --admin-id=<ID>')
      console.log('  with an explicitly chosen, verified admin ID (see the ADMINS list above).')
    } else if (admins.length === 1 && (unassignedProducts.length || unassignedCustomers.length || unassignedCashiers.length)) {
      console.log('  Exactly one admin exists and unassigned data exists — unambiguous.')
      console.log('  Still review the counts above, then run:')
      console.log(`    node src/db/backfill-ownership.js --admin-id=${admins[0].id} --confirm`)
    } else {
      console.log('  No unassigned (shop_id NULL) data found. No backfill needed.')
    }
    if (inactiveProducts.length) {
      console.log(`  ${inactiveProducts.length} inactive product(s) found — review with:`)
      console.log('    node src/db/recover-products.js --shop-id=<ID>')
    }
    console.log('')
  }

  await sql.end()
}

main().catch(err => {
  console.error('❌ Diagnose failed:', err)
  process.exit(1)
})
