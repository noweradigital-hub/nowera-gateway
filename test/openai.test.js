import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildPayload, minorAmount, send, verify } from '../src/destinations/openai.js';
import { consentAllows, dedupeKeyFor, wants } from '../src/destinations/index.js';
import { normalizeEvent } from '../src/lib/event.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');
const NOW = Date.now();
const DEST = { kind: 'openai', settings: { pixel_id: 'PX', api_key: 'K' } };

const purchase = (extra = {}) => normalizeEvent({
  event_name: 'Purchase',
  event_id: 'ord-1001',
  event_time: Math.floor(NOW / 1000) - 60,
  event_source_url: 'https://shop.sk/dakujeme/',
  user_data: { email: ' Jana@Shop.SK ', phone: '0905 123 456', first_name: 'Jana', country: 'sk', external_id: 'v-1' },
  custom_data: {
    value: 70.74, currency: 'EUR', content_type: 'product',
    contents: [{ id: '42', quantity: 2, item_price: 25.5, item_name: 'Kocka' }, { id: '', quantity: 1 }],
    ...extra,
  },
  consent: { marketing: true, statistics: true },
}, { ip: '203.0.113.1', userAgent: 'UA/1', oppref: 'opp_abc', obref: '123e4567-e89b' });

test('openai: money goes in minor units, refused when it is not a plain number', () => {
  assert.equal(minorAmount(70.74, 'EUR'), 7074);
  assert.equal(minorAmount('70.74', 'EUR'), 7074);
  assert.equal(minorAmount(8900, 'JPY'), 8900);
  assert.equal(minorAmount(1.2345, 'KWD'), 1235);
  assert.equal(minorAmount(10, 'HUF'), 1000, 'ISO 4217 exponent, not the display habit');
  for (const bad of ['70,74 €', '7.074,00', null, NaN, Infinity, -5]) assert.equal(minorAmount(bad, 'EUR'), null, String(bad));
  assert.equal(minorAmount(10, 'XYZ'), null);
  assert.equal(minorAmount(10, undefined), null);
});

test('openai: a Purchase becomes order_created with the id, amount, contents and user OpenAI expects', () => {
  const body = buildPayload(purchase(), {}, NOW);
  assert.equal(body.validate_only, undefined);
  const [e] = body.events;
  assert.equal(e.id, 'ord-1001');
  assert.equal(e.type, 'order_created');
  assert.equal(e.action_source, 'web');
  assert.equal(e.source_url, 'https://shop.sk/dakujeme/');
  assert.equal(e.oppref, 'opp_abc');
  assert.equal(e.timestamp_ms, (Math.floor(NOW / 1000) - 60) * 1000);
  assert.deepEqual(e.data, {
    type: 'contents', amount: 7074, currency: 'EUR',
    contents: [{ id: '42', name: 'Kocka', content_type: 'product', quantity: 2, amount: 2550, currency: 'EUR' }],
  });
  assert.deepEqual(e.user, {
    emails_sha256: [sha('jana@shop.sk')],
    phone_numbers_sha256: [sha('421905123456')],
    first_names_sha256: [sha('jana')],
    external_ids_sha256: [sha('v-1')],
    countries: ['SK'],
    ip_address: '203.0.113.1',
    user_agent: 'UA/1',
    obref: '123e4567-e89b',
  });
});

test('openai: an unparseable value leaves the amount out rather than guessing', () => {
  const [e] = buildPayload(purchase({ value: '70,74 €' }), {}, NOW).events;
  assert.equal(e.data.amount, undefined);
  assert.equal(e.data.currency, undefined);
});

test('openai: leads, plans and events it does not know', () => {
  const lead = normalizeEvent({ event_name: 'Lead', event_id: 'l1', event_source_url: 'https://x.sk/' }, {});
  assert.deepEqual(buildPayload(lead, {}, NOW).events[0].data, { type: 'customer_action' });
  const sub = normalizeEvent({ event_name: 'Subscribe', event_id: 's1', event_source_url: 'https://x.sk/', custom_data: { plan_id: 'pro', value: 20, currency: 'EUR' } }, {});
  assert.deepEqual(buildPayload(sub, {}, NOW).events[0].data, { type: 'plan_enrollment', amount: 2000, currency: 'EUR', plan_id: 'pro' });
  const search = normalizeEvent({ event_name: 'Search', event_id: 'q1' }, {});
  assert.equal(buildPayload(search, {}, NOW), null);
  assert.equal(wants(DEST, search), false, 'never queued for OpenAI');
  assert.equal(wants(DEST, normalizeEvent({ event_name: 'Refund', event_id: 'r' }, {})), false);
  assert.equal(wants(DEST, lead), true);
});

test('openai: advertising consent, and one copy per event id', () => {
  const e = purchase();
  assert.equal(consentAllows('openai', e), true);
  assert.equal(consentAllows('openai', { ...e, consent: { marketing: false, statistics: true } }), false);
  assert.equal(dedupeKeyFor('openai', e), 'Purchase:ord-1001');
});

test('openai: a dashboard test is only validated', () => {
  const body = buildPayload({ ...purchase(), test: true }, {}, NOW);
  assert.equal(body.validate_only, true);
});

test('openai: send posts to the pixel with the key, and sorts errors into retry or not', async () => {
  const calls = [];
  const ok = await send(purchase(), DEST.settings, async (url, opts) => { calls.push({ url, opts }); return new Response('{}', { status: 200 }); });
  assert.equal(ok.ok, true);
  assert.equal(calls[0].url, 'https://bzr.openai.com/v1/events?pid=PX');
  assert.equal(calls[0].opts.headers.authorization, 'Bearer K');
  assert.equal(JSON.parse(calls[0].opts.body).events[0].type, 'order_created');

  const bad = await send(purchase(), DEST.settings, async () => new Response('bad', { status: 400 }));
  assert.deepEqual([bad.ok, bad.retryable], [false, false]);
  const busy = await send(purchase(), DEST.settings, async () => new Response('slow down', { status: 429 }));
  assert.deepEqual([busy.ok, busy.retryable], [false, true]);
  const down = await send(purchase(), DEST.settings, async () => { throw new Error('ECONNRESET'); });
  assert.deepEqual([down.ok, down.retryable], [false, true]);
  const missing = await send(purchase(), { pixel_id: 'PX' });
  assert.equal(missing.retryable, false);
});

test('openai: verify sends one validate-only event and explains a refusal', async () => {
  let sent;
  const ok = await verify(DEST.settings, async (url, opts) => { sent = JSON.parse(opts.body); return new Response('', { status: 200 }); });
  assert.equal(ok.ok, true);
  assert.equal(sent.validate_only, true);
  const no = await verify(DEST.settings, async () => new Response('nope', { status: 401 }));
  assert.deepEqual(no, { ok: false, error: 'API kľúč je neplatný' });
});

test('openai: without marketing consent the ad click ids leave the page address too', () => {
  const e = normalizeEvent({ event_name: 'PageView', event_source_url: 'https://x.sk/?oppref=AD&fbclid=FB&utm_source=chatgpt',
    consent: { marketing: false, statistics: true } }, {});
  assert.equal(e.event_source_url, 'https://x.sk/?utm_source=chatgpt');
  const ok = normalizeEvent({ event_name: 'PageView', event_source_url: 'https://x.sk/?oppref=AD', consent: { marketing: true, statistics: true } }, {});
  assert.equal(ok.event_source_url, 'https://x.sk/?oppref=AD');
});

test('openai: with only a pixel id the browser pixel measures and nothing is queued for the server', async () => {
  const pixelOnly = { kind: 'openai', settings: { pixel_id: 'PX' } };
  assert.equal(wants(pixelOnly, purchase()), false);
  assert.equal(wants(DEST, purchase()), true);
  const v = await verify({ pixel_id: 'PX' }, async () => { throw new Error('must not call OpenAI'); });
  assert.equal(v.ok, false);
  assert.match(v.error, /meria len pixel/);
});
