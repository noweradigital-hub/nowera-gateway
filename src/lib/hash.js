import { createHash } from 'node:crypto';

const sha256 = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

// Already-hashed values are passed through untouched, so a site can hash PII
// itself and never send us plaintext.
const isHashed = (v) => typeof v === 'string' && /^[a-f0-9]{64}$/i.test(v);

const strip = (v) => String(v).trim().toLowerCase();

// Meta matches a phone number only in its international form, so a national one
// (0905 123 456) needs its country's code. Mirrors nowera_capi_phone_digits().
const CALLING_CODES = {
  SK: '421', CZ: '420', PL: '48', HU: '36', AT: '43', DE: '49', CH: '41', SI: '386', HR: '385',
  RO: '40', UA: '380', IT: '39', FR: '33', GB: '44', IE: '353', NL: '31', BE: '32', ES: '34',
};
const TRUNK_PREFIXES = { HU: '06', IT: '', ES: '' }; // default '0'
const CODES_LONGEST_FIRST = Object.entries(CALLING_CODES).sort((a, b) => b[1].length - a[1].length);

export function phoneDigits(value, country) {
  const raw = String(value).trim();
  let digits = raw.replace(/\D/g, '');
  if (!digits) return '';

  // Written internationally: +421…, 00421…, or the common +421 0905… slip.
  if (raw.startsWith('+') || digits.startsWith('00')) {
    digits = digits.replace(/^0+/, '');
    const hit = CODES_LONGEST_FIRST.find(([, code]) => digits.startsWith(code));
    if (hit) {
      const [iso, code] = hit;
      const trunk = TRUNK_PREFIXES[iso] ?? '0';
      const rest = digits.slice(code.length);
      if (trunk && rest.startsWith(trunk)) digits = code + rest.slice(trunk.length);
    }
    return digits;
  }

  const iso = typeof country === 'string' && /^[a-z]{2}$/i.test(country.trim()) ? country.trim().toUpperCase() : null;
  const code = iso ? CALLING_CODES[iso] : null;
  if (!code) return digits.replace(/^0+/, ''); // no country we have a rule for

  // Typed with the country code but without the plus: 421905123456.
  if (digits.startsWith(code) && digits.length >= code.length + 8) return digits;
  const trunk = TRUNK_PREFIXES[iso] ?? '0';
  if (trunk && digits.startsWith(trunk)) digits = digits.slice(trunk.length);
  return code + digits;
}
const alphaOnly = (v) => strip(v).replace(/[^\p{L}]/gu, '');

// Meta's normalization rules, per user_data parameter.
// https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters
const normalizers = {
  em: (v) => strip(v),
  ph: (v, country) => phoneDigits(v, country),
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
export function hashField(key, value, country) {
  if (value === undefined || value === null || value === '') return null;
  if (isHashed(value)) return String(value).toLowerCase();
  const normalize = normalizers[key];
  if (!normalize) return null;
  const normalized = normalize(value, country);
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
    const hashed = hashField(key, raw[key], raw.country);
    if (hashed) out[key] = [hashed];
  }
  if (context.ip) out.client_ip_address = context.ip;
  if (context.userAgent) out.client_user_agent = context.userAgent;
  if (context.fbp) out.fbp = context.fbp;
  if (context.fbc) out.fbc = context.fbc;
  return out;
}

export { sha256 };
