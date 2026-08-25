// src/db/recover-products.js
//
// Products in this schema are soft-deleted: DELETE /api/products/:id sets
// products.active = FALSE — the row is never removed (see src/routes/products.js).
// This script never permanently deletes anything; it only ever flips
// active back to TRUE, and only for rows you explicitly choose.
//
// It deliberately does NOT support "reactivate everything" in one shot —
// you must either list specific product IDs or pass --all-in-shop plus the
// shop id, and even then nothing is written without --confirm.
//
// Usage:
//   node src/db/recover-products.js --shop-id=5
//       -> lists inactive products in shop #5 (report only, no changes)
//
//   node src/db/recover-products.js --shop-id=5 --ids=12,17,44 --confirm
//       -> reactivates products 12, 17, 44 — only if they belong to shop #5
//
//   node src/db/recover-products.js --shop-id=5 --all-in-shop --confirm
//       -> reactivates every inactive product in shop #5 only (explicit,
//          scoped, requires --confirm)

import 'dotenv/config'
import sql from '../config/db.js'

const args = process.argv.slice(2)
const confirm = args.includes('--confirm')
const allInShop = args.includes('--all-in-shop')
const shopIdArg = args.find(a => a.startsWith('--shop-id='))
const idsArg = args.find(a => a.startsWith('--ids='))

const shopId = shopIdArg ? parseInt(shopIdArg.split('=')[1], 10) : null
const explicitIds = idsArg ? idsArg.split('=')[1].split(',').map(s => parseInt(s.trim(), 10)).filter(Number.isFinite) : []

function fail(msg) {
  console.error(`❌ ${msg}`)
  process.exit(1)
}

async function main() {
  if (!shopId) {
    fail('--shop-id=<id> is required. Recovery is always scoped to one shop.')
  }

  const [shop] = await sql`SELECT id, name, location, admin_id FROM shops WHERE id = ${shopId}`
  if (!shop) fail(`Shop #${shopId} does not exist.`)

  const inactive = await sql`
    SELECT id, name, stock, updated_at
    FROM products
    WHERE shop_id = ${shopId} AND active = FALSE
    ORDER BY id
  `

  console.log(`Shop #${shop.id} "${shop.name ?? '(unnamed)'}" @ ${shop.location} (admin #${shop.admin_id})`)
  console.log(`Inactive (soft-deleted) products in this shop: ${inactive.length}`)
  for (const p of inactive) {
    console.log(`  #${p.id}  "${p.name}"  stock=${p.stock}  deactivated/updated_at=${p.updated_at.toISOString()}`)
  }
  console.log('')

  if (inactive.length === 0) {
    console.log('Nothing to recover.')
    await sql.end()
    return
  }

  let targetIds
  if (allInShop) {
    targetIds = inactive.map(p => p.id)
    console.log(`--all-in-shop passed: targeting all ${targetIds.length} inactive product(s) in shop #${shopId}.`)
  } else if (explicitIds.length) {
    // Validate every requested id actually belongs to this shop and is inactive.
    const validIds = new Set(inactive.map(p => p.id))
    const invalid = explicitIds.filter(id => !validIds.has(id))
    if (invalid.length) {
      fail(`These product IDs are not inactive products in shop #${shopId}: ${invalid.join(', ')}. No changes made.`)
    }
    targetIds = explicitIds
    console.log(`Targeting ${targetIds.length} explicitly listed product(s): ${targetIds.join(', ')}.`)
  } else {
    console.log('No --ids and no --all-in-shop given — report only, nothing selected for recovery.')
    console.log('Re-run with either:')
    console.log(`  --ids=<comma,separated,ids> --confirm`)
    console.log(`  --all-in-shop --confirm`)
    await sql.end()
    return
  }

  if (!confirm) {
    console.log('\n🛑 DRY RUN — no changes made. Add --confirm to actually reactivate these products.')
    await sql.end()
    return
  }

  const restored = await sql`
    UPDATE products
    SET active = TRUE, updated_at = NOW()
    WHERE id = ANY(${targetIds}) AND shop_id = ${shopId} AND active = FALSE
    RETURNING id, name
  `
  console.log(`\n✅ Reactivated ${restored.length} product(s) in shop #${shopId}:`)
  for (const p of restored) console.log(`  #${p.id}  "${p.name}"`)

  await sql.end()
}

main().catch(err => {
  console.error('❌ Recovery failed:', err)
  process.exit(1)
})
