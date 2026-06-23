import postgres from 'postgres'
import 'dotenv/config'

const sql = postgres(process.env.DATABASE_URL, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 30,
  ssl: 'require',
  onnotice: () => {},
})

export default sql
