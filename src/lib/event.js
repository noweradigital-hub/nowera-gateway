import { newEventId } from './ids.js';
import { hashField, PHONE_COUNTRIES } from './hash.js';
import { minorDigits } from '../destinations/openai.js';

const MAX_AGE_SECONDS = 7 * 86400; // Meta rejects events older than 7 days
const EVENT_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const MAX_URL = 2048;

// Ad click ids that may sit in a landing page's address.
const AD_CLICK_PARAMS = ['fbclid', 'oppref'];

const PII_KEYS = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'ge', 'db', 'external_id'];

/** Long-form aliases so the WordPress plugin can send readable keys. */
const PII_ALIASES = {
  email: 'em', phone: 'ph', first_name: 'fn', last_name: 'ln',
  city: 'ct', state: 'st', zip: 'zp', gender: 'ge', date_of_birth: 'db',
};

/**
 * Contact details, hashed on arrival: what is stored in the queue and shown in
 * the dashboard is never readable, whichever way a site sent it. Values that
 * arrive hashed (the plugin and the loader send them so) pass through unchanged.
 *
 * A national phone number (0905 123 456) only matches with its country's calling
 * code. Forms and bookings on a site without WooCommerce send no country, so the
 * site's own country (the tenant setting) stands in, for the phone only: it is
 * never added to the event as the visitor's country.
 */
function pickUser(raw = {}, defaultCountry = null) {
  const plain = {};
  for (const [alias, key] of Object.entries(PII_ALIASES)) {
    if (raw[alias] !== undefined) plain[key] = raw[alias];
  }
  for (const key of PII_KEYS) {
    if (raw[key] !== undefined) plain[key] = raw[key];
  }
  const ownCountry = typeof plain.country === 'string' && /^[a-z]{2}$/i.test(plain.country.trim());
  const phoneIso = ownCountry ? plain.country : defaultCountry;
  const user = {};
  for (const [key, value] of Object.entries(plain)) {
    const hashed = hashField(key, value, key === 'ph' ? phoneIso : plain.country);
    if (hashed) user[key] = hashed;
  }
  return user;
}

/** A tenant's phone country setting: one of the countries with a calling-code rule, or null. */
export function phoneCountry(value) {
  const code = String(value ?? '').trim().toUpperCase();
  return PHONE_COUNTRIES.includes(code) ? code : null;
}

/**
 * Consent as sent by the loader or the plugin. Anything other than an explicit
 * boolean is treated as unknown, and an event with no consent block at all
 * keeps the pre-consent behaviour.
 */
function pickConsent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of ['marketing', 'statistics']) {
    if (typeof raw[key] === 'boolean') out[key] = raw[key];
  }
  return Object.keys(out).length ? out : null;
}

const HEX64 = /^[a-f0-9]{64}$/;

/** A signed-in customer's account, as the site hashes it: GA4's user_id. Never contact data. */
function pickAccount(raw) {
  return typeof raw === 'string' && HEX64.test(raw.toLowerCase()) ? raw.toLowerCase() : null;
}

/**
 * Contact data for Google (GA4 user-provided data, Google Ads enhanced
 * conversions), already hashed by the site under Google's own normalisation,
 * which differs from Meta's (E.164 phone with "+", Gmail dots removed).
 * Only SHA-256 digests are kept.
 */
function pickGoogleUser(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const key of ['sha256_email_address', 'sha256_phone_number']) {
    const list = (Array.isArray(raw[key]) ? raw[key] : [raw[key]])
      .filter((v) => typeof v === 'string' && HEX64.test(v.toLowerCase()))
      .map((v) => v.toLowerCase())
      .slice(0, 3);
    if (list.length) out[key] = list;
  }
  return Object.keys(out).length ? out : null;
}

/**
 * The referrer of the page the event happened on, cut to scheme, host and path:
 * a same-site referrer can carry order keys or search terms in its query string.
 */
function pickReferrer(raw) {
  if (typeof raw !== 'string' || !raw || raw.length > 2048) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  scrubUrl(url); // an e-mail address can sit in the path too
  return `${url.origin}${url.pathname}`;
}

// ---- personal data in page addresses ------------------------------------------

// Campaign and ad click parameters: kept whatever their name, as attribution
// needs them (only a value that is itself an e-mail address is redacted).
const ATTRIBUTION_PARAMS = new Set([
  ...AD_CLICK_PARAMS, 'obref', 'gclid', 'gbraid', 'wbraid', 'dclid', 'msclkid', 'ttclid', 'twclid', 'li_fat_id', '_gl',
]);

// Parameter names that carry contact details, credentials or one-time secrets,
// as whole words of the name (billing_email, your-phone, e-mail, api_key).
// `key` covers WooCommerce's order key (?key=wc_order_…), which opens the order.
const SENSITIVE_WORDS = new Set([
  'email', 'mail', 'phone', 'tel', 'telefon', 'mobile', 'mobil', 'msisdn',
  'firstname', 'lastname', 'surname', 'fullname',
  'token', 'key', 'apikey', 'password', 'pass', 'passwd', 'pwd', 'heslo', 'haslo', 'secret',
  'auth', 'authorization', 'session', 'sessionid', 'sid', 'otp', 'signature', 'login', 'username',
]);
// The same inside joined names (phonenumber, csrftoken, PHPSESSID, JSESSIONID).
const SENSITIVE_PARTS = ['email', 'phone', 'password', 'passwd', 'token', 'secret', 'session', 'sessid', 'first_name', 'last_name', 'full_name'];
// `code` alone is often a product or coupon code; on a sign-in callback it is a
// one-time authorisation code.
const AUTH_PATH = /(callback|oauth|auth|login|signin|sign-in|sso|verify)/i;
// An e-mail address, but not a retina image name (logo@2x.png).
const EMAIL = /[^\s@/?#&=:;,]+@[^\s@/?#&=:;,]+\.(?!(?:png|jpe?g|gif|webp|avif|svg|ico)\b)[a-z]{2,}/i;
export const REDACTED = 'redacted';

const decodePart = (text) => {
  try {
    return decodeURIComponent(text.replace(/\+/g, ' '));
  } catch {
    return text;
  }
};

function sensitiveName(name, authCallback) {
  const n = name.toLowerCase();
  if (n.startsWith('utm_') || ATTRIBUTION_PARAMS.has(n)) return false;
  if (n === 'code') return authCallback;
  if (SENSITIVE_PARTS.some((part) => n.includes(part))) return true;
  // camelCase names split into words too: resetKey, apiKey, userPass.
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().split(/[^a-z0-9]+/);
  return words.some((word) => SENSITIVE_WORDS.has(word));
}

/**
 * `a=1&b=2` without the parameters that must not be stored: sensitive names
 * removed, e-mail addresses in values redacted. Untouched pairs keep their exact
 * encoding. Returns null when nothing had to change.
 */
function cleanPairs(text, authCallback) {
  let changed = false;
  const kept = [];
  for (const pair of text.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const rawName = eq === -1 ? pair : pair.slice(0, eq);
    const name = decodePart(rawName);
    if (sensitiveName(name, authCallback) || EMAIL.test(name)) {
      changed = true;
    } else if (eq !== -1 && EMAIL.test(decodePart(pair.slice(eq + 1)))) {
      kept.push(`${rawName}=${REDACTED}`);
      changed = true;
    } else {
      kept.push(pair);
    }
  }
  return changed ? kept.join('&') : null;
}

/**
 * A fragment without personal data, or null when it needs no change: a token
 * list (#access_token=…&expires_in=…), a client-side route with its own query
 * (#/callback?code=…), an e-mail address in a route.
 */
function cleanFragment(fragment) {
  if (!fragment) return null;
  const q = fragment.indexOf('?');
  const bare = q === -1 && fragment.includes('=');
  const route = q === -1 ? (bare ? '' : fragment) : fragment.slice(0, q);
  const pairs = q === -1 ? (bare ? fragment : '') : fragment.slice(q + 1);
  const cleanRoute = route.split('/').map((s) => (EMAIL.test(decodePart(s)) ? REDACTED : s)).join('/');
  const cleanQuery = pairs ? cleanPairs(pairs, true) : null;
  if (cleanRoute === route && cleanQuery === null) return null;
  const query = cleanQuery ?? pairs;
  return `${cleanRoute}${query && route ? '?' : ''}${query}`;
}

/**
 * Remove personal data from a page address in place: sign-in details, e-mail
 * addresses in the path, sensitive query parameters (and the same in a fragment
 * such as #access_token=…). Returns whether anything changed.
 */
export function scrubUrl(url) {
  let changed = false;
  if (url.username || url.password) {
    url.username = '';
    url.password = '';
    changed = true;
  }
  const segments = url.pathname.split('/');
  if (segments.some((s) => EMAIL.test(decodePart(s)))) {
    url.pathname = segments.map((s) => (EMAIL.test(decodePart(s)) ? REDACTED : s)).join('/');
    changed = true;
  }
  const params = url.search.slice(1);
  const authCallback = AUTH_PATH.test(url.pathname) || /(^|&)state=/.test(params);
  const query = params ? cleanPairs(params, authCallback) : null;
  if (query !== null) {
    url.search = query ? `?${query}` : '';
    changed = true;
  }
  const hash = cleanFragment(url.hash.slice(1));
  if (hash !== null) {
    url.hash = hash ? `#${hash}` : '';
    changed = true;
  }
  return changed;
}

/**
 * The page an event happened on, without personal data in it (see scrubUrl). A
 * URL longer than any real page address is cut to scheme, host and path rather
 * than stored whole.
 */
function pickUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const value = raw.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const clean = scrubUrl(url) ? url.toString() : value;
  return clean.length <= MAX_URL ? clean : `${url.origin}${url.pathname}`.slice(0, MAX_URL);
}

// ---- money -----------------------------------------------------------------------

// Amounts in the event's currency; item prices sit in `contents` (Meta) or `items` (GA4).
const MONEY_FIELDS = ['value', 'value_net', 'tax', 'shipping', 'predicted_ltv'];
const ITEM_MONEY_FIELDS = ['item_price', 'price', 'price_net'];
// Far above any real order or price in any currency we serve, and below the
// things that land in a value field by mistake: timestamps, phone numbers.
export const MAX_AMOUNT = 1e9;
// A value this many times the items' sum is the items' sum in cents: shipping,
// discounts and VAT on net item prices move a real order by far less.
const CENTS_RATIO = [70, 250];

/**
 * A number from a site's amount: 49.9, "49.90", "70,74" (decimal comma),
 * "1 234,56", "1.234,56" or "1,234.56" (grouped). Anything else (a currency
 * sign, text, an ambiguous "1,234") is refused rather than guessed at.
 */
function parseAmount(text) {
  const t = text.trim();
  // "1,234" is 1.234 with a decimal comma or 1234 grouped the English way; no
  // price has three decimals, so it is refused rather than guessed.
  if (/^\d{1,3},\d{3}$/.test(t)) return NaN;
  if (/^\d+([.,]\d+)?$/.test(t)) return Number(t.replace(',', '.'));
  const m = /^(\d{1,3}(?:[ \u00a0\u202f]\d{3})+)(?:[.,](\d+))?$/.exec(t)
    || /^(\d{1,3}(?:\.\d{3})+)(?:,(\d+))?$/.exec(t)
    || /^(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?$/.exec(t);
  if (!m) return NaN;
  return Number(`${m[1].replace(/\D/g, '')}.${m[2] || '0'}`);
}

/** An amount as a number with `places` decimals, or null when it is not one (negative, absurd, text). */
export function moneyAmount(raw, places = 2) {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseAmount(raw) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > MAX_AMOUNT) return null;
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

/** An ISO 4217 currency code, upper-cased, or null. */
export function currencyCode(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return minorDigits(code) === null ? null : code;
}

const blank = (v) => v === undefined || v === null || v === '';

function cleanMoney(obj, key, places, warnings) {
  if (!(key in obj)) return;
  if (blank(obj[key])) {
    delete obj[key]; // says nothing; GA4 would read "" as 0
    return;
  }
  const amount = moneyAmount(obj[key], places);
  if (amount === null) {
    delete obj[key];
    warnings.add('money_invalid');
  } else {
    obj[key] = amount;
  }
}

/**
 * Whether `value` looks like the order in cents: about a hundred times what its
 * items cost. Only when every item has a price, so the sum is the whole order.
 */
export function looksLikeCents(props) {
  const items = Array.isArray(props.contents) && props.contents.length ? props.contents
    : Array.isArray(props.items) && props.items.length ? props.items : null;
  if (typeof props.value !== 'number' || !items) return false;
  let sum = 0;
  for (const item of items) {
    const price = item?.item_price ?? item?.price;
    const qty = item?.quantity === undefined || item?.quantity === null ? 1 : Number(item.quantity);
    if (typeof price !== 'number' || !Number.isFinite(qty) || qty <= 0) return false;
    sum += price * qty;
  }
  if (!(sum > 0)) return false;
  const ratio = props.value / sum;
  return ratio >= CENTS_RATIO[0] && ratio <= CENTS_RATIO[1];
}

/**
 * The event's custom data with its money checked: amounts become numbers rounded
 * to the currency's decimals (at least 2), a currency becomes an ISO code. A field
 * that is not a valid amount or currency is dropped, never the event; what was
 * wrong goes into `warnings`. A value that looks like cents is only flagged, as
 * rewriting it could be wrong too.
 */
function pickProperties(raw, warnings) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw || {};
  const props = { ...raw };
  if ('currency' in props) {
    const currency = currencyCode(props.currency);
    if (currency) props.currency = currency;
    else {
      if (!blank(props.currency)) warnings.add('currency_invalid');
      delete props.currency;
    }
  }
  const places = Math.max(2, minorDigits(props.currency) ?? 2);
  for (const key of MONEY_FIELDS) cleanMoney(props, key, places, warnings);
  for (const list of ['contents', 'items']) {
    if (!Array.isArray(props[list])) continue;
    props[list] = props[list].map((item) => {
      if (!item || typeof item !== 'object') return item;
      const out = { ...item };
      for (const key of ITEM_MONEY_FIELDS) cleanMoney(out, key, places, warnings);
      return out;
    });
  }
  if (looksLikeCents(props)) warnings.add('value_cents');
  return props;
}

/** An opaque identifier from a third party, passed on unchanged when it looks like one. */
function pickOpaque(raw) {
  return typeof raw === 'string' && /^[\x21-\x7e]{1,1024}$/.test(raw) ? raw : null;
}

/**
 * Turn whatever arrived on the wire into the canonical shape every destination
 * driver consumes. Throws on input we refuse to guess about.
 */
export function normalizeEvent(input, context) {
  const name = String(input.event_name || input.event || '').trim();
  if (!name) throw new Error('event_name is required');
  if (!/^[A-Za-z0-9_ ]{1,64}$/.test(name)) throw new Error('event_name has invalid characters');

  const rawId = input.event_id;
  const eventId = rawId === undefined || rawId === null || rawId === '' ? newEventId() : String(rawId);
  if (!EVENT_ID.test(eventId)) throw new Error('event_id must be 1-100 letters, digits or . _ : -');

  const nowSeconds = Math.floor(Date.now() / 1000);
  const claimedTime = Number(input.event_time);
  let eventTime = claimedTime || nowSeconds;
  // The browser stamps an event with its own clock. When it also says when it
  // sent the request, keep the delay it measured but put it on our clock — a
  // device whose clock is days out would otherwise look like a days-old event,
  // which is exactly what Meta reports as poor data freshness.
  const sentAt = Number(input.sent_at);
  if (Number.isFinite(claimedTime) && Number.isFinite(sentAt) && sentAt > 0) {
    eventTime = nowSeconds - Math.min(Math.max(sentAt - claimedTime, 0), MAX_AGE_SECONDS);
  }
  // Clocks on client machines drift; clamp rather than let the destination reject it.
  if (eventTime > nowSeconds + 60) eventTime = nowSeconds;
  if (eventTime < nowSeconds - MAX_AGE_SECONDS) eventTime = nowSeconds - MAX_AGE_SECONDS;

  const consent = pickConsent(input.consent);
  // Ad click ids are advertising identifiers: without marketing consent they do
  // not travel even inside the page address (GA4's page_location).
  const stripClicks = (url) => {
    if (!url || consent?.marketing !== false) return url;
    try {
      const u = new URL(url);
      for (const p of AD_CLICK_PARAMS) u.searchParams.delete(p);
      return u.toString().replace(/\?$/, '');
    } catch { return url; }
  };

  const warnings = new Set();
  const event = {
    event_name: name,
    event_id: eventId,
    event_time: eventTime,
    event_source_url: stripClicks(pickUrl(input.event_source_url) || pickUrl(input.url) || pickUrl(context.referer)),
    referrer_url: pickReferrer(input.referrer_url),
    action_source: input.action_source || context.actionSource || 'website',
    user: pickUser(input.user_data || input.user || {}, phoneCountry(context.defaultCountry)),
    consent,
    account_id: pickAccount(input.account_id),
    google_user: pickGoogleUser(input.google_user),
    properties: pickProperties(input.custom_data || input.properties || {}, warnings),
    context: {
      ip: context.ip,
      userAgent: context.userAgent,
      fbp: context.fbp || null,
      fbc: context.fbc || null,
      gaClientId: input.ga_client_id || context.gaClientId || null,
      gaSessionId: input.ga_session_id || context.gaSessionId || null,
      // OpenAI Ads: the ad click reference and the browser reference its pixel keeps.
      oppref: pickOpaque(context.oppref),
      obref: pickOpaque(context.obref),
    },
  };
  // Data that looked wrong (an amount in cents, a dropped price): kept with the
  // event so the dashboard can show it; the destinations never read it.
  if (warnings.size) event.warnings = [...warnings];
  return event;
}
