import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildUserData, hashField } from '../src/lib/hash.js';
import { normalizeEvent } from '../src/lib/event.js';
import { buildPayload as metaPayload } from '../src/destinations/meta.js';
import { buildPayload as ga4Payload } from '../src/destinations/ga4.js';
import { isBot } from '../src/lib/bots.js';
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

test('meta payload carries the page referrer without its query string', () => {
  const ev = normalizeEvent({
    event_name: 'PageView',
    referrer_url: 'https://klient.sk/pokladna/?key=wc_order_secret#platba',
  }, { ip: '1.2.3.4', userAgent: 'UA' });
  assert.equal(metaPayload(ev, {}).data[0].referrer_url, 'https://klient.sk/pokladna/');

  for (const bad of ['javascript:alert(1)', 'not a url', '', 42, 'https://x.sk/' + 'a'.repeat(3000)]) {
    const e = normalizeEvent({ event_name: 'PageView', referrer_url: bad }, {});
    assert.equal(metaPayload(e, {}).data[0].referrer_url, undefined, `dropped: ${String(bad).slice(0, 20)}`);
  }
});

test('meta payload keeps a valid customer segment and drops anything else', () => {
  const withSegment = (value) => metaPayload(normalizeEvent({
    event_name: 'Purchase', custom_data: { value: 10, currency: 'EUR', customer_segmentation: value },
  }, {}), {}).data[0].custom_data.customer_segmentation;
  assert.equal(withSegment('new_customer_to_business'), 'new_customer_to_business');
  assert.equal(withSegment('existing_customer_to_business'), 'existing_customer_to_business');
  assert.equal(withSegment('vip'), undefined, 'Meta rejects unknown values');
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
  const e = normalizeEvent({ event_name: 'StartSizeGuide' }, {});
  assert.equal(ga4Payload(e, {}).events[0].name, 'start_size_guide');
});

test('ga4 maps a category view to view_item_list', () => {
  const e = normalizeEvent({ event_name: 'ViewCategory' }, {});
  assert.equal(ga4Payload(e, {}).events[0].name, 'view_item_list');
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
});

test('only destinations without their own deduplication get a dedupe key', async () => {
  const { dedupeKeyFor } = await import('../src/destinations/index.js');
  const event = { event_name: 'Purchase', event_id: 'ord-1' };

  // Meta collapses the browser and server hit itself using event_id, so both legs
  // must reach it. GA4 has no such mechanism and would count two purchases.
  assert.equal(dedupeKeyFor('meta', event), null);
  assert.equal(dedupeKeyFor('ga4', event), 'Purchase:ord-1');

  assert.equal(dedupeKeyFor('ga4', { event_name: 'Purchase' }), null, 'no event_id, nothing to collapse');
});

test('the loader reads the GA4 client and session cookies', () => {
  const src = loaderScript({ endpoint: 'https://t.k.sk/e', pixelId: '1', measurementId: 'G-Q7G1FKXMED' });
  assert.match(src, /var GA_STREAM = "Q7G1FKXMED"/, 'session cookie is named after the stream id');
  assert.match(src, /cookie\('_ga_' \+ GA_STREAM\)/);
  assert.match(src, /ga_client_id: gaClientId\(\)/);
  assert.match(src, /ga_session_id: gaSessionId\(\)/);
});

test('the loader degrades safely when GA4 is not configured', () => {
  const src = loaderScript({ endpoint: 'https://t.k.sk/e', pixelId: '1', measurementId: null });
  assert.match(src, /var GA_STREAM = null/);
  assert.doesNotThrow(() => new Function(src));
});


test('each destination is gated by its own consent category', async () => {
  const { consentAllows } = await import('../src/destinations/index.js');
  const both = { consent: { marketing: true, statistics: true } };
  const statsOnly = { consent: { marketing: false, statistics: true } };
  const nothing = { consent: { marketing: false, statistics: false } };
  const legacy = {};

  assert.equal(consentAllows('meta', both), true);
  assert.equal(consentAllows('meta', statsOnly), false, 'Meta Ads needs marketing consent');
  assert.equal(consentAllows('ga4', statsOnly), true, 'GA4 needs statistics consent');
  assert.equal(consentAllows('ga4', nothing), false);
  assert.equal(consentAllows('meta', legacy), true, 'events without consent info keep old behaviour');
  assert.equal(consentAllows('meta', { consent: { statistics: true } }), false, 'unknown marketing is not consent');
});

test('normalizeEvent keeps only explicit boolean consent', () => {
  assert.deepEqual(normalizeEvent({ event_name: 'X', consent: { marketing: true, statistics: false } }, {}).consent,
    { marketing: true, statistics: false });
  assert.equal(normalizeEvent({ event_name: 'X', consent: { marketing: 'yes' } }, {}).consent, null);
  assert.equal(normalizeEvent({ event_name: 'X' }, {}).consent, null);
});

test('ga4 tells Google whether a hit may be used for ads', () => {
  const granted = normalizeEvent({ event_name: 'Purchase', consent: { marketing: true, statistics: true } }, {});
  assert.deepEqual(ga4Payload(granted, {}).consent, { ad_user_data: 'GRANTED', ad_personalization: 'GRANTED' });

  const denied = normalizeEvent({ event_name: 'Purchase', consent: { marketing: false, statistics: true } }, {});
  assert.deepEqual(ga4Payload(denied, {}).consent, { ad_user_data: 'DENIED', ad_personalization: 'DENIED' });

  const legacy = normalizeEvent({ event_name: 'Purchase' }, {});
  assert.equal(ga4Payload(legacy, {}).consent, undefined, 'no consent block, Google keeps its own default');
});

test('consent settings are normalised to known modes and safe prefixes', async () => {
  const { normalizeConsent } = await import('../src/lib/consent.js');
  assert.deepEqual(normalizeConsent('cookiescript', 'cmplz_'), { mode: 'cookiescript', prefix: 'cmplz_' });
  assert.deepEqual(normalizeConsent('evil', 'x"</script>'), { mode: 'none', prefix: 'xscript' });
  assert.deepEqual(normalizeConsent('__proto__', ''), { mode: 'none', prefix: 'cmplz_' });
  assert.deepEqual(normalizeConsent(undefined, undefined), { mode: 'none', prefix: 'cmplz_' });
});

test('the loader cannot be broken out of by a tenant consent value', () => {
  const src = loaderScript({ endpoint: 'https://t.k.sk/e', pixelId: '1', consent: { mode: '</script><script>alert(1)', prefix: 'x' } });
  assert.doesNotThrow(() => new Function(src));
});

test('a device with a wrong clock does not look like a stale event', () => {
  const now = Math.floor(Date.now() / 1000);
  // Phone clock three days behind, event sent two seconds after it happened.
  const skewed = normalizeEvent({ event_name: 'PageView', event_time: now - 3 * 86400, sent_at: now - 3 * 86400 + 2 }, {});
  assert.ok(Math.abs(skewed.event_time - (now - 2)) <= 2, 'placed on our clock, delay kept');

  // A real wait: consent given ten minutes after the page view.
  const waited = normalizeEvent({ event_name: 'PageView', event_time: now - 600, sent_at: now }, {});
  assert.ok(Math.abs(waited.event_time - (now - 600)) <= 2, 'a genuine delay survives');

  // An old loader sends no sent_at, so the previous clamping still applies.
  const legacy = normalizeEvent({ event_name: 'PageView', event_time: now - 120 }, {});
  assert.equal(legacy.event_time, now - 120);
  assert.ok(normalizeEvent({ event_name: 'PageView', event_time: now + 99999 }, {}).event_time <= now + 60);
});

test('crawlers are recognised, real browsers are not', () => {
  const bots = [
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
    'meta-externalagent/1.1',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)',
    'curl/8.4.0',
    'python-requests/2.31.0',
    'Mozilla/5.0 (compatible; SemrushBot/7~bl)',
    'Mozilla/5.0 (compatible; Bytespider; https://zhanzhang.toutiao.com/)',
  ];
  for (const ua of bots) assert.equal(isBot(ua), true, ua.slice(0, 40));

  const people = [
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    'Mozilla/5.0 (Linux; Android 14; SM-S911B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Mobile Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
  ];
  for (const ua of people) assert.equal(isBot(ua), false, ua.slice(0, 40));
  assert.equal(isBot(undefined), false);
});
