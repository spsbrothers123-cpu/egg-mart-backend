import crypto from 'node:crypto'

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

// ── Shop invites ────────────────────────────────────────────────────────
// Public cashier self-registration cannot derive shop ownership from a
// session (there isn't one yet), and it must NEVER derive it from
// client-supplied free text (shop name/location) — that's guessable and
// lets a stranger join any shop whose name they can find on a receipt or
// storefront sign. An invite code is an unguessable, single-use, expiring,
// server-validated token instead — the only thing that's ever trusted to
// answer "which shop does this signup belong to".

const INVITE_BYTES = 24 // 32 URL-safe base64 characters

export function generateInviteCode() {
  return crypto.randomBytes(INVITE_BYTES).toString('base64url')
}

// Creates an invite for a shop already verified to belong to the admin
// (call assertShopOwnedByAdmin first, or pass a shopId you've already
// checked). Retries once on the astronomically unlikely UNIQUE collision.
export async function createShopInvite(sql, { shopId, createdBy, expiresInHours = 24 }) {
  const code = generateInviteCode()
  const expiresAt = new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
  const [invite] = await sql`
    INSERT INTO shop_invites (shop_id, code, created_by, expires_at)
    VALUES (${shopId}, ${code}, ${createdBy}, ${expiresAt})
    RETURNING id, shop_id, code, expires_at, created_at
  `
  return invite
}

// Validates and consumes an invite code atomically inside the caller's
// transaction: locks the row, checks not-revoked / not-used / not-expired,
// and marks it used in the same statement so two concurrent signups racing
// on the same code can never both succeed (the row lock serializes them,
// and the second one sees used_at already set).
export async function consumeShopInvite(tx, code, usedByUserId) {
  const [invite] = await tx`
    SELECT id, shop_id, expires_at, used_at, revoked_at
    FROM shop_invites WHERE code = ${code} FOR UPDATE
  `
  if (!invite) return { error: 'Invalid invite code', statusCode: 400 }
  if (invite.revoked_at) return { error: 'This invite has been revoked', statusCode: 400 }
  if (invite.used_at) return { error: 'This invite has already been used', statusCode: 400 }
  if (invite.expires_at < new Date()) return { error: 'This invite has expired', statusCode: 400 }

  await tx`UPDATE shop_invites SET used_at = NOW(), used_by = ${usedByUserId} WHERE id = ${invite.id}`
  return { shopId: invite.shop_id }
}
