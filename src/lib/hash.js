import { createHash } from 'node:crypto';

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

// Already-hashed values are passed through untouched, so a site can hash PII
// itself and never send us plaintext.
const isHashed = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);

const strip = (v) => String(v).trim().toLowerCase();
const alphaOnly = (v) => strip(v).replace(/[^\p{L}]/gu, '');

// Meta's normalization rules, per user_data parameter.
// https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
const normalizers = {
  em: (v) => strip(v),
  ph: (v) => String(v).replace(/\D/g, '').replace(/^0+/, ''),
  fn: alphaOnly,
  ln: alphaOnly,
  ct: (v) => strip(v).replace(/[^\p{L}]/gu, ''),
  st: (v) => strip(v).replace(/[^\p{L}]/gu, '').slice(0, 2),
  zp: (v) => strip(v).replace(/\s/g, ''),
  country: (v) => strip(v).slice(0, 2),
  ge: (v) => (strip(v).startsWith('f') ? 'f' : strip(v).startsWith('m') ? 'm' : ''),
  db: (v) => String(v).replace(/\D/g, '').slice(0, 8),
  external_id: (v) => String(v).trim(),
};

/**
 * Normalize then SHA-256 a single Meta user_data field.
 * Returns null for empty input so callers can drop the key entirely —
 * Meta counts an empty-string parameter against Event Match Quality.
 */
export function hashField(key, value) {
  if (value === undefined || value === null || value === '') return null;
  if (isHashed(value)) return String(value).toLowerCase();
  const normalize = normalizers[key];
  if (!normalize) return null;
  const normalized = normalize(value);
  if (!normalized) return null;
  return sha256(normalized);
}

/**
 * Build Meta's user_data object. `raw` may hold plaintext or pre-hashed values.
 * Non-PII fields (ip, user agent, click ids) are passed through unhashed —
 * Meta requires those in the clear.
 */
export function buildUserData(raw = {}, context = {}) {
  const out = {};
  for (const key of Object.keys(normalizers)) {
    const hashed = hashField(key, raw[key]);
    if (hashed) out[key] = [hashed];
  }
  if (context.ip) out.client_ip_address = context.ip;
  if (context.userAgent) out.client_user_agent = context.userAgent;
  if (context.fbp) out.fbp = context.fbp;
  if (context.fbc) out.fbc = context.fbc;
  return out;
}

export { sha256 };
