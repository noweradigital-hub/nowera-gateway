import { createHash } from 'node:crypto';
import { OPENAI_EVENTS } from '../lib/event-policy.js';

/**
 * OpenAI Ads Conversions API (https://developers.openai.com/ads/conversions-api).
 *
 * One event per request, under the same id px.js gives the OpenAI pixel: OpenAI
 * keeps the first copy of pixel id + event name + id and ignores the rest. Money
 * goes as an integer in the currency's minor unit (2599 for 25.99 EUR), so the
 * conversion is done here once, with checks, never in a site's own code.
 */

export const OPENAI_ENDPOINT = 'https://bzr.openai.com/v1/events';
// OpenAI refuses events older than 7 days or more than 10 minutes ahead.
const MAX_AGE_MS = 7 * 86400_000;
const OPAQUE = /^[\x21-\x7e]{1,1024}$/;
const HEX64 = /^[a-f0-9]{64}$/;

// ISO 4217 exponents that are not 2. Intl's own digits follow CLDR display
// habits (HUF and TWD shown without decimals), not ISO, so they are not used.
export const ISO_DIGITS = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0, RWF: 0, UGX: 0, UYI: 0,
  VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  CLF: 4, UYW: 4,
};
const KNOWN = new Set(typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('currency') : []);

/** Minor-unit digits of an ISO 4217 currency (EUR 2, JPY 0, BHD 3), or null when unknown. */
export function minorDigits(currency) {
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) return null;
  if (Object.hasOwn(ISO_DIGITS, currency)) return ISO_DIGITS[currency];
  return KNOWN.size === 0 || KNOWN.has(currency) ? 2 : null;
}

/**
 * An amount in major units (25.99) as OpenAI's integer minor units (2599), or
 * null when it cannot be one: not a finite number, negative, or a currency we
 * cannot place. Strings like "25,99 €" are refused, never guessed at.
 */
export function minorAmount(value, currency) {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'number' ? value : (/^-?\d+(\.\d+)?$/.test(String(value).trim()) ? Number(value) : NaN);
  const digits = minorDigits(currency);
  if (!Number.isFinite(n) || n < 0 || digits === null) return null;
  return Math.round(n * 10 ** digits);
}

// Country codes as the gateway stores them: hashed, like everything in `user`.
// OpenAI wants the plain code, and there are only 676 two-letter ones.
const COUNTRY_BY_HASH = new Map();
for (let a = 97; a <= 122; a += 1) {
  for (let b = 97; b <= 122; b += 1) {
    const code = String.fromCharCode(a, b);
    COUNTRY_BY_HASH.set(createHash('sha256').update(code).digest('hex'), code.toUpperCase());
  }
}

const list = (v) => (typeof v === 'string' && HEX64.test(v) ? [v] : undefined);

/** OpenAI's user object from the event's hashed contact data and its request context. */
export function buildUser(event) {
  const u = event.user || {};
  const c = event.context || {};
  const user = {
    emails_sha256: list(u.em),
    phone_numbers_sha256: list(u.ph),
    first_names_sha256: list(u.fn),
    last_names_sha256: list(u.ln),
    external_ids_sha256: list(u.external_id),
  };
  const country = COUNTRY_BY_HASH.get(u.country);
  if (country) user.countries = [country];
  if (typeof c.ip === 'string' && c.ip) user.ip_address = c.ip;
  if (typeof c.userAgent === 'string' && c.userAgent) user.user_agent = c.userAgent;
  if (typeof c.obref === 'string' && OPAQUE.test(c.obref)) user.obref = c.obref;
  for (const k of Object.keys(user)) if (user[k] === undefined) delete user[k];
  return user;
}

function buildContents(props, currency) {
  if (!Array.isArray(props.contents)) return undefined;
  const out = props.contents.slice(0, 100).map((c = {}) => {
    const item = { id: String(c.id ?? c.item_id ?? '') };
    const name = c.title ?? c.item_name ?? c.name;
    if (name) item.name = String(name).slice(0, 500);
    item.content_type = props.content_type === 'home_listing' ? 'home_listing' : 'product';
    const qty = Number(c.quantity ?? 1);
    if (Number.isInteger(qty) && qty > 0) item.quantity = qty;
    const price = minorAmount(c.item_price ?? c.price, currency);
    if (price !== null) { item.amount = price; item.currency = currency; }
    return item;
  }).filter((item) => item.id);
  return out.length ? out : undefined;
}

/** OpenAI's data object for one of our events. */
export function buildData(event) {
  const [, type] = OPENAI_EVENTS[event.event_name];
  const props = event.properties || {};
  const currency = typeof props.currency === 'string' ? props.currency.trim().toUpperCase() : null;
  const data = { type };
  const amount = minorAmount(props.value, currency);
  if (amount !== null) { data.amount = amount; data.currency = currency; }
  if (type === 'contents') {
    const contents = buildContents(props, currency);
    if (contents) data.contents = contents;
  }
  if (type === 'plan_enrollment' && props.plan_id) data.plan_id = String(props.plan_id).slice(0, 200);
  return data;
}

/** The request body for one event, or null when OpenAI has no event for it. */
export function buildPayload(event, settings = {}, now = Date.now()) {
  const mapped = OPENAI_EVENTS[event.event_name];
  if (!mapped) return null;
  const out = {
    id: String(event.event_id),
    type: mapped[0],
    timestamp_ms: Math.min(Math.max(event.event_time * 1000, now - MAX_AGE_MS + 60_000), now),
    action_source: 'web',
    source_url: event.event_source_url || undefined,
    user: buildUser(event),
    data: buildData(event),
  };
  const oppref = event.context?.oppref;
  if (typeof oppref === 'string' && OPAQUE.test(oppref)) out.oppref = oppref;
  if (!out.source_url) delete out.source_url;
  const body = { events: [out], integration_source: 'nowera-signals' };
  // A test from the dashboard is only validated, never recorded.
  if (settings.validate_only || event.test) body.validate_only = true;
  return body;
}

export async function send(event, settings, fetchImpl = fetch) {
  const { pixel_id: pixelId, api_key: apiKey } = settings || {};
  if (!pixelId || !apiKey) return { ok: false, retryable: false, error: 'openai: pixel_id or api_key missing' };
  const body = buildPayload(event, settings);
  if (!body) return { ok: true, response: 'skipped: no OpenAI event for this one' };
  if (!body.events[0].source_url) return { ok: false, retryable: false, error: 'openai: chýba adresa stránky (source_url)' };
  if (event.event_time * 1000 < Date.now() - MAX_AGE_MS) {
    return { ok: false, retryable: false, error: 'openai: udalosť je staršia ako 7 dní' };
  }

  let res;
  try {
    res = await fetchImpl(`${OPENAI_ENDPOINT}?pid=${encodeURIComponent(pixelId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: `openai: ${err.message}` };
  }
  const text = await res.text();
  if (res.ok) return { ok: true, response: text.slice(0, 500) || String(res.status) };
  // A refused key or a malformed event stays refused; throttling and outages pass.
  return {
    ok: false,
    retryable: res.status >= 500 || res.status === 429 || res.status === 408,
    error: `openai ${res.status}: ${text.slice(0, 400)}`,
  };
}

/** Whether the stored pixel and key are accepted: one validate-only event, nothing recorded. */
export async function verify(settings, fetchImpl = fetch) {
  const { pixel_id: pixelId, api_key: apiKey } = settings || {};
  if (!pixelId) return { ok: false, error: 'chýba pixel ID' };
  if (!apiKey) return { ok: false, error: 'API kľúč nie je vyplnený, meria len pixel v prehliadači' };
  const now = Date.now();
  const body = {
    validate_only: true,
    integration_source: 'nowera-signals',
    events: [{
      id: `nwr-verify-${now}`, type: 'page_viewed', timestamp_ms: now, action_source: 'web',
      source_url: 'https://signals.nwra.sk/verify', user: { user_agent: 'nowera-signals-verify' }, data: { type: 'contents' },
    }],
  };
  let res;
  try {
    res = await fetchImpl(`${OPENAI_ENDPOINT}?pid=${encodeURIComponent(pixelId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return { ok: false, error: `OpenAI neodpovedá (${err.message})` };
  }
  if (res.ok) return { ok: true, name: null };
  const text = (await res.text().catch(() => '')).slice(0, 160);
  const reasons = { 401: 'API kľúč je neplatný', 403: 'kľúč nemá prístup k tomuto pixelu', 404: 'pixel neexistuje alebo konverzie nie sú pre účet zapnuté' };
  return { ok: false, error: reasons[res.status] || `HTTP ${res.status}${text ? `: ${text}` : ''}` };
}
