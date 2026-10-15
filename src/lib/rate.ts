const hits = new Map<string, number[]>();
export function allow(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const arr = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { hits.set(key, arr); return false; }
  arr.push(now); hits.set(key, arr); return true;
}
setInterval(() => hits.clear(), 10 * 60_000).unref(); // crude cleanup, fine for MVP