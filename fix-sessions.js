import 'dotenv/config'
import sql from './src/config/db.js'

await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS drawer_counts JSONB`
console.log('✅ drawer_counts column added')
await sql.end()