-- Egg Mart POS — Phase 1 verification queries
-- Read-only. Run these after any backfill/recovery to confirm correctness.

-- 1. Correct admin owns the intended shop
SELECT s.id AS shop_id, s.name, s.location, s.admin_id, u.username AS admin_username
FROM shops s JOIN users u ON u.id = s.admin_id
ORDER BY s.admin_id, s.id;

-- 2. Products are attached to the intended shop (and no orphans remain)
SELECT shop_id, COUNT(*) FILTER (WHERE active) AS active_products,
       COUNT(*) FILTER (WHERE NOT active) AS inactive_products
FROM products GROUP BY shop_id ORDER BY shop_id;

SELECT COUNT(*) AS products_missing_shop FROM products WHERE shop_id IS NULL; -- expect 0

-- 3. Cashiers are attached to the intended shop
SELECT u.id, u.username, u.shop_id, s.name AS shop_name, s.admin_id
FROM users u LEFT JOIN shops s ON s.id = u.shop_id
WHERE u.role = 'cashier'
ORDER BY u.shop_id NULLS FIRST, u.id;

SELECT COUNT(*) AS cashiers_missing_shop FROM users WHERE role = 'cashier' AND shop_id IS NULL; -- expect 0

-- 4. Bills / customers remain accessible (none lost, none duplicated)
SELECT (SELECT COUNT(*) FROM bills) AS total_bills,
       (SELECT COUNT(*) FROM customers) AS total_customers;
-- Compare these counts to pre-change counts captured by diagnose.js — must be identical.

-- 5. No unrelated admin's data becomes accessible (cross-admin leak check)
SELECT b.id AS bill_id, b.shop_id AS bill_shop, s.admin_id AS shop_admin, c.shop_id AS cashier_shop
FROM bills b
JOIN shops s ON s.id = b.shop_id
LEFT JOIN users c ON c.id = b.cashier_id
WHERE c.shop_id IS NOT NULL AND c.shop_id != b.shop_id; -- expect 0 rows

-- 6. Every shop's cashiers actually belong to that shop's admin (no cross-admin cashier)
SELECT u.id AS cashier_id, u.shop_id, s.admin_id
FROM users u JOIN shops s ON s.id = u.shop_id
WHERE u.role = 'cashier'
ORDER BY s.admin_id; -- eyeball: each admin's cashiers only reference that admin's shops

-- 7. Duplicate shop check (same admin, same location twice)
SELECT admin_id, LOWER(location), COUNT(*) FROM shops
GROUP BY admin_id, LOWER(location) HAVING COUNT(*) > 1; -- expect 0 rows
