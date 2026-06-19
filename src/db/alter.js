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

  await sql.end()
}

alter().catch(err => {
  console.error('❌ Alter failed:', err)
  process.exit(1)
})
