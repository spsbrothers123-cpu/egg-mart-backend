// src/db/backfill-ownership.js
//
// Explicit, operator-controlled backfill of shop_id ownership for legacy
// (pre-multi-shop) data: products / customers / suppliers / bills /
// expenses / purchases / sessions / cashiers with shop_id IS NULL.
//
// This intentionally does NOT run automatically as part of `npm run alter`.
// It used to (see git history of alter.js) — it silently picked
// "SELECT ... ORDER BY id ASC LIMIT 1" as "the" admin and attached every
// unowned row to that admin's shop. On a database with more than one admin
// account, that is a guess, not a fact: it can hand one admin's cashiers,
// products, and historical bills to a completely different admin.
//
// Rules enforced here:
//   1. NEVER auto-select "the earliest admin". An admin ID must be given
//      explicitly via --admin-id=<id>, UNLESS there is exactly one admin
//      in the whole database (zero ambiguity — nothing to choose between).
//   2. If more than one admin exists, --admin-id is REQUIRED. No default,
//      no "first one", no ORDER BY id.
//   3. Dry-run by default. Nothing is written unless --confirm is passed.
//   4. Prints exactly what will be affected (row counts, IDs) before any
//      write happens, in both dry-run and confirm mode.
//   5. Never touches a row that already has a shop_id. Only shop_id IS NULL
//      rows are eligible — an already-correctly-assigned shop/product/
//      cashier is never reassigned by this script.
//   6. All writes happen inside a single transaction.
//
// Usage:
//   node src/db/backfill-ownership.js                       (report only, no admin chosen)
//   node src/db/backfill-ownership.js --admin-id=3           (dry run against admin #3)
//   node src/db/backfill-ownership.js --admin-id=3 --confirm (actually writes)

import 'dotenv/config'
import sql from '../config/db.js'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const adminIdArg = args.find(a => a.startsWith('--admin-id='))
const explicitAdminId = adminIdArg ? parseInt(adminIdArg.split('=')[1], 10) : null

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

async function main() {
  console.log('🔎 Ownership backfill — safety checks first (nothing written yet)\n')

  const admins = await sql`SELECT id, username, active, created_at FROM users WHERE role = 'admin' ORDER BY id`

  if (admins.length === 0) {
    console.log('ℹ️  No admin accounts exist — nothing to backfill. Exiting safely.')
    await sql.end()
    return
  }

  console.log(`Admins in database (${admins.length}):`)
  for (const a of admins) console.log(`  #${a.id}  ${a.username}  active=${a.active}  created_at=${a.created_at.toISOString()}`)
  console.log('')

  let targetAdminId = explicitAdminId

  if (admins.length > 1 && !explicitAdminId) {
    fail(
      `Multiple admins exist (${admins.length}). Refusing to guess which one owns the ` +
      `unassigned data. Re-run with an explicit --admin-id=<id> chosen from the list above ` +
      `(e.g. --admin-id=${admins[0].id}). This script will never pick one automatically.`
    )
  }

  if (admins.length === 1 && !explicitAdminId) {
    targetAdminId = admins[0].id
    console.log(`ℹ️  Exactly one admin exists (#${targetAdminId}) — no ambiguity, using it.`)
    console.log('   (You can still pass --admin-id explicitly if you prefer to be fully explicit.)\n')
  }

  const [targetAdmin] = await sql`SELECT id, username, active FROM users WHERE id = ${targetAdminId} AND role = 'admin'`
  if (!targetAdmin) {
    fail(`--admin-id=${targetAdminId} does not match any admin account. Aborting — no changes made.`)
  }
  if (!targetAdmin.active) {
    console.log(`⚠️  WARNING: admin #${targetAdmin.id} (${targetAdmin.username}) is marked inactive.`)
  }

  // ── Report exactly what is currently unassigned ────────────────────────
  const unassigned = {
    cashiers:  await sql`SELECT id, username FROM users     WHERE role = 'cashier' AND shop_id IS NULL ORDER BY id`,
    products:  await sql`SELECT id, name     FROM products  WHERE shop_id IS NULL ORDER BY id`,
    customers: await sql`SELECT id, name     FROM customers WHERE shop_id IS NULL ORDER BY id`,
    suppliers: await sql`SELECT id, name     FROM suppliers WHERE shop_id IS NULL ORDER BY id`,
    bills:     await sql`SELECT id, invoice_number FROM bills WHERE shop_id IS NULL ORDER BY id`,
    expenses:  await sql`SELECT id FROM expenses  WHERE shop_id IS NULL ORDER BY id`,
    purchases: await sql`SELECT id FROM purchases WHERE shop_id IS NULL ORDER BY id`,
    sessions:  await sql`SELECT id FROM sessions  WHERE shop_id IS NULL ORDER BY id`,
  }

  const totalUnassigned = Object.values(unassigned).reduce((sum, rows) => sum + rows.length, 0)

  console.log(`Target admin: #${targetAdmin.id} (${targetAdmin.username})`)
  console.log('Unassigned (shop_id IS NULL) records that WOULD be attached to this admin\'s shop:')
  for (const [table, rows] of Object.entries(unassigned)) {
    console.log(`  ${table.padEnd(10)} ${rows.length}`)
  }
  console.log('')

  if (totalUnassigned === 0) {
    console.log('✅ Nothing to backfill — no unassigned rows found. Exiting without changes.')
    await sql.end()
    return
  }

  // Existing shop for this admin (never create a duplicate "Main Shop" if
  // one already exists — never overwrite an already correctly-assigned shop).
  const existingShops = await sql`SELECT id, name, location FROM shops WHERE admin_id = ${targetAdmin.id} ORDER BY id`
  if (existingShops.length > 0) {
    console.log(`This admin already owns ${existingShops.length} shop(s):`)
    for (const s of existingShops) console.log(`  shop #${s.id} "${s.name ?? '(unnamed)'}" @ ${s.location}`)
    console.log(`Unassigned data will be attached to the FIRST of these: shop #${existingShops[0].id}.`)
    console.log('If that is not the correct shop, abort now (Ctrl+C) and re-run after fixing shop assignment manually.\n')
  } else {
    console.log('This admin owns no shops yet. A new "Main Shop" will be created for them.\n')
  }

  if (!confirm) {
    console.log('🛑 DRY RUN — no changes made. Re-run with --confirm to actually apply this backfill:')
    console.log(`   node src/db/backfill-ownership.js --admin-id=${targetAdmin.id} --confirm`)
    await sql.end()
    return
  }

  // ── Apply, inside a transaction, touching ONLY shop_id IS NULL rows ────
  await sql.begin(async (tx) => {
    let shopId = existingShops[0]?.id

    if (!shopId) {
      const [mainShop] = await tx`
        INSERT INTO shops (admin_id, name, location)
        VALUES (${targetAdmin.id}, 'Main Shop', 'Main')
        RETURNING id
      `
      shopId = mainShop.id
      console.log(`✅ Created shop #${shopId} "Main Shop" for admin #${targetAdmin.id}.`)
    }

    const results = {}
    results.users     = await tx`UPDATE users     SET shop_id = ${shopId} WHERE role = 'cashier' AND shop_id IS NULL RETURNING id`
    results.products  = await tx`UPDATE products  SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.customers = await tx`UPDATE customers SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.suppliers = await tx`UPDATE suppliers SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.bills     = await tx`UPDATE bills     SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.expenses  = await tx`UPDATE expenses  SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.purchases = await tx`UPDATE purchases SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`
    results.sessions  = await tx`UPDATE sessions  SET shop_id = ${shopId} WHERE shop_id IS NULL RETURNING id`

    console.log(`\n✅ Backfill complete into shop #${shopId} (admin #${targetAdmin.id}):`)
    for (const [table, rows] of Object.entries(results)) {
      console.log(`  ${table.padEnd(10)} ${rows.length} row(s) updated`)
    }
  })

  await sql.end()
}

main().catch(err => {
  console.error('❌ Backfill failed — transaction rolled back, no partial changes applied:', err)
  process.exit(1)
})
