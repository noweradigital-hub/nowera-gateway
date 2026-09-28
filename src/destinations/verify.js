import { config } from '../config.js';

/**
 * Ask Meta whether the stored token is alive: read the token's own identity.
 * A Conversions API token made in Events Manager may send events to its dataset
 * without being allowed to read the dataset object, so the dataset itself is not
 * queried; whether it accepts events shows in the deliveries. The token travels
 * in the Authorization header, never in the URL.
 * Returns { ok, name } or { ok: false, error } in words for the dashboard.
 */
export async function verifyMeta(settings, fetchImpl = fetch) {
  const { dataset_id: id, access_token: token } = settings || {};
  if (!id || !token) return { ok: false, error: 'chýba dataset alebo token' };
  let res;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${config.metaApiVersion}/me?fields=id,name`, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return { ok: false, error: `Meta neodpovedá (${err.message})` };
  }
  let body = {};
  try { body = await res.json(); } catch { /* not json */ }
  if (res.ok && body.id) return { ok: true, name: body.name || null };
  const code = body?.error?.code;
  const reasons = {
    190: 'token je neplatný alebo expirovaný',
    102: 'token je neplatný alebo expirovaný',
    2635: 'zastaraná verzia API',
  };
  return { ok: false, error: reasons[code] || (body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}`) };
}
