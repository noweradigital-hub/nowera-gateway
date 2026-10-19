import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stripe webhooks for a tenant whose site we cannot change: a Checkout payment
 * reaches us even when the buyer never returns to the thank-you page.
 *
 * Stripe signs `<t>.<raw body>` with the endpoint's signing secret (whsec_…) and
 * sends `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>…]`. More than one v1 while
 * Stripe rolls the secret; v0 is a test signature and never accepted.
 */
export const STRIPE_TOLERANCE_SECONDS = 300;

function hmacHex(secret, payload) {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

function sameHex(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Null when the request is Stripe's, otherwise why not. */
export function verifyStripeSignature(rawBody, header, secrets, nowMs = Date.now()) {
  const keys = (Array.isArray(secrets) ? secrets : [secrets]).filter(Boolean);
  if (!keys.length) return 'stripe not configured';
  if (!header || typeof header !== 'string') return 'missing signature';

  let timestamp = null;
  const signatures = [];
  for (const part of header.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1' && /^[a-f0-9]{64}$/i.test(value)) signatures.push(value.toLowerCase());
  }
  if (!timestamp || !/^\d{1,12}$/.test(timestamp) || !signatures.length) return 'bad signature';
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > STRIPE_TOLERANCE_SECONDS) return 'stale request';

  const payload = `${timestamp}.${rawBody}`;
  for (const secret of keys) {
    const expected = hmacHex(secret, payload);
    if (signatures.some((s) => sameHex(expected, s))) return null;
  }
  return 'bad signature';
}

// Currencies Stripe counts in whole units (no cents): amount 500 JPY is 500, not 5.
const ZERO_DECIMAL = new Set([
  'bif', 'clp', 'djf', 'gnf', 'jpy', 'kmf', 'krw', 'mga', 'pyg', 'rwf',
  'ugx', 'vnd', 'vuv', 'xaf', 'xof', 'xpf',
]);
// Charged in three decimals; Stripe still requires the last digit to be 0.
const THREE_DECIMAL = new Set(['bhd', 'jod', 'kwd', 'omr', 'tnd']);

/** Stripe's integer amount in the currency's major unit. */
export function majorAmount(minor, currency) {
  const n = Number(minor);
  if (!Number.isFinite(n)) return null;
  const c = String(currency || '').toLowerCase();
  if (ZERO_DECIMAL.has(c)) return n;
  if (THREE_DECIMAL.has(c)) return Math.round(n) / 1000;
  return Math.round(n) / 100;
}

/** The webhook events that mean "this Checkout is paid". */
const PAID_EVENTS = new Set(['checkout.session.completed', 'checkout.session.async_payment_succeeded']);

/**
 * The paid Checkout this webhook reports, in our terms, or null for anything we
 * do not turn into a Purchase (other event types, unpaid or subscription
 * sessions, sessions without an email). Plaintext email stays here: the caller
 * hashes it before storing anything.
 */
export function paidCheckout(event) {
  if (!event || typeof event !== 'object' || !PAID_EVENTS.has(event.type)) return null;
  const s = event.data?.object;
  if (!s || s.object !== 'checkout.session') return null;
  if (s.payment_status !== 'paid') return null; // 'unpaid' waits for async_payment_succeeded
  if (s.mode && s.mode !== 'payment') return null; // subscriptions renew without a buyer on the site

  const email = String(s.customer_details?.email || s.customer_email || '').trim();
  const currency = String(s.currency || '').toUpperCase();
  const value = majorAmount(s.amount_total, s.currency);
  if (!s.id || !/^[A-Za-z0-9_]{1,90}$/.test(s.id) || !currency || value === null) return null;

  const meta = s.metadata && typeof s.metadata === 'object' ? s.metadata : {};
  const orderRef = String(meta.order_id || meta.order_number || s.client_reference_id || '').slice(0, 100) || null;
  const paidAt = Number(event.created) || Number(s.created) || Math.floor(Date.now() / 1000);

  return {
    sessionId: s.id,
    stripeEventId: typeof event.id === 'string' ? event.id.slice(0, 100) : null,
    livemode: event.livemode === true,
    email: email || null,
    value,
    currency,
    orderRef,
    paidAt,
  };
}
