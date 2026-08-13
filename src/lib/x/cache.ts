/** In-memory TTL cache.
 *
 *  Deliberately not on disk: serverless filesystems are read-only apart from
 *  an ephemeral /tmp, so the previous file cache could not work once deployed.
 *  A module-level map survives for the life of a warm instance, which is where
 *  most repeat traffic lands anyway.
 *
 *  For a cache shared across instances, swap the two functions below for a KV
 *  store (Vercel KV, Upstash); nothing else needs to change.
 */

type Entry = { value: unknown; expires: number };

const store = new Map<string, Entry>();

// Project accounts almost never change their avatar; results go stale quickly
export const TTL_PROJECT = 30 * 24 * 3600 * 1000;
export const TTL_IMPRESSIONS = 15 * 60 * 1000;

const MAX_ENTRIES = 500;

export function get<T>(namespace: string, key: string): T | null {
  const entry = store.get(`${namespace}:${key.toLowerCase()}`);
  if (!entry) return null;

  if (Date.now() > entry.expires) {
    store.delete(`${namespace}:${key.toLowerCase()}`);
    return null;
  }
  return entry.value as T;
}

export function set(
  namespace: string,
  key: string,
  value: unknown,
  ttl: number,
): void {
  // Bound the map so a long-lived instance cannot grow without limit
  if (store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest) store.delete(oldest);
  }
  store.set(`${namespace}:${key.toLowerCase()}`, {
    value,
    expires: Date.now() + ttl,
  });
}

/** Wipe every cached entry. Only affects this warm instance's memory - other
 *  instances (if any) keep their own copies until they expire naturally. */
export function clear(): void {
  store.clear();
}
