import 'dotenv/config'
import bcrypt from 'bcryptjs'
import sql from '../config/db.js'

async function seed() {
  console.log('🌱 Seeding database...')

  // Users
  const adminHash   = await bcrypt.hash('admin123', 10)
  const cashierHash = await bcrypt.hash('1234', 10)

  await sql`
    INSERT INTO users (name, username, password, role) VALUES
      ('Admin',         'admin',   ${adminHash},   'admin'),
      ('Cashier One',   'cashier', ${cashierHash}, 'cashier')
    ON CONFLICT (username) DO NOTHING
  `
  console.warn(
    '⚠️  Seeded with default credentials (admin/admin123, cashier/1234). ' +
    'These do NOT meet the app\'s own password policy and are for local/dev use only — ' +
    'rotate both passwords before going to production.'
  )

  // Categories — full set matching the frontend
  await sql`
    INSERT INTO categories (name, slug) VALUES
      ('Eggs',       'eggs'),
      ('Masala',     'masala'),
      ('Batter',     'batter'),
      ('Box',        'box'),
      ('Household',  'household'),
      ('Other',      'other')
    ON CONFLICT (slug) DO NOTHING
  `

  const cats = await sql`SELECT id, slug FROM categories`
  const catMap = Object.fromEntries(cats.map(c => [c.slug, c.id]))

  // All 33 products matching the frontend data/index.js
  const products = [
    // Eggs
    { name: 'White Egg',              pack: '1 Pc',   price: 6.50,  stock: 100, category: 'eggs',      emoji: '🥚', sku: 'WE-001' },
    { name: 'Country Egg',            pack: '1 Pc',   price: 12,    stock: 100, category: 'eggs',      emoji: '🥚', sku: 'CE-001' },
    { name: 'Country Egg Box',        pack: '1 Pc',   price: 100,   stock: 50,  category: 'box',       emoji: '📦', sku: 'CEB-01' },
    { name: 'Double Yellow Egg',      pack: '1 Pc',   price: 8.50,  stock: 100, category: 'eggs',      emoji: '🥚', sku: 'DYE-01' },
    { name: 'Kada Egg (Box)',         pack: '1 Pc',   price: 60,    stock: 30,  category: 'box',       emoji: '📦', sku: 'KEB-01' },
    { name: 'Bullet Egg',            pack: '1 Pc',   price: 6,     stock: 100, category: 'eggs',      emoji: '🥚', sku: 'BUE-01' },
    { name: 'Duck Egg',              pack: '1 Pc',   price: 15,    stock: 50,  category: 'eggs',      emoji: '🥚', sku: 'DKE-01' },
    { name: 'Damage Egg',            pack: '1 Pc',   price: 4,     stock: 50,  category: 'eggs',      emoji: '🥚', sku: 'DAE-01' },
    // Masalas
    { name: 'Aachi Chicken 65 Masala',   pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AC65-1' },
    { name: 'Aachi Chicken Masala',      pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'ACM-01' },
    { name: 'Aachi Chilli Powder',       pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'ACP-01' },
    { name: 'Aachi Fish Curry Masala',   pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AFCM-1' },
    { name: 'Aachi Fish Fry Masala',     pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AFFM-1' },
    { name: 'Aachi Garam Masala',        pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AGM-01' },
    { name: 'Aachi Kolambu Masala (50g)',pack: '1 Pc',   price: 20,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AKM-01' },
    { name: 'Aachi Mutton Masala',       pack: '1 Pc',   price: 10,  stock: 100, category: 'masala', emoji: '🌶️', sku: 'AMM-01' },
    { name: 'Chicken 65 Masala 100g',    pack: '1 Pc',   price: 35,  stock: 50,  category: 'masala', emoji: '🌶️', sku: 'C65-01' },
    { name: 'Chicken Masala 100g',       pack: '1 Pc',   price: 70,  stock: 50,  category: 'masala', emoji: '🌶️', sku: 'CM100-1' },
    // Batter
    { name: 'Balaji Batter 1kg',     pack: '1 Pc',   price: 45,  stock: 50,  category: 'batter',    emoji: '🫙', sku: 'BB1KG-1' },
    { name: 'Balaji Batter 1/2kg',   pack: '1 Pc',   price: 23,  stock: 50,  category: 'batter',    emoji: '🫙', sku: 'BB500-1' },
    // Box / Tray
    { name: 'Egg Box 12',            pack: '1 Pc',   price: 70,  stock: 100, category: 'box',       emoji: '📦', sku: 'EB12-01' },
    { name: 'Egg Box 6',             pack: '1 Pc',   price: 50,  stock: 100, category: 'box',       emoji: '📦', sku: 'EB6-001' },
    { name: 'Egg Plastic Tray 12',   pack: '1 Pc',   price: 12,  stock: 100, category: 'box',       emoji: '📦', sku: 'EPT12-1' },
    { name: 'Egg Plastic Tray 6',    pack: '1 Pc',   price: 6,   stock: 100, category: 'box',       emoji: '📦', sku: 'EPT6-01' },
    { name: 'Egg Cardboard Tray',    pack: '1 Pc',   price: 5,   stock: 200, category: 'box',       emoji: '📦', sku: 'ECT-001' },
    { name: 'Egg Plastic Tray',      pack: '1 Pc',   price: 50,  stock: 100, category: 'box',       emoji: '📦', sku: 'EPT-001' },
    // Household
    { name: 'Floor Mat Big',         pack: '1 Pc',   price: 180, stock: 20,  category: 'household', emoji: '🪣', sku: 'FMB-001' },
    { name: 'Floor Mat Small',       pack: '1 Pc',   price: 60,  stock: 30,  category: 'household', emoji: '🪣', sku: 'FMS-001' },
    // Other
    { name: 'Garlic',                pack: '1 kg',   price: 150, stock: 30,  category: 'other',     emoji: '🧄', sku: 'GAR-001' },
    { name: 'Hatsun Cup Curd 200g',  pack: '1 Pc',   price: 25,  stock: 50,  category: 'other',     emoji: '🥛', sku: 'HCC-001' },
    { name: 'Hatsun Curd 110g',      pack: '1 Pc',   price: 10,  stock: 50,  category: 'other',     emoji: '🥛', sku: 'HC110-1' },
    { name: 'Country Sugar',         pack: '1 kg',   price: 70,  stock: 40,  category: 'other',     emoji: '🍬', sku: 'CSU-001' },
    { name: 'Coconut',              pack: '1 kg',   price: 70,  stock: 30,  category: 'other',     emoji: '🥥', sku: 'COC-001' },
  ]

  for (const p of products) {
    const catId = catMap[p.category]
    if (!catId) { console.warn(`⚠️  No category for ${p.name} (${p.category})`); continue }
    await sql`
      INSERT INTO products (name, pack, sku, price, stock, category_id, emoji)
      VALUES (${p.name}, ${p.pack}, ${p.sku}, ${p.price}, ${p.stock}, ${catId}, ${p.emoji})
      ON CONFLICT (sku) DO UPDATE SET
        name = EXCLUDED.name,
        pack = EXCLUDED.pack,
        price = EXCLUDED.price,
        stock = EXCLUDED.stock,
        emoji = EXCLUDED.emoji
    `
  }

  // Customers
  await sql`
    INSERT INTO customers (name, phone, credit_limit) VALUES
      ('Walk-in Customer', NULL,          0),
      ('Ravi Kumar',       '9876543210',  1000),
      ('Meena Devi',       '9123456789',  500),
      ('Suresh Raj',       '9988776655',  1500)
    ON CONFLICT DO NOTHING
  `

  // Suppliers
  await sql`
    INSERT INTO suppliers (name, contact, phone, products) VALUES
      ('Fresh Farm Co.',   'Rajesh K.', '9876541234', 'White & Brown Eggs'),
      ('Desi Egg Traders', 'Anand M.',  '9123457890', 'Desi Eggs'),
      ('Aqua Duck Farm',   'Priya S.',  '9988771234', 'Duck & Quail Eggs')
    ON CONFLICT DO NOTHING
  `

  // Sample expenses
  await sql`
    INSERT INTO expenses (category, amount, note, expense_date) VALUES
      ('Transport',  450,  'Delivery van fuel',  CURRENT_DATE),
      ('Labour',     600,  'Helper wages',        CURRENT_DATE - 1),
      ('Packaging',  300,  'Egg cartons',         CURRENT_DATE - 2),
      ('Utilities', 1200,  'Electricity bill',    CURRENT_DATE - 3)
    ON CONFLICT DO NOTHING
  `

  console.log('✅ Seed complete — 33 products seeded.')
  await sql.end()
}

seed().catch(err => {
  console.error('❌ Seed failed:', err)
  process.exit(1)
})
