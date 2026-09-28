import { config } from '../config.js';

/**
 * Ask Meta whether the stored token may send to the dataset: read the dataset's
 * own name with it. The token travels in the Authorization header, never in the
 * URL. Returns { ok, name } or { ok: false, error } in words for the dashboard.
 */
export async function verifyMeta(settings, fetchImpl = fetch) {
  const { dataset_id: id, access_token: token } = settings || {};
  if (!id || !token) return { ok: false, error: 'chýba dataset alebo token' };
  let res;
  try {
    res = await fetchImpl(`https://graph.facebook.com/${config.metaApiVersion}/${encodeURIComponent(id)}?fields=id,name`, {
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
    100: 'dataset neexistuje alebo k nemu token nemá prístup',
    200: 'token nemá oprávnenie na tento dataset',
    2635: 'zastaraná verzia API',
  };
  return { ok: false, error: reasons[code] || (body?.error?.message ? String(body.error.message).slice(0, 160) : `HTTP ${res.status}`) };
}
