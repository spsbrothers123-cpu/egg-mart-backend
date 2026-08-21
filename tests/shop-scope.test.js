import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  getOwnedShopIds,
  assertShopOwnedByAdmin,
  resolveShopScope,
  requireCashierShop,
} from '../src/utils/shop-scope.js'

// Minimal stand-in for the `postgres` tagged-template client. Ignores the
// actual SQL text (these are unit tests of the authorization *logic*, not
// of the queries themselves) and just returns whatever rows the test wired
// up for that call.
function mockSql(rows) {
  return async () => rows
}

// Minimal stand-in for fastify.httpErrors used by these helpers.
const fakeFastify = {
  httpErrors: {
    forbidden: (msg) => Object.assign(new Error(msg), { statusCode: 403 }),
    badRequest: (msg) => Object.assign(new Error(msg), { statusCode: 400 }),
  },
}

test('getOwnedShopIds returns the ids from the query result', async () => {
  const sql = mockSql([{ id: 1 }, { id: 2 }, { id: 3 }])
  const ids = await getOwnedShopIds(sql, 42)
  assert.deepEqual(ids, [1, 2, 3])
})

test('getOwnedShopIds returns an empty array for an admin with no shops', async () => {
  const sql = mockSql([])
  const ids = await getOwnedShopIds(sql, 42)
  assert.deepEqual(ids, [])
})

test('assertShopOwnedByAdmin resolves when the shop belongs to the admin', async () => {
  const sql = mockSql([{ id: 7 }])
  const shop = await assertShopOwnedByAdmin(fakeFastify, sql, 1, 7)
  assert.deepEqual(shop, { id: 7 })
})

test('assertShopOwnedByAdmin throws 403 when the shop does not belong to the admin', async () => {
  const sql = mockSql([]) // no row returned -> not owned (or doesn't exist)
  await assert.rejects(
    () => assertShopOwnedByAdmin(fakeFastify, sql, 1, 999),
    (err) => err.statusCode === 403
  )
})

test('resolveShopScope for an admin returns all owned shop ids', async () => {
  const sql = mockSql([{ id: 10 }, { id: 11 }])
  const scope = await resolveShopScope(sql, { user: { role: 'admin', id: 5 } })
  assert.equal(scope.role, 'admin')
  assert.deepEqual(scope.shopIds, [10, 11])
})

test('resolveShopScope for a cashier returns their single assigned shop', async () => {
  const sql = mockSql([]) // not queried for cashiers
  const scope = await resolveShopScope(sql, { user: { role: 'cashier', id: 9, shop_id: 4 } })
  assert.equal(scope.role, 'cashier')
  assert.deepEqual(scope.shopIds, [4])
})

test('resolveShopScope for a cashier with no shop yet returns an empty scope, not "all"', async () => {
  const sql = mockSql([])
  const scope = await resolveShopScope(sql, { user: { role: 'cashier', id: 9, shop_id: null } })
  assert.deepEqual(scope.shopIds, [])
})

test('requireCashierShop is a no-op for a cashier with a shop, and for admins', () => {
  assert.doesNotThrow(() => requireCashierShop(fakeFastify, { user: { role: 'cashier', shop_id: 3 } }))
  assert.doesNotThrow(() => requireCashierShop(fakeFastify, { user: { role: 'admin', shop_id: null } }))
})

test('requireCashierShop throws 400 for a cashier with no shop assigned', () => {
  assert.throws(
    () => requireCashierShop(fakeFastify, { user: { role: 'cashier', shop_id: null } }),
    (err) => err.statusCode === 400
  )
})
