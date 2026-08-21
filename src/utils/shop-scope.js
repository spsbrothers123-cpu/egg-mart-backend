// Central shop-authorization helpers.
//
// The whole multi-shop model rests on one rule: authorization is always
// derived from the authenticated JWT (req.user), never from a shopId/userId
// supplied by the client. Every route that reads or writes shop-scoped data
// should go through these helpers instead of re-deriving the logic inline.

// Returns the array of shop ids owned by an admin. Cheap query, called per
// request — fine at this scale; swap for a cached lookup if it ever becomes
// a hot path.
export async function getOwnedShopIds(sql, adminId) {
  const rows = await sql`SELECT id FROM shops WHERE admin_id = ${adminId}`
  return rows.map(r => r.id)
}

// Throws 403/404 (via fastify.httpErrors) unless `shopId` is owned by
// `adminId`. Use this before letting an admin create/read/write anything
// scoped to a specific shop.
export async function assertShopOwnedByAdmin(fastify, sql, adminId, shopId) {
  const [shop] = await sql`SELECT id FROM shops WHERE id = ${shopId} AND admin_id = ${adminId}`
  if (!shop) {
    throw fastify.httpErrors.forbidden('That shop does not belong to your account')
  }
  return shop
}

// Resolves the requesting user's authorized shop scope.
//   - cashier -> the single shop they're assigned to (from the JWT)
//   - admin   -> every shop they own
// Returns { role, shopIds: number[] }. An admin with zero shops yet gets an
// empty array (not "all shops") — callers must treat that as "sees nothing"
// rather than accidentally falling through to an unscoped query.
export async function resolveShopScope(sql, req) {
  if (req.user.role === 'admin') {
    const shopIds = await getOwnedShopIds(sql, req.user.id)
    return { role: 'admin', shopIds }
  }
  // cashier
  return { role: 'cashier', shopIds: req.user.shop_id ? [req.user.shop_id] : [] }
}

// Convenience helper for admin-write routes (create product/customer/
// supplier/expense) where the frontend doesn't yet have a shop-picker UI
// and simply doesn't send a shop_id at all. Mirrors the same
// "unambiguous-or-refuse" pattern used for cashier signup: if the admin
// owns exactly one shop, default to it transparently; otherwise the
// request must specify which shop explicitly, since guessing would risk
// writing data into the wrong shop.
export async function resolveAdminShopId(fastify, sql, adminId, providedShopId) {
  if (providedShopId) {
    await assertShopOwnedByAdmin(fastify, sql, adminId, providedShopId)
    return providedShopId
  }
  const shopIds = await getOwnedShopIds(sql, adminId)
  if (shopIds.length === 1) return shopIds[0]
  if (shopIds.length === 0) {
    throw fastify.httpErrors.badRequest('Create a shop first (POST /api/shops) before adding data')
  }
  throw fastify.httpErrors.badRequest('shop_id is required — you own more than one shop')
}

// Convenience preHandler-style check for cashier routes that need an
// assigned shop to function (opening a session, billing, etc). Cashiers
// created before this migration ran (or mid-transfer) may briefly have no
// shop_id — fail loudly rather than silently writing shop_id = NULL rows.
export function requireCashierShop(fastify, req) {
  if (req.user.role === 'cashier' && !req.user.shop_id) {
    throw fastify.httpErrors.badRequest('Your account is not assigned to a shop yet — contact your admin')
  }
}
