/**
 * Fixed-window counter per key, kept in memory. One gateway process runs, and a
 * restart forgets the counts: good enough to stop a flood or a password guesser,
 * not meant for accounting.
 */
export function createLimiter({ windowMs, max }) {
  let windowStart = Date.now();
  let counts = new Map();

  const roll = (now) => {
    if (now - windowStart >= windowMs) {
      windowStart = now;
      counts = new Map();
    }
  };

  return {
    /** Count one hit; false once the key has gone over the limit in this window. */
    hit(key, now = Date.now()) {
      roll(now);
      const n = (counts.get(key) || 0) + 1;
      counts.set(key, n);
      return n <= max;
    },
    /** Whether the key is already over the limit, without counting a hit. */
    blocked(key, now = Date.now()) {
      roll(now);
      return (counts.get(key) || 0) >= max;
    },
    reset(key) {
      counts.delete(key);
    },
  };
}
