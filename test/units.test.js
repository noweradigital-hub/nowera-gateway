import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import { buildUserData, hashField, phoneDigits } from '../src/lib/hash.js';
import { normalizeEvent } from '../src/lib/event.js';
import { buildPayload as metaPayload } from '../src/destinations/meta.js';
import { buildPayload as ga4Payload } from '../src/destinations/ga4.js';
import { isBot } from '../src/lib/bots.js';
import { normalizeKeepPath } from '../src/lib/consent.js';
import { loaderScript } from '../src/lib/loader.js';
import { newFbp, resolveFbc } from '../src/lib/ids.js';
import { clientIp, fromCloudflare } from '../src/lib/client-ip.js';

const sha = (v) => createHash('sha256').update(v, 'utf8').digest('hex');

test('email is trimmed and lowercased before hashing', () => {
  assert.equal(hashField('em', '  John.Smith@Gmail.com '), sha('john.smith@gmail.com'));
});

test('phone keeps digits only and drops leading zeros', () => {
  assert.equal(hashField('ph', '+421 903 123 456'), sha('421903123456'));
  assert.equal(hashField('ph', '0903/123-456'), sha('903123456'), 'no country: nothing to prefix');
});

test('a national phone number gets its country code, as Meta matches it', () => {
  const cases = [
    ['0905 123 456', 'SK', '421905123456'],
    ['905123456', 'sk', '421905123456'],
    ['421905123456', 'SK', '421905123456'],
    ['00421 905 123 456', 'CZ', '421905123456'],
    ['+421 0905 123 456', 'SK', '421905123456'],
    ['603 123 456', 'CZ', '420603123456'],
    ['06 30 123 4567', 'HU', '36301234567'],
    ['+36 06 30 123 4567', null, '36301234567'],
    ['06 1234 5678', 'IT', '390612345678'],
  ];
  for (const [input, country, expected] of cases) assert.equal(phoneDigits(input, country), expected, input);
  assert.deepEqual(buildUserData({ ph: '0905 123 456', country: 'SK' }).ph, [sha('421905123456')]);
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
  assert.equal(e.user.em, sha('x@y.sk'));
  assert.equal(e.user.fn, sha('ján'));
  assert.equal(e.user.zp, sha('01001'));
  assert.ok(!JSON.stringify(e).includes('x@y.sk'), 'nothing readable is kept');
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
  const testing = { dataset_id: '1', access_token: 't', test_event_code: 'TEST1',
    test_until: new Date(Date.now() + 60_000).toISOString() };
  const body = metaPayload(sample, testing);
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

test('the keeper path stays on the site\u2019s own origin', () => {
  assert.equal(normalizeKeepPath(' /wp-content/plugins/nowera-capi/keep.php '), '/wp-content/plugins/nowera-capi/keep.php');
  for (const bad of ['', 'https://evil.example/keep.php', '//evil.example/keep.php', 'keep.php', '/a b.php', '/x"><script>', null, undefined]) {
    assert.equal(normalizeKeepPath(bad), null, String(bad));
  }
});

test('behind Cloudflare the visitor address comes from CF-Connecting-IP, IPv6 included', () => {
  const req = (headers, ip = '172.18.0.2') => ({ headers, ip });
  // Traefik replaced X-Forwarded-For with the Cloudflare edge that connected.
  assert.equal(clientIp(req({ 'x-forwarded-for': '172.70.1.5', 'cf-connecting-ip': '2a02:ab8:1::5' })), '2a02:ab8:1::5');
  // Traefik trusting forwarded headers: the last hop is still the edge.
  assert.equal(clientIp(req({ 'x-forwarded-for': '2a02:ab8:1::5, 2400:cb00:2049::1', 'cf-connecting-ip': '2a02:ab8:1::5' })), '2a02:ab8:1::5');
  // Straight to the VPS: the header is somebody's claim, not Cloudflare's.
  assert.equal(clientIp(req({ 'x-forwarded-for': '81.2.3.4', 'cf-connecting-ip': '9.9.9.9' })), '81.2.3.4');
  assert.equal(clientIp(req({ 'x-forwarded-for': '172.70.1.5', 'cf-connecting-ip': 'garbage' })), '172.70.1.5');
  assert.equal(clientIp(req({})), '172.18.0.2');
  assert.equal(fromCloudflare('::ffff:104.16.0.1'), true);
  assert.equal(fromCloudflare('31.97.179.201'), false);
});

test('a Meta test event code lapses an hour after it was saved', () => {
  const settings = { dataset_id: '1', access_token: 't', test_event_code: 'TEST1' };
  const payload = (extra) => metaPayload({ event_name: 'Lead', event_time: 1, user: {}, context: {} }, { ...settings, ...extra });
  assert.equal(payload({ test_until: new Date(Date.now() + 60_000).toISOString() }).test_event_code, 'TEST1');
  assert.equal(payload({ test_until: new Date(Date.now() - 1).toISOString() }).test_event_code, undefined, 'expired');
  assert.equal(payload({}).test_event_code, undefined, 'a code with no expiry is a forgotten one');
});

test('a test from the dashboard goes to the GA4 validation endpoint only', () => {
  const body = ga4Payload({ event_name: 'Lead', event_id: 'x', event_time: 1, test: true, properties: {}, context: {} }, {});
  assert.equal(body.debug, true);
});

test('the limiter counts per key and forgets when the window ends', async () => {
  const { createLimiter } = await import('../src/lib/ratelimit.js');
  const limit = createLimiter({ windowMs: 1000, max: 2 });
  const t0 = Date.now();
  assert.equal(limit.hit('a', t0), true);
  assert.equal(limit.hit('a', t0), true);
  assert.equal(limit.blocked('a', t0), true);
  assert.equal(limit.hit('a', t0), false);
  assert.equal(limit.hit('b', t0), true, 'another key is unaffected');
  assert.equal(limit.blocked('a', t0 + 1000), false, 'a new window starts clean');
});

test('token check reads the token itself, not the dataset it may only write to', async () => {
  const { verifyMeta } = await import('../src/destinations/verify.js');
  const calls = [];
  const fake = (status, body) => async (url, opts) => {
    calls.push({ url, auth: opts.headers.authorization });
    return { ok: status === 200, status, json: async () => body };
  };
  const ok = await verifyMeta({ dataset_id: '1', access_token: 'tok' }, fake(200, { id: '9', name: 'Conversions API System User' }));
  assert.deepEqual(ok, { ok: true, name: 'Conversions API System User' });
  assert.match(calls[0].url, /\/me\?fields=id,name$/);
  assert.equal(calls[0].auth, 'Bearer tok', 'the token goes in the header, never in the URL');
  assert.ok(!calls[0].url.includes('tok'));
  const bad = await verifyMeta({ dataset_id: '1', access_token: 'tok' }, fake(400, { error: { code: 190, message: 'x' } }));
  assert.deepEqual(bad, { ok: false, error: 'token je neplatný alebo expirovaný' });
});

test('alerts only go to an https webhook', async () => {
  const { validWebhook } = await import('../src/lib/alerts.js');
  assert.equal(validWebhook('https://n8n.nwra.sk/webhook/abc'), 'https://n8n.nwra.sk/webhook/abc');
  assert.equal(validWebhook('http://n8n.nwra.sk/webhook/abc'), null);
  assert.equal(validWebhook('javascript:alert(1)'), null);
  assert.equal(validWebhook(''), null);
});

test('TOTP matches the RFC 6238 test vector and refuses a replayed code', async () => {
  const { base32Encode, totpCode, verifyTotp, stepAt, otpauthUrl } = await import('../src/lib/totp.js');
  const secret = base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(secret, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  assert.equal(totpCode(secret, stepAt(59_000)), '287082');
  assert.equal(totpCode(secret, stepAt(1111111109_000)), '081804');
  const now = Date.now();
  const code = totpCode(secret, stepAt(now));
  const step = verifyTotp(secret, code, { now });
  assert.equal(step, stepAt(now));
  assert.equal(verifyTotp(secret, code, { now, lastStep: step }), null, 'the same code twice is refused');
  assert.equal(verifyTotp(secret, '000000', { now }) === null || totpCode(secret, stepAt(now)) === '000000', true);
  assert.match(otpauthUrl(secret, 'a@b.sk'), /^otpauth:\/\/totp\/Nowera%20Gateway:a%40b\.sk\?secret=GEZD/);
});

// ------------------------------------------------- the richer ecommerce contract

const richPurchase = () => normalizeEvent({
  event_name: 'Purchase', event_id: 'ord-77', event_time: Math.floor(Date.now() / 1000) - 60,
  event_source_url: 'https://shop.sk/pokladna/order-received/77/',
  referrer_url: 'https://shop.sk/pokladna/',
  consent: { marketing: true, statistics: true },
  account_id: 'A'.repeat(64),
  google_user: { sha256_email_address: ['b'.repeat(64), 'not-a-hash'], sha256_phone_number: 'c'.repeat(64), name: 'Ján' },
  user_data: { em: 'jan@example.com', external_id: 'visitor-1' },
  custom_data: {
    value: 61.5, currency: 'EUR', order_id: 77, tax: 11.5, shipping: 3.9, coupon: 'JESEN10',
    contents: [{
      id: '501', item_name: 'Rastúci Kidvak', quantity: 1, item_price: 57.6, discount: 6.4,
      item_category: 'Nábytok', item_category2: 'Stoličky', item_brand: 'Kidvak', item_variant: 'Kapučínová', index: 0,
    }],
  },
}, {});

test('ga4 purchase carries tax, shipping, coupon, referrer and the full item', () => {
  const body = ga4Payload(richPurchase(), {});
  const p = body.events[0].params;
  assert.equal(p.tax, 11.5);
  assert.equal(p.shipping, 3.9);
  assert.equal(p.coupon, 'JESEN10');
  assert.equal(p.page_referrer, 'https://shop.sk/pokladna/');
  assert.deepEqual(p.items, [{
    item_id: '501', item_name: 'Rastúci Kidvak', quantity: 1, price: 57.6, discount: 6.4,
    item_category: 'Nábytok', item_category2: 'Stoličky', item_brand: 'Kidvak', item_variant: 'Kapučínová', index: 0,
  }]);
});

test('ga4 user_id is the customer account only, never the anonymous visitor', () => {
  assert.equal(ga4Payload(richPurchase(), {}).user_id, 'a'.repeat(64));
  const guest = normalizeEvent({ event_name: 'Purchase', user_data: { external_id: 'visitor-1' } }, {});
  assert.equal(ga4Payload(guest, {}).user_id, undefined);
});

test('ga4 user_data: only Google-hashed values, and only with marketing consent', () => {
  assert.deepEqual(ga4Payload(richPurchase(), {}).user_data, {
    sha256_email_address: ['b'.repeat(64)], sha256_phone_number: ['c'.repeat(64)],
  });
  const noAds = richPurchase();
  noAds.consent = { marketing: false, statistics: true };
  assert.equal(ga4Payload(noAds, {}).user_data, undefined);
});

test('ga4 without _ga: one stable client id per visitor, not Meta\'s browser id', () => {
  const make = (id) => normalizeEvent({ event_name: 'PageView', event_id: id, user_data: { external_id: 'visitor-42' } }, { fbp: 'fb.1.1.2' });
  const a = ga4Payload(make('e1'), {}).client_id;
  const b = ga4Payload(make('e2'), {}).client_id;
  assert.equal(a, b);
  assert.match(a, /^\d+\.\d+$/);
  assert.notEqual(a, 'fb.1.1.2');
});

test('ga4: an event older than 72 hours is reported as dropped, not sent', async () => {
  const { send } = await import('../src/destinations/ga4.js');
  const old = normalizeEvent({ event_name: 'Purchase', event_time: Math.floor(Date.now() / 1000) - 73 * 3600 }, {});
  const res = await send(old, { measurement_id: 'G-1', api_secret: 's' });
  assert.equal(res.ok, false);
  assert.equal(res.retryable, false);
  assert.match(res.error, /72 h/);
});

test('meta gets items under its own keys and nothing it does not know', () => {
  const body = metaPayload(richPurchase(), { dataset_id: '1', access_token: 't' });
  assert.deepEqual(body.data[0].custom_data.contents, [
    { id: '501', quantity: 1, item_price: 57.6, title: 'Rastúci Kidvak', brand: 'Kidvak', category: 'Nábytok' },
  ]);
  assert.equal(body.data[0].custom_data.tax, undefined);
});

test('the order key never leaves with the thank-you page address', () => {
  const e = normalizeEvent({ event_name: 'Purchase', event_source_url: 'https://shop.sk/pokladna/order-received/77/?key=wc_order_AbC123&utm_source=x' }, {});
  assert.equal(e.event_source_url, 'https://shop.sk/pokladna/order-received/77/?utm_source=x');
  const only = normalizeEvent({ event_name: 'Purchase', event_source_url: 'https://shop.sk/order-received/77/?key=wc_order_AbC123' }, {});
  assert.equal(only.event_source_url, 'https://shop.sk/order-received/77/');
  const other = normalizeEvent({ event_name: 'PageView', event_source_url: 'https://shop.sk/?key=value' }, {});
  assert.equal(other.event_source_url, 'https://shop.sk/?key=value', 'other keys are left alone');
});

test('ga4 counts revenue without VAT when the site sends it; meta keeps the full total', () => {
  const e = normalizeEvent({
    event_name: 'Purchase', event_id: 'ord-9',
    custom_data: {
      value: 61.5, value_net: 45.85, tax: 11.75, shipping: 3.9, currency: 'EUR', order_id: 9,
      contents: [{ id: '501', item_name: 'Kidvak', quantity: 1, item_price: 56.4, price_net: 45.85 }],
    },
  }, {});
  const g = ga4Payload(e, {}).events[0].params;
  assert.equal(g.value, 45.85);
  assert.equal(g.items[0].price, 45.85);
  assert.equal(g.items[0].price_net, undefined, 'GA4 gets it as price');
  const m = metaPayload(e, { dataset_id: '1', access_token: 't' }).data[0].custom_data;
  assert.equal(m.value, 61.5);
  assert.equal(m.value_net, undefined);
  assert.equal(m.contents[0].item_price, 56.4);
  assert.equal(m.contents[0].price_net, undefined);
});
