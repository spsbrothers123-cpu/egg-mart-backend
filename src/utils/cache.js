// Minimal in-process TTL cache. This is intentionally simple (a Map, not
// Redis) because the app runs as a single Fastify instance — if it's ever
// scaled to multiple instances, swap this for a shared cache (Redis) using
// the same get/set/invalidate interface so call sites don't need to change.
const store = new Map() // key -> { value, expiresAt }

export function cacheGet(key) {
  const entry = store.get(key)
  if (!entry) return undefined
  if (Date.now() > entry.expiresAt) {
    store.delete(key)
    return undefined
  }
  return entry.value
}

export function cacheSet(key, value, ttlMs = 30_000) {
  store.set(key, { value, expiresAt: Date.now() + ttlMs })
}

// Invalidate every cache key starting with `prefix`. Call this whenever
// data that a cached response depends on changes (e.g. a product write
// should invalidate the 'products:' and 'dashboard:' prefixes).
export function cacheInvalidate(prefix) {
  for (const key of store.keys()) {
    if (key.startsWith(prefix)) store.delete(key)
  }
}

export async function cached(key, ttlMs, fn) {
  const hit = cacheGet(key)
  if (hit !== undefined) return hit
  const value = await fn()
  cacheSet(key, value, ttlMs)
  return value
}
