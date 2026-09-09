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

/** Accept an existing _fbc, otherwise derive one from ?fbclid= on the landing URL. */
export function resolveFbc({ cookie, fbclid, url }) {
  if (cookie) return cookie;
  let id = fbclid;
  if (!id && url) {
    try { id = new URL(url).searchParams.get('fbclid'); } catch { /* malformed url */ }
  }
  return newFbc(id);
}
