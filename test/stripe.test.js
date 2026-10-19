import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { majorAmount, paidCheckout, verifyStripeSignature } from '../src/lib/stripe.js';

const SECRET = 'whsec_test_secret';
const sign = (body, t, secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const NOW = 1_800_000_000_000;
const T = Math.floor(NOW / 1000);

// --------------------------------------------------------------- signature

test('stripe signature: a correctly signed body passes', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, T), SECRET, NOW), null);
});

test('stripe signature: any of several v1 values may match (secret being rolled)', () => {
  const body = '{"id":"evt_1"}';
  const header = `t=${T},v1=${'0'.repeat(64)},${sign(body, T).split(',')[1]}`;
  assert.equal(verifyStripeSignature(body, header, SECRET, NOW), null);
});

test('stripe signature: an old and a new secret are both tried', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, T, 'whsec_old'), ['whsec_new', 'whsec_old'], NOW), null);
});

test('stripe signature: a changed body, wrong secret or v0 only is refused', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature('{"id":"evt_2"}', sign(body, T), SECRET, NOW), 'bad signature');
  assert.equal(verifyStripeSignature(body, sign(body, T, 'whsec_other'), SECRET, NOW), 'bad signature');
  const v0 = `t=${T},v0=${createHmac('sha256', SECRET).update(`${T}.${body}`).digest('hex')}`;
  assert.equal(verifyStripeSignature(body, v0, SECRET, NOW), 'bad signature');
});

test('stripe signature: a replay outside five minutes is refused', () => {
  const body = '{"id":"evt_1"}';
  assert.equal(verifyStripeSignature(body, sign(body, T - 301), SECRET, NOW), 'stale request');
  assert.equal(verifyStripeSignature(body, sign(body, T + 301), SECRET, NOW), 'stale request');
  assert.equal(verifyStripeSignature(body, sign(body, T - 299), SECRET, NOW), null);
});

test('stripe signature: no secret configured, no header or garbage', () => {
  assert.equal(verifyStripeSignature('{}', 't=1,v1=ab', null, NOW), 'stripe not configured');
  assert.equal(verifyStripeSignature('{}', undefined, SECRET, NOW), 'missing signature');
  assert.equal(verifyStripeSignature('{}', 'nonsense', SECRET, NOW), 'bad signature');
});

// ----------------------------------------------------------------- amounts

test('stripe amounts: cents, zero-decimal and three-decimal currencies', () => {
  assert.equal(majorAmount(1299, 'eur'), 12.99);
  assert.equal(majorAmount(500, 'JPY'), 500);
  assert.equal(majorAmount(12340, 'kwd'), 12.34);
  assert.equal(majorAmount('x', 'eur'), null);
});

// ---------------------------------------------------------------- sessions

const session = (over = {}) => ({
  id: 'evt_123', type: 'checkout.session.completed', created: 1_800_000_100, livemode: true,
  data: { object: {
    id: 'cs_live_abc', object: 'checkout.session', mode: 'payment', payment_status: 'paid',
    amount_total: 1299, currency: 'eur', customer_details: { email: ' Jana@Example.sk ' },
    metadata: { order_id: '481' }, created: 1_800_000_000, ...over,
  } },
});

test('stripe checkout: a paid session becomes a purchase in major units', () => {
  assert.deepEqual(paidCheckout(session()), {
    sessionId: 'cs_live_abc', stripeEventId: 'evt_123', livemode: true, email: 'Jana@Example.sk',
    value: 12.99, currency: 'EUR', orderRef: '481', paidAt: 1_800_000_100,
  });
});

test('stripe checkout: unpaid, subscription and other events are not purchases', () => {
  assert.equal(paidCheckout(session({ payment_status: 'unpaid' })), null);
  assert.equal(paidCheckout(session({ mode: 'subscription' })), null);
  assert.equal(paidCheckout({ ...session(), type: 'charge.refunded' }), null);
  assert.equal(paidCheckout({ ...session(), data: { object: { object: 'payment_intent' } } }), null);
  assert.equal(paidCheckout(null), null);
});

test('stripe checkout: an async payment counts once it succeeds', () => {
  const ev = { ...session(), type: 'checkout.session.async_payment_succeeded' };
  assert.equal(paidCheckout(ev).sessionId, 'cs_live_abc');
});

test('stripe checkout: email falls back to customer_email, order to client_reference_id', () => {
  const p = paidCheckout(session({ customer_details: null, customer_email: 'a@b.sk', metadata: {}, client_reference_id: 'ref-9' }));
  assert.equal(p.email, 'a@b.sk');
  assert.equal(p.orderRef, 'ref-9');
});

// ------------------------------------------------------------- the matcher

const { browserContext, decide, purchaseFromStripe, stripeDestinations } = await import('../src/lib/stripe-purchases.js');
const { createHash } = await import('node:crypto');
const sha = (v) => createHash('sha256').update(v).digest('hex');
const EM = sha('jana@example.sk');
const PAID = new Date('2026-10-19T12:00:00Z');
const at = (minutes) => new Date(PAID.getTime() + minutes * 60_000).toISOString();
const payment = (over = {}) => ({
  id: 1, tenant_id: 4, session_id: 'cs_live_1', email_hash: EM, value: '12.99', currency: 'EUR',
  order_ref: '481', paid_at: PAID.toISOString(), ...over,
});
const ctx = (over = {}) => ({
  event_name: 'PageView', event_id: 'pv-1', value: null, currency: null,
  consent: { marketing: true, statistics: true }, created_at: at(-10),
  snapshot: { user: { em: EM, external_id: sha('visitor') }, event_source_url: 'https://stripe-klient.sk/order-wizard/summary',
    context: { ip: '1.2.3.4', userAgent: 'UA', fbp: 'fb.1.1.1', fbc: 'fb.1.1.abc', gaClientId: '1.2', gaSessionId: '3' } },
  ...over,
});
const purchase = (over = {}) => ctx({ event_name: 'Purchase', event_id: 'ord-2026-481', value: '12.99', currency: 'EUR', created_at: at(1), ...over });

const both = (rows) => ({ purchases: rows.filter((r) => r.event_name === 'Purchase'), visits: rows });

test('matcher: the browser Purchase for the payment arrived, nothing is sent', () => {
  assert.deepEqual(decide(payment(), both([purchase(), ctx()])), { status: 'matched', matched_event_id: 'ord-2026-481' });
});

test('matcher: the same Purchase reported twice is still one match', () => {
  assert.equal(decide(payment(), both([purchase(), purchase({ created_at: at(2) })])).status, 'matched');
});

test('matcher: two browser Purchases that both fit are ambiguous, nothing is sent', () => {
  assert.deepEqual(decide(payment(), both([purchase(), purchase({ event_id: 'ord-2026-482' })])), { status: 'ambiguous' });
});

test('matcher: a Purchase already matched to another payment is not reused', () => {
  const d = decide(payment(), both([purchase(), ctx()]), new Set(['ord-2026-481']));
  assert.equal(d.status, 'sent');
});

test('matcher: a different amount, another or a missing currency is not this payment', () => {
  assert.equal(decide(payment(), both([purchase({ value: '13.99' }), ctx()])).status, 'sent');
  assert.equal(decide(payment(), both([purchase({ currency: 'CZK' }), ctx()])).status, 'sent');
  assert.equal(decide(payment(), both([purchase({ currency: null }), ctx()])).status, 'sent');
});

test('matcher: a Purchase long before or after the payment (another order) does not match it', () => {
  assert.equal(decide(payment(), both([purchase({ created_at: at(-40) }), ctx()])).status, 'sent');
  assert.equal(decide(payment(), both([purchase({ created_at: at(24 * 60) }), ctx()])).status, 'sent');
  assert.equal(decide(payment(), both([purchase({ created_at: at(29) }), ctx()])).status, 'matched');
});

test('matcher: no browser Purchase but a consenting visit — send, with that visit', () => {
  const d = decide(payment(), both([ctx()]));
  assert.equal(d.status, 'sent');
  assert.equal(d.context.event_id, 'pv-1');
});

test('matcher: a visit after the payment is no evidence for it', () => {
  assert.deepEqual(decide(payment(), both([ctx({ created_at: at(5) })])), { status: 'no_visit' });
});

test('matcher: the newest visit before the payment decides; a refusal there sends nothing', () => {
  const refused = ctx({ event_id: 'pv-2', created_at: at(-5), consent: { marketing: false, statistics: false } });
  assert.deepEqual(decide(payment(), both([refused, ctx()])), { status: 'no_consent' });
});

test('matcher: no visit within two hours, or no email, sends nothing', () => {
  assert.deepEqual(decide(payment(), both([ctx({ created_at: at(-180) })])), { status: 'no_visit' });
  assert.deepEqual(decide(payment(), both([])), { status: 'no_visit' });
  assert.deepEqual(decide(payment(), {}), { status: 'no_visit' });
  assert.deepEqual(decide(payment({ email_hash: null }), both([ctx()])), { status: 'no_visit' });
});

test('matcher: a site without a consent tool (no consent block) is sent', () => {
  assert.equal(decide(payment(), both([ctx({ consent: null })])).status, 'sent');
});

test('matcher: the server Purchase carries the visit and the payment', () => {
  const ev = purchaseFromStripe(payment(), ctx(), Math.floor(PAID.getTime() / 1000) + 900);
  assert.equal(ev.event_name, 'Purchase');
  assert.equal(ev.event_id, 'stripe-cs_live_1');
  assert.equal(ev.event_time, Math.floor(PAID.getTime() / 1000));
  assert.equal(ev.user.em, EM);
  assert.equal(ev.user.external_id, sha('visitor'));
  assert.deepEqual(ev.properties, { value: 12.99, currency: 'EUR', content_type: 'product', order_id: '481' });
  assert.equal(ev.context.fbc, 'fb.1.1.abc');
  assert.deepEqual(ev.consent, { marketing: true, statistics: true });
  assert.equal(ev.browserless, true);
  assert.equal(ev.source, 'server');
});

test('matcher: GA4 gets a Stripe Purchase only with the browser client id', () => {
  const dests = [{ id: 1, kind: 'meta' }, { id: 2, kind: 'ga4' }];
  const withId = purchaseFromStripe(payment(), ctx());
  const without = purchaseFromStripe(payment(), ctx({ snapshot: { user: { em: EM }, context: { ip: '1.2.3.4' } } }));
  assert.deepEqual(stripeDestinations(dests, withId).map((d) => d.kind), ['meta', 'ga4']);
  assert.deepEqual(stripeDestinations(dests, without).map((d) => d.kind), ['meta']);
});

test('browser context: kept only with a hashed email and some consent', () => {
  const ev = { event_name: 'Purchase', event_id: 'ord-1', user: { em: EM }, consent: { marketing: true },
    properties: { value: 12.99, currency: 'eur' }, context: { ip: '1.2.3.4' } };
  const row = browserContext(ev);
  assert.equal(row.email_hash, EM);
  assert.equal(row.value, 12.99);
  assert.equal(row.currency, 'EUR');
  assert.equal(browserContext({ ...ev, user: {} }), null);
  assert.equal(browserContext({ ...ev, consent: { marketing: false, statistics: false } }), null);
  assert.equal(browserContext({ ...ev, event_name: 'PageView' }).value, null);
});
