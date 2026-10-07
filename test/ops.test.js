import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

process.env.SESSION_SECRET ||= 'x'.repeat(40);
process.env.ADMIN_HOST ||= 'gw.example.com';

const { config } = await import('../src/config.js');
const secrets = await import('../src/lib/secrets.js');
const { signRequest } = await import('../src/lib/s3.js');
const backup = await import('../src/lib/backup.js');
const { deriveFromSite, detectConsent, pairingCode, readPairingCode } = await import('../src/lib/onboarding.js');
const { routeOf, traefikConfig, forgetDns } = await import('../src/lib/routing.js');
const { newer } = await import('../src/lib/plugin-release.js');
const { sealSettings, openSettings } = await import('../src/destinations/index.js');

test('secrets are sealed with AES-GCM, stored values from before pass through', () => {
  const sealed = secrets.seal('EAAtoken123');
  assert.match(sealed, /^enc:v1:[0-9a-f]{8}:/);
  assert.ok(!sealed.includes('EAAtoken123'));
  assert.equal(secrets.open(sealed), 'EAAtoken123');
  assert.notEqual(secrets.seal('EAAtoken123'), sealed, 'a fresh IV every time');
  assert.equal(secrets.seal(sealed), sealed, 'already sealed with the current key: unchanged');
  assert.equal(secrets.open('plain-old-value'), 'plain-old-value');
  assert.equal(secrets.seal(''), '');
  assert.equal(secrets.seal(null), null);
});

test('a tampered sealed value is refused, not decrypted into garbage', () => {
  const sealed = secrets.seal('secret');
  const flipped = sealed.slice(0, -3) + (sealed.slice(-3, -2) === 'A' ? 'B' : 'A') + sealed.slice(-2);
  assert.throws(() => secrets.open(flipped));
});

test('a new SECRETS_KEY still opens values sealed under the old key, and re-seals them', () => {
  const before = secrets.seal('ga4-api-secret');
  const recovery = secrets.recoveryKey();
  assert.match(recovery, /^nwrk1_/);
  const saved = config.secretsKey;
  try {
    config.secretsKey = createHash('sha256').update('another key').digest('hex');
    assert.equal(secrets.keySource(), 'SECRETS_KEY');
    assert.equal(secrets.open(before), 'ga4-api-secret', 'old key still in the ring');
    assert.equal(secrets.sealedWithCurrent(before), false);
    const again = secrets.seal(before);
    assert.notEqual(again.slice(7, 15), before.slice(7, 15), 'sealed under the new key');
    assert.equal(secrets.open(again), 'ga4-api-secret');
    // The recovery key printed by the old server opens its values on a new one.
    config.secretsKey = recovery;
    assert.equal(secrets.open(before), 'ga4-api-secret');
  } finally {
    config.secretsKey = saved;
  }
  assert.throws(() => secrets.parseKey('too short'), /32 bytes/);
});

test('only the secret fields of a destination are sealed', () => {
  const stored = sealSettings('meta', { dataset_id: '123', access_token: 'EAAx', test_event_code: 'TEST1' });
  assert.equal(stored.dataset_id, '123');
  assert.equal(stored.test_event_code, 'TEST1');
  assert.ok(secrets.isSealed(stored.access_token));
  assert.equal(openSettings('meta', stored).access_token, 'EAAx');
  assert.ok(secrets.isSealed(sealSettings('ga4', { measurement_id: 'G-1', api_secret: 's' }).api_secret));
});

test('S3 requests are signed exactly as the AWS Signature V4 examples', () => {
  const creds = { region: 'us-east-1', accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', now: new Date('2013-05-24T00:00:00Z') };
  const sig = (o) => signRequest({ ...creds, ...o }).signature;
  assert.equal(sig({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { Range: 'bytes=0-9' } }),
    'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(sig({ method: 'PUT', url: 'https://examplebucket.s3.amazonaws.com/test$file.text', body: 'Welcome to Amazon S3.',
    headers: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' } }),
  '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
  assert.equal(sig({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?lifecycle' }),
    'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  assert.equal(sig({ method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' }),
    '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('a backup is encrypted, opens with the same key, and refuses tampering', () => {
  const data = Buffer.from('{"nwr_backup":1}\n'.repeat(50));
  const file = backup.encryptBackup(data);
  assert.equal(file.subarray(0, 4).toString(), 'NWRB');
  assert.ok(!file.includes(Buffer.from('nwr_backup')));
  assert.deepEqual(backup.decryptBackup(file), data);
  const bad = Buffer.from(file);
  bad[40] ^= 1;
  assert.throws(() => backup.decryptBackup(bad), /poškodená/);
  assert.throws(() => backup.decryptBackup(Buffer.from('not a backup at all, clearly not one')), /nie je záloha/);
});

test('backups run nightly, catch up after a gap, and wait an hour after a failure', () => {
  const s = { endpoint: 'https://x', bucket: 'b', access_key_id: 'a', secret_access_key: 's' };
  const at = (iso) => new Date(iso).getTime();
  // 03:30 in Bratislava (UTC+2 in September), last backup yesterday night.
  assert.equal(backup.backupDue(s, { last_ok_at: '2026-09-27T01:20:00Z' }, at('2026-09-28T01:30:00Z')), true);
  assert.equal(backup.backupDue(s, { last_ok_at: '2026-09-28T01:20:00Z' }, at('2026-09-28T01:40:00Z')), false, 'done tonight already');
  assert.equal(backup.backupDue(s, { last_ok_at: '2026-09-27T12:00:00Z' }, at('2026-09-28T10:00:00Z')), false, 'daytime, 22 h old');
  assert.equal(backup.backupDue(s, { last_ok_at: '2026-09-27T01:20:00Z' }, at('2026-09-28T10:00:00Z')), true, 'over 30 h: catch up');
  assert.equal(backup.backupDue(s, {}, at('2026-09-28T10:00:00Z')), true, 'never backed up');
  assert.equal(backup.backupDue(s, { last_attempt_at: '2026-09-28T09:30:00Z' }, at('2026-09-28T10:00:00Z')), false, 'failed half an hour ago');
  assert.equal(backup.backupDue({ ...s, bucket: '' }, {}, at('2026-09-28T10:00:00Z')), false, 'not configured');
});

test('backup storage settings are checked before they are saved', () => {
  const ok = backup.cleanSettings({ endpoint: 'https://abc.r2.cloudflarestorage.com/', bucket: 'nowera-zalohy', prefix: 'gw',
    access_key_id: 'AK', secret_access_key: 'SK', keep_days: '14' }, {});
  assert.equal(ok.value.endpoint, 'https://abc.r2.cloudflarestorage.com');
  assert.equal(ok.value.prefix, 'gw/');
  assert.equal(ok.value.keep_days, 14);
  assert.ok(ok.value.configured_at);
  assert.match(backup.cleanSettings({ endpoint: 'http://x.sk', bucket: 'b-1', access_key_id: 'a', secret_access_key: 's' }, {}).error, /https/);
  assert.match(backup.cleanSettings({ endpoint: 'https://x.sk', bucket: 'Bad_Bucket', access_key_id: 'a', secret_access_key: 's' }, {}).error, /bucket/i);
  const keep = backup.cleanSettings({ endpoint: 'https://x.sk', bucket: 'bkt', access_key_id: 'a', secret_access_key: '' }, { secret_access_key: 'stored' });
  assert.equal(keep.value.secret_access_key, 'stored', 'a blank secret keeps the stored one');
});

test('a new client is described by its website address alone', () => {
  assert.deepEqual(deriveFromSite('https://www.klient.sk/obchod'), {
    host: 'www.klient.sk', domain: 'klient.sk', slug: 'klient', collector_host: 't.klient.sk',
    allowed_origins: 'https://klient.sk,https://www.klient.sk', cookie_domain: '.klient.sk', site_url: 'https://www.klient.sk',
  });
  const shop = deriveFromSite('shop.moja-firma.cz');
  assert.equal(shop.collector_host, 't.moja-firma.cz');
  assert.equal(shop.allowed_origins, 'https://moja-firma.cz,https://www.moja-firma.cz,https://shop.moja-firma.cz');
  assert.equal(deriveFromSite('www.sklep.com.pl').cookie_domain, '.sklep.com.pl');
  assert.equal(deriveFromSite('not a site'), null);
  assert.equal(deriveFromSite(''), null);
});

test('the consent tool is recognised from the page', async () => {
  const page = (html) => async () => ({ text: async () => html });
  assert.equal(await detectConsent('https://x', page('<script src="https://geo.cookie-script.com/s/abc.js">')), 'cookiescript');
  assert.equal(await detectConsent('https://x', page('<div id="cmplz-cookiebanner-container">')), 'complianz');
  assert.equal(await detectConsent('https://x', page('<script id="faz-cookie-manager-js" src="/wp-content/plugins/faz-cookie-manager/frontend/js/script.min.js">')), 'faz');
  assert.equal(await detectConsent('https://x', page('<html></html>')), 'none');
  assert.equal(await detectConsent('https://x', async () => { throw new Error('timeout'); }), null);
});

test('a pairing code carries the host and key together', () => {
  const code = pairingCode('t.klient.sk', 'ab'.repeat(32));
  assert.match(code, /^nwr1\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(readPairingCode(code), { host: 't.klient.sk', key: 'ab'.repeat(32) });
  assert.equal(readPairingCode('nwr1.@@@'), null);
  assert.equal(readPairingCode('something else'), null);
});

test('Traefik gets a router only for hosts whose DNS already points here', async () => {
  forgetDns();
  const dns = { 't.direct.sk': ['31.97.179.201'], 't.proxied.sk': ['104.21.63.80', '172.67.144.55'], 't.elsewhere.sk': ['193.163.77.230'], 't.missing.sk': [] };
  const resolve = async (h) => dns[h] || [];
  const opts = { resolve, serverIp: '31.97.179.201' };
  assert.equal(await routeOf('t.direct.sk', opts), 'direct');
  assert.equal(await routeOf('t.proxied.sk', opts), 'cloudflare');
  assert.equal(await routeOf('t.elsewhere.sk', opts), null);
  const cfg = await traefikConfig({ ...opts, tenants: Object.keys(dns).map((h) => ({ collector_host: h })) });
  assert.deepEqual(Object.keys(cfg.http.routers).sort(), ['nwrgw-t-direct-sk', 'nwrgw-t-proxied-sk']);
  assert.deepEqual(cfg.http.routers['nwrgw-t-direct-sk'], {
    rule: 'Host(`t.direct.sk`)', entryPoints: ['web', 'websecure'], service: 'nwrgw@docker', tls: { certResolver: 'mytlschallenge' },
  });
  assert.deepEqual(cfg.http.routers['nwrgw-t-proxied-sk'].tls, {}, 'behind Cloudflare: no ACME challenge that could never pass');
});

test('plugin versions compare by number, not as text', () => {
  assert.equal(newer('1.10.0', '1.9.2'), true);
  assert.equal(newer('1.0.0', '0.9.0'), true);
  assert.equal(newer('0.9.0', '0.9.0'), false);
  assert.equal(newer('0.9.0', '1.0.0'), false);
});

test('plugin updates are served only on known hosts, with a download address on the same host', async () => {
  const Fastify = (await import('fastify')).default;
  const updateRoutes = (await import('../src/routes/updates.js')).default;
  const app = Fastify({ logger: false });
  const release = { version: '1.0.0', file: 'nowera-capi-1.0.0.zip', sha256: 'abc', signature: 'sig' };
  await app.register(updateRoutes, {
    lookupTenant: async (h) => (h === 't.klient.sk' ? { id: 1 } : null),
    release: () => release,
    file: (name) => (name === 'nowera-capi-1.0.0.zip' ? Buffer.from('PK') : null),
  });
  const info = await app.inject({ method: 'GET', url: '/wp/nowera-capi/info.json', headers: { host: 't.klient.sk' } });
  assert.equal(info.statusCode, 200);
  assert.equal(info.json().download_url, 'https://t.klient.sk/wp/nowera-capi/nowera-capi-1.0.0.zip');
  assert.equal(info.headers['cache-control'], 'no-store');
  const zip = await app.inject({ method: 'GET', url: '/wp/nowera-capi/nowera-capi-1.0.0.zip', headers: { host: 't.klient.sk' } });
  assert.equal(zip.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/wp/nowera-capi/info.json', headers: { host: 'evil.example' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/wp/nowera-capi/..%2Fsecret.zip', headers: { host: 't.klient.sk' } })).statusCode, 404);
  await app.close();
});

test('GA4 next to a browser tag takes only what no browser sent; Meta never takes a refund', async () => {
  const { wants } = await import('../src/destinations/index.js');
  const { buildPayload } = await import('../src/destinations/ga4.js');
  const meta = { kind: 'meta', settings: {} };
  const ga4All = { kind: 'ga4', settings: {} };
  const ga4Gtm = { kind: 'ga4', settings: { scope: 'browserless' } };
  const purchase = { event_name: 'Purchase' };
  const paidWithoutReturn = { event_name: 'Purchase', browserless: true };
  const refund = { event_name: 'Refund', browserless: true };

  assert.equal(wants(meta, purchase), true);
  assert.equal(wants(meta, refund), false, 'Meta has no refund event');
  assert.equal(wants(ga4All, purchase), true, 'a GA4 without a browser tag gets everything, as before');
  assert.equal(wants(ga4Gtm, purchase), false, 'the browser tag already reported it');
  assert.equal(wants(ga4Gtm, paidWithoutReturn), true);
  assert.equal(wants(ga4Gtm, refund), true);

  const body = buildPayload({
    event_name: 'Refund', event_id: 'refund-55', event_time: 1790000000,
    properties: { order_id: 2025003367, value: 24.9, currency: 'EUR', contents: [{ id: '10', quantity: 1, item_price: 24.9 }] },
    context: { gaClientId: '123.456', gaSessionId: '789' },
  }, {});
  assert.equal(body.events[0].name, 'refund');
  assert.equal(body.events[0].params.transaction_id, '2025003367', 'matches the purchase GTM reported');
  assert.equal(body.events[0].params.value, 24.9);
  assert.deepEqual(body.events[0].params.items, [{ item_id: '10', item_name: undefined, quantity: 1, price: 24.9 }]);
  assert.equal(body.client_id, '123.456', 'the buyer, as GA4 knows them from the browser');
});

test('the GA4 destination form offers the scope: no page_view for a new one, all for an old one', async () => {
  const { SCHEMAS } = await import('../src/destinations/index.js');
  const { destinationsTab } = await import('../src/views/tenant.js');
  const { destinationForm } = await import('../src/views/pages.js');
  const add = destinationsTab({ id: 1 }, [], SCHEMAS, 'v26.0');
  assert.match(add, /<select id="ga4_scope" name="scope"><option value="no_page_view" selected>/);
  const edit = destinationForm({ id: 1, name: 'K' }, { id: 6, kind: 'ga4', settings: { measurement_id: 'G-1', api_secret: 'enc:v1:x', scope: 'browserless' } }, SCHEMAS.ga4);
  assert.match(edit, /<option value="browserless" selected>/);
  assert.ok(!edit.includes('enc:v1:x'), 'the secret stays hidden');
  // Saved before the field existed: it sends everything, and the form must say so
  // rather than offer a value that a save would silently switch to.
  const old = destinationForm({ id: 1, name: 'K' }, { id: 7, kind: 'ga4', settings: { measurement_id: 'G-1' } }, SCHEMAS.ga4);
  assert.match(old, /<option value="all" selected>/);
});

test('GA4 "no page_view" leaves page views to the Google tag and sends everything else', async () => {
  const { wants } = await import('../src/destinations/index.js');
  const dest = { kind: 'ga4', settings: { scope: 'no_page_view' } };
  assert.equal(wants(dest, { event_name: 'PageView' }), false);
  for (const name of ['ViewContent', 'AddToCart', 'InitiateCheckout', 'AddPaymentInfo', 'Purchase', 'Refund', 'Search']) {
    assert.equal(wants(dest, { event_name: name }), true, name);
  }
  assert.equal(wants({ kind: 'ga4', settings: {} }, { event_name: 'PageView' }), true, 'unset means all');
});

test('routing: GA4-only funnel steps skip Meta, GA4 names them its way', async () => {
  const { wants } = await import('../src/destinations/index.js');
  const { buildPayload } = await import('../src/destinations/ga4.js');
  for (const [name, ga] of [['ViewCart', 'view_cart'], ['RemoveFromCart', 'remove_from_cart'], ['AddShippingInfo', 'add_shipping_info'], ['SelectItem', 'select_item'], ['Login', 'login']]) {
    assert.equal(wants({ kind: 'meta', settings: {} }, { event_name: name }), false, name);
    assert.equal(wants({ kind: 'ga4', settings: { scope: 'no_page_view' } }, { event_name: name }), true, name);
    assert.equal(buildPayload({ event_name: name, event_id: 'x', event_time: 1, properties: {} }, {}).events[0].name, ga);
  }
  const ship = buildPayload({ event_name: 'AddShippingInfo', event_id: 'x', event_time: 1, properties: { shipping_tier: 'Kuriér' } }, {});
  assert.equal(ship.events[0].params.shipping_tier, 'Kuriér');
});


// ------------------------------------------------------------ order audit

test('order audit: each order is delivered, excluded with a reason, pending or missing', async () => {
  const { classifyOrder } = await import('../src/lib/order-audit.js');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const old = '2026-10-07T06:00:00Z';
  const fresh = '2026-10-07T11:30:00Z';
  const both = [{ kind: 'meta' }, { kind: 'ga4', scope: 'no_page_view' }];
  const base = { ready: true, consent: 'marketing', has_ctx: true, via: 'checkout', status: 'processing', created_at: old, paid_at: old };
  const c = (o, ev = {}) => classifyOrder({ ...base, ...o }, { destinations: both, now, ...ev });

  assert.equal(c({}, { received: true, deliveries: { meta: 'sent', ga4: 'sent' } }).state, 'ok');
  assert.match(c({ ready: false, status: 'failed' }).reason, /failed/);
  assert.equal(c({ consent: 'none' }).reason, 'bez súhlasu s cookies');
  assert.equal(c({ consent: '', has_ctx: false, via: 'admin' }).state, 'excluded');
  assert.equal(c({ consent: '', paid_at: fresh, created_at: fresh }).state, 'pending');
  assert.equal(c({ consent: '' }).state, 'missing');
  assert.equal(c({}, { received: false }).reason, 'neprišiel do signals');
  assert.equal(c({}, { received: true, deliveries: { meta: 'dead', ga4: 'sent' } }).reason, 'Meta: nedoručené');
  assert.equal(c({}, { received: true, deliveries: { meta: 'sent', ga4: 'pending' } }).state, 'pending');
  // Statistics only: Meta is not owed this purchase.
  assert.equal(c({ consent: 'statistics' }, { received: true, deliveries: { ga4: 'sent' } }).state, 'ok');
  // A GA4 fed by GTM: a purchase the thank-you page showed is GTM's to report.
  const gtm = classifyOrder({ ...base, thankyou: true }, { destinations: [{ kind: 'meta' }, { kind: 'ga4', scope: 'browserless' }], received: true, deliveries: { meta: 'sent' }, now });
  assert.equal(gtm.state, 'ok');
  assert.equal(gtm.per.ga4, 'gtm');
});

test('order audit: days add up, missing orders are listed', async () => {
  const { summarise } = await import('../src/lib/order-audit.js');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const row = (id, o) => ({ order_id: id, day: '2026-10-06', status: 'processing', ready: true, consent: 'marketing', has_ctx: true, via: 'checkout',
    created_at: '2026-10-06T10:00:00Z', received: true, deliveries: { meta: 'sent' }, ...o });
  const { days, missing } = summarise([
    row('1'), row('2', { received: false }), row('3', { consent: 'none' }), row('4', { ready: false, status: 'failed' }),
  ], [{ kind: 'meta' }], now);
  assert.deepEqual(days, [{ day: '2026-10-06', orders: 4, eligible: 3, consented: 2, received: 1, ok: 1, pending: 0, missing: 1, excluded: 2 }]);
  assert.deepEqual(missing, [{ order_id: '2', day: '2026-10-06', status: 'processing', reason: 'neprišiel do signals' }]);
});

test('order audit: the snapshot must be one day, a list, at most 500 lines', async () => {
  const { parseSnapshot } = await import('../src/lib/order-audit.js');
  assert.throws(() => parseSnapshot({ day: '2026-13-40', orders: [] }));
  assert.throws(() => parseSnapshot({ day: '2026-10-06' }));
  assert.throws(() => parseSnapshot({ day: '2026-10-06', orders: new Array(501).fill({ id: 1 }) }));
  assert.throws(() => parseSnapshot({ day: '2026-10-06', page: 3, pages: 2, orders: [] }));
  assert.deepEqual(parseSnapshot({ day: '2026-10-06', orders: [] }), { day: '2026-10-06', page: 1, pages: 1, total: null, cron: null, orders: [] });
  assert.deepEqual(parseSnapshot({ day: '2026-10-06', cron: { disabled: true, due: '3', oldest: 900, x: 1 }, orders: [] }).cron, { disabled: true, due: 3, oldest: 900 });
  assert.equal(parseSnapshot({ day: '2026-10-06', total: 201, orders: [] }).total, 201);
});

// ------------------------------------------------------------ site WP-Cron

test('WP-Cron address: the site\'s own wp-cron.php, never anywhere else', async () => {
  const { cronUrl, normalizeCronUrl, publicAddress } = await import('../src/lib/site-cron.js');
  const t = { allowed_origins: 'https://kidvak.cz,https://www.kidvak.cz' };
  assert.equal(cronUrl(t), 'https://www.kidvak.cz/wp-cron.php');
  assert.equal(cronUrl({ ...t, cron_url: 'https://kidvak.cz/wp-cron.php?x=1' }), 'https://kidvak.cz/wp-cron.php');
  assert.equal(cronUrl({ ...t, cron_url: 'https://kidvak.cz/sub/wp-cron.php' }), 'https://kidvak.cz/sub/wp-cron.php', 'WordPress in a folder');
  assert.equal(cronUrl({ ...t, cron_url: 'https://www.kidvak.cz/moj-ucet/zmazat' }), null, 'only wp-cron.php');
  assert.equal(cronUrl({ ...t, cron_url: 'https://evil.example/wp-cron.php' }), null);
  assert.equal(cronUrl({ ...t, cron_url: 'http://www.kidvak.cz/wp-cron.php' }), null, 'https only');
  assert.equal(normalizeCronUrl('', t), null, 'empty keeps the default');
  for (const ip of ['10.0.0.5', '127.0.0.1', '172.18.0.6', '192.168.1.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:127.0.0.1']) {
    assert.equal(publicAddress(ip), false, ip);
  }
  assert.equal(publicAddress('193.163.77.230'), true);
  assert.equal(publicAddress('2a02:4780:41:bf7f::1'), true);
});

test('WP-Cron call: plain external call, a line for the dashboard whatever happens', async () => {
  const { runSiteCron } = await import('../src/lib/site-cron.js');
  const t = { allowed_origins: 'https://www.klient.sk' };
  const res = (status, headers = {}) => ({ status, headers: { get: (n) => headers[n] ?? null }, body: null });
  const urls = [];
  const ok = await runSiteCron(t, async (url) => { urls.push(url); return res(200); }, 1791380400000);
  assert.equal(ok.ok, true);
  assert.equal(urls[0], 'https://www.klient.sk/wp-cron.php?nwr=1791380400');
  assert.doesNotMatch(urls[0], /doing_wp_cron/, 'WordPress would take it as someone else\'s lock and do nothing');
  assert.deepEqual(await runSiteCron(t, async () => res(403), 0), { ok: false, text: 'HTTP 403' });
  assert.match((await runSiteCron(t, async () => res(403, { 'cf-mitigated': 'challenge' }), 0)).text, /Cloudflare/);
  assert.match((await runSiteCron(t, async () => res(301), 0)).text, /presmerovanie/);
  assert.match((await runSiteCron(t, async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; }, 0)).text, /neodpovedal/);
  // The connection itself refuses a name that resolves inside the server's network.
  const { publicLookup } = await import('../src/lib/site-cron.js');
  const err = await new Promise((r) => publicLookup('localhost', {}, (e) => r(e)));
  assert.equal(err.code, 'ENOTPUBLIC');
});

test('WP-Cron install check: calls, fresh plugin reports, server cron, unknown', async () => {
  const { cronCheck } = await import('../src/lib/site-cron.js');
  const now = Date.parse('2026-10-07T12:00:00Z');
  const fresh = (r) => ({ ...r, at: '2026-10-07T09:00:00Z' });
  const calling = { cron_enabled: true, cron_last_at: '2026-10-07T11:58:00Z', cron_ok_at: '2026-10-07T11:58:00Z', cron_last_ok: true, cron_last_status: 'HTTP 200, 300 ms' };
  assert.equal(cronCheck(calling, now).state, 'todo', 'WordPress answered; the plugin has not confirmed the tasks yet');
  assert.equal(cronCheck({ ...calling, cron_report: fresh({ disabled: false, due: 0 }) }, now).state, 'ok');
  assert.equal(cronCheck({ ...calling, cron_report: fresh({ disabled: false, due: 3, oldest: 3600 }) }, now).state, 'warn', 'answered, but tasks are late');
  assert.equal(cronCheck({ cron_enabled: true, cron_last_at: '2026-10-07T11:58:00Z', cron_last_ok: false, cron_last_status: 'HTTP 403' }, now).state, 'bad');
  assert.equal(cronCheck({ cron_enabled: false, cron_report: fresh({ disabled: true, due: 0 }) }, now).state, 'ok', 'a server cron is fine');
  assert.equal(cronCheck({ cron_enabled: false, cron_report: fresh({ disabled: true, due: 5, oldest: 7200 }) }, now).state, 'bad');
  assert.match(cronCheck({ cron_enabled: false, cron_report: fresh({ disabled: false, due: 4, oldest: 900 }) }, now).text, /4 úloh/);
  assert.equal(cronCheck({ cron_enabled: false, cron_report: { disabled: true, due: 0, at: '2026-10-05T00:00:00Z' } }, now).state, 'warn', 'an old report proves nothing');
  assert.equal(cronCheck({ cron_enabled: false }, now).state, 'warn');
});
