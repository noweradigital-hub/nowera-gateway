import { randomBytes, randomUUID } from 'node:crypto';

export const newEventId = () => randomUUID();

/**
 * Meta browser-id cookie: fb.<subdomainIndex>.<createdAt>.<random>
 * We always set it server-side (HttpOnly) so Safari's ITP cannot cap it at 7 days
 * the way it does for a cookie written by the pixel's JavaScript.
 */
export function newFbp(now = Date.now()) {
  const rand = BigInt('0x' + randomBytes(8).toString('hex')) % 10_000_000_000n;
  return `fb.1.${now}.${rand}`;
}

/** Meta click-id cookie, derived from the fbclid query parameter. */
export function newFbc(fbclid, now = Date.now()) {
  if (!fbclid) return null;
  return `fb.1.${now}.${fbclid}`;
}

// Meta counts a click id as valid for 90 days after the click; an older one is
// reported as "expired fbclid in fbc" and hurts attribution. A cookie kept alive
// past that (our keeper rewrites its expiry daily) must not be sent again.
export const FBC_MAX_AGE_MS = 90 * 86400_000;
// The click id may carry a suffix the pixel or Meta's parameter builder appends.
const FBC_FORMAT = /^fb\.\d\.(\d{10,13})\.([A-Za-z0-9._-]{1,700})$/;

/** The click time (ms) and fbclid of an fbc value, or null when it is not one. */
export function fbcParts(value) {
  const m = FBC_FORMAT.exec(String(value ?? ''));
  if (!m) return null;
  const ts = Number(m[1]) * (m[1].length <= 10 ? 1000 : 1);
  return { ts, fbclid: m[2] };
}

/** Whether Meta still accepts this fbc: well formed, not from the future, under 90 days old. */
export function fbcFresh(value, now = Date.now()) {
  const p = fbcParts(value);
  return Boolean(p) && p.ts <= now + 86400_000 && now - p.ts < FBC_MAX_AGE_MS;
}

/** Milliseconds this fbc stays valid, for the cookie that carries it. */
export function fbcRemainingMs(value, now = Date.now()) {
  const p = fbcParts(value);
  return p ? Math.max(0, p.ts + FBC_MAX_AGE_MS - now) : 0;
}

/**
 * The fbc to send. A click id on the landing URL is a new ad click and wins over
 * a stored one, unless the stored one is that same click. A stored fbc is used
 * only while Meta still accepts it; an expired one gives null, never a resend.
 */
export function resolveFbc({ cookie, fbclid, url, now = Date.now() }) {
  let id = fbclid;
  if (!id && url) {
    try { id = new URL(url).searchParams.get('fbclid'); } catch { /* malformed url */ }
  }
  if (id && /^[A-Za-z0-9._-]{1,700}$/.test(id)) {
    const stored = fbcParts(cookie);
    // The pixel may append its own suffix after the fbclid.
    const sameClick = stored && (stored.fbclid === id || stored.fbclid.startsWith(`${id}.`));
    // The same click keeps the time it happened, as Meta's own builder does;
    // reopening an old ad link is not a new click and must not look like one.
    if (sameClick) return fbcFresh(cookie, now) ? cookie : null;
    return newFbc(id, now);
  }
  return cookie && fbcFresh(cookie, now) ? cookie : null;
}
