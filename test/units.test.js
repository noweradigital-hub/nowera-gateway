import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildUserData, hashField } from '../src/lib/hash.js';
import { normalizeEvent } from '../src/lib/event.js';
import { buildPayload as metaPayload } from '../src/destinations/meta.js';
import { buildPayload as ga4Payload } from '../src/destinations/ga4.js';
import { loaderScript } from '../src/lib/loader.js';
import { newFbp, resolveFbc } from '../src/lib/ids.js';

const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

test('email is trimmed and lowercased before hashing', () => {
  assert.equal(hashField('em', '  John.Smith@Gmail.com '), sha('john.smith@gmail.com'));
});

test('phone keeps digits only and drops leading zeros', () => {
  assert.equal(hashField('ph', '+421 903 123 456'), sha('421903123456'));
  assert.equal(hashField('ph', '0903/123-456'), sha('903123456'));
});

test('already hashed values pass through untouched', () => {
  const digest = sha('test@example.com');
  assert.equal(hashField('em', digest.toUpperCase()), digest);
});

test('empty values yield null so the key can be dropped', () => {
  for (const v of ['', '   ', null, undefined]) assert.equal(hashField('em', v), null);
  assert.equal(hashField('ct', '---'), null, 'punctuation-only city is empty after normalization');
});

test('names and cities strip punctuation but keep diacritics', () => {
  assert.equal(hashField('fn', "O'Brien"), sha('obrien'));
  assert.equal(hashField('ct', 'Banská Bystrica'), sha('banskábystrica'));
});

test('buildUserData wraps hashed PII in arrays and passes context through raw', () => {
  const ud = buildUserData(
    { em: 'a@b.sk', zp: '811 01', country: 'SK' },
    { ip: '1.2.3.4', userAgent: 'UA', fbp: 'fb.1.1.2', fbc: 'fb.1.1.abc' },
  );
  assert.deepEqual(ud.em, [sha('a@b.sk')]);
  assert.deepEqual(ud.zp, [sha('81101')]);
  assert.deepEqual(ud.country, [sha('sk')]);
  assert.equal(ud.client_ip_address, '1.2.3.4');
  assert.equal(ud.fbp, 'fb.1.1.2');
  assert.equal(ud.fbc, 'fb.1.1.abc');
  assert.ok(!('ph' in ud), 'absent fields are omitted entirely');
});

test('normalizeEvent requires a usable event name', () => {
  assert.throws(() => normalizeEvent({}, {}), /event_name is required/);
  assert.throws(() => normalizeEvent({ event_name: 'bad<name>' }, {}), /invalid characters/);
});

test('normalizeEvent maps long-form PII aliases to Meta keys', () => {
  const e = normalizeEvent(
    { event_name: 'Purchase', user_data: { email: 'x@y.sk', first_name: 'Ján', zip: '01001' } },
    { ip: '9.9.9.9', userAgent: 'UA' },
  );
  assert.equal(e.user.em, 'x@y.sk');
  assert.equal(e.user.fn, 'Ján');
  assert.equal(e.user.zp, '01001');
});

test('normalizeEvent clamps clock skew and stale timestamps', () => {
  const now = Math.floor(Date.now() / 1000);
  assert.ok(normalizeEvent({ event_name: 'X', event_time: now + 99999 }, {}).event_time <= now);
  assert.ok(normalizeEvent({ event_name: 'X', event_time: 1 }, {}).event_time >= now - 7 * 86400);
});

test('normalizeEvent generates an event_id when the caller omits one', () => {
  const e = normalizeEvent({ event_name: 'Lead' }, {});
  assert.match(e.event_id, /^[0-9a-f-]{36}$/);
});

const sample = normalizeEvent({
  event_name: 'Purchase',
  event_id: 'evt-1',
  event_source_url: 'https://klient.sk/dakujeme',
  user_data: { email: 'a@b.sk' },
  custom_data: {
    value: '49.90', currency: 'EUR', order_id: 1234,
    contents: [{ id: 'SKU1', quantity: 2, item_price: 24.95 }],
  },
}, { ip: '1.2.3.4', userAgent: 'UA', fbp: 'fb.1.1.2' });

test('meta payload carries event_id, hashed user data and numeric value', () => {
  const body = metaPayload(sample, { dataset_id: '1', access_token: 't', test_event_code: 'TEST1' });
  const d = body.data[0];
  assert.equal(d.event_id, 'evt-1');
  assert.equal(d.action_source, 'website');
  assert.deepEqual(d.user_data.em, [sha('a@b.sk')]);
  assert.equal(d.custom_data.value, 49.9);
  assert.equal(d.custom_data.order_id, 1234);
  assert.equal(body.test_event_code, 'TEST1');
});

test('meta payload omits test_event_code when not configured', () => {
  const body = metaPayload(sample, { dataset_id: '1', access_token: 't' });
  assert.ok(!('test_event_code' in body));
});

test('ga4 payload renames the event and converts contents to items', () => {
  const body = ga4Payload(sample, { measurement_id: 'G-1', api_secret: 's' });
  assert.equal(body.events[0].name, 'purchase');
  assert.equal(body.events[0].params.transaction_id, '1234');
  assert.equal(body.events[0].params.value, 49.9);
  assert.deepEqual(body.events[0].params.items, [
    { item_id: 'SKU1', item_name: undefined, quantity: 2, price: 24.95 },
  ]);
  assert.equal(body.timestamp_micros, sample.event_time * 1_000_000);
});

test('ga4 falls back to snake_case for unmapped custom events', () => {
  const e = normalizeEvent({ event_name: 'ViewCategory' }, {});
  assert.equal(ga4Payload(e, {}).events[0].name, 'view_category');
});

test('fbp and fbc follow Meta cookie formats', () => {
  assert.match(newFbp(1700000000000), /^fb\.1\.1700000000000\.\d+$/);
  assert.equal(resolveFbc({ cookie: 'existing' }), 'existing');
  assert.match(resolveFbc({ url: 'https://klient.sk/?fbclid=ABC' }), /^fb\.1\.\d+\.ABC$/);
  assert.equal(resolveFbc({ url: 'https://klient.sk/' }), null);
  assert.equal(resolveFbc({ url: 'not a url' }), null);
});

test('generated loader is syntactically valid javascript', () => {
  const src = loaderScript({ endpoint: 'https://t.klient.sk/e', pixelId: '999' });
  assert.doesNotThrow(() => new Function(src));
  assert.match(src, /eventID: eventId/, 'browser leg must share the event id for dedupe');
});
