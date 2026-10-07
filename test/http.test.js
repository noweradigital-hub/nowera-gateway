import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createHmac } from 'node:crypto';

const sha = (v) => createHash('sha256').update(v).digest('hex');

process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.INGEST_SECRET = 'ingest-secret';
process.env.DATABASE_URL = 'postgres://stub';
process.env.ADMIN_HOST = 'gw.example.com';

const TENANT = {
  id: 1, slug: 'klient', name: 'Klient', collector_host: 't.klient.sk',
  allowed_origins: 'https://klient.sk,https://www.klient.sk',
  cookie_domain: '.klient.sk',
  consent_mode: 'cookiescript',
  keep_path: '/wp-content/plugins/nowera-capi/keep.php',
  consent_prefix: 'cmplz_',
  destinations: [{ id: 10, kind: 'meta', settings: { dataset_id: '1', access_token: 't' } }],
};

// Stand in for Postgres: the collector only needs a tenant lookup and an enqueue.
const inserted = [];
// A tenant already moved to its own key, with purchases accepted only from its server.
const STRICT = {
  ...TENANT, id: 2, slug: 'prisny', collector_host: 't.prisny.sk',
  allowed_origins: 'https://prisny.sk',
  ingest_secret: 'tenant-key', legacy_ingest: false, server_only_events: 'Purchase, AddPaymentInfo',
};

const stubs = {
  tenantByHost: async (host) => {
    const h = String(host).split(':')[0];
    return h === TENANT.collector_host ? TENANT : h === STRICT.collector_host ? STRICT : null;
  },
  enqueue: async (tenantId, event, destinations) => {
    inserted.push({ tenantId, event, destinations });
    return destinations.length;
  },
  saveSnapshot: async (tenantId, snap) => { audits.push({ tenantId, snap }); },
};
const audits = [];

let app;
before(async () => {
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const formbody = (await import('@fastify/formbody')).default;
  const collectRoutes = (await import('../src/routes/collect.js')).default;

  app = Fastify({ logger: false, trustProxy: true });
  await app.register(cookie, { secret: 'x'.repeat(40) });
  await app.register(formbody);
  await app.register(collectRoutes, stubs);
  await app.ready();
});
after(async () => { await app?.close(); });

const HOST = 't.klient.sk';

test('health endpoint answers', async () => {
  const res = await app.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('px.js is served for a known host and carries the pixel id', async () => {
  const res = await app.inject({ method: 'GET', url: '/px.js', headers: { host: HOST } });
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-type'], /javascript/);
  assert.match(res.body, /"https:\/\/t\.klient\.sk\/e"/);
  assert.match(res.body, /PIXEL_ID = "1"/);
});

test('browser events from an allowed origin are accepted and queued', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'ViewContent', custom_data: { value: 10, currency: 'EUR' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().queued, 1);
  assert.equal(res.headers['access-control-allow-origin'], 'https://klient.sk');
  assert.equal(res.headers['access-control-allow-credentials'], 'true');
  assert.equal(inserted.length, 1);
});

test('a first-party _fbp cookie is set from the server, not from JavaScript', async () => {
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'PageView' },
  });
  const cookies = res.cookies.filter((c) => c.name === '_fbp');
  assert.equal(cookies.length, 1);
  assert.match(cookies[0].value, /^fb\.1\.\d+\.\d+$/);
  assert.equal(cookies[0].domain, '.klient.sk');
  assert.equal(cookies[0].sameSite, 'Lax');
  assert.ok(!cookies[0].httpOnly, 'the Meta pixel must be able to read _fbp');
});

test('_fbc is derived from fbclid on the landing url', async () => {
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'PageView', event_source_url: 'https://klient.sk/?fbclid=ABC123' },
  });
  const fbc = res.cookies.find((c) => c.name === '_fbc');
  assert.match(fbc.value, /^fb\.1\.\d+\.ABC123$/);
});

test('browser events from a foreign origin, or with none at all, are rejected', async () => {
  for (const origin of ['https://evil.sk', null]) {
    const headers = { host: HOST, 'content-type': 'application/json' };
    if (origin) headers.origin = origin;
    const res = await app.inject({ method: 'POST', url: '/e', headers, payload: { event_name: 'PageView' } });
    assert.equal(res.statusCode, 403, `origin ${origin ?? '(absent)'} must be refused`);
  }
});

test('malformed events are rejected with a reason', async () => {
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { custom_data: {} },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.json().error, /event_name is required/);
});

test('preflight echoes the allowed origin and refuses others', async () => {
  const ok = await app.inject({ method: 'OPTIONS', url: '/e', headers: { host: HOST, origin: 'https://www.klient.sk' } });
  assert.equal(ok.statusCode, 204);
  assert.equal(ok.headers['access-control-allow-origin'], 'https://www.klient.sk');

  const bad = await app.inject({ method: 'OPTIONS', url: '/e', headers: { host: HOST, origin: 'https://evil.sk' } });
  assert.equal(bad.statusCode, 403);
});

test('server events require a valid HMAC signature', async () => {
  const payload = JSON.stringify({ event_name: 'Purchase', event_id: 'ord-1', custom_data: { value: 49.9 } });
  const sign = (body, secret) => createHmac('sha256', secret).update(body).digest('hex');

  const good = await app.inject({
    method: 'POST', url: '/s',
    headers: { host: HOST, 'content-type': 'application/json', 'x-nwr-signature': sign(payload, 'ingest-secret') },
    payload,
  });
  assert.equal(good.statusCode, 200);
  assert.equal(good.json().event_id, 'ord-1');

  for (const sig of [sign(payload, 'wrong-secret'), 'short', null]) {
    const headers = { host: HOST, 'content-type': 'application/json' };
    if (sig) headers['x-nwr-signature'] = sig;
    const bad = await app.inject({ method: 'POST', url: '/s', headers, payload });
    assert.equal(bad.statusCode, 401, `signature ${sig ?? '(absent)'} must be refused`);
  }
});

test('an unsigned tampered body cannot ride on a valid signature', async () => {
  const original = JSON.stringify({ event_name: 'Purchase', custom_data: { value: 1 } });
  const tampered = JSON.stringify({ event_name: 'Purchase', custom_data: { value: 9999 } });
  const res = await app.inject({
    method: 'POST', url: '/s',
    headers: {
      host: HOST, 'content-type': 'application/json',
      'x-nwr-signature': createHmac('sha256', 'ingest-secret').update(original).digest('hex'),
    },
    payload: tampered,
  });
  assert.equal(res.statusCode, 401);
});

test('without marketing consent the gateway sets no marketing cookie and forwards no identifier', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: {
      host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json',
      cookie: '_fbp=fb.1.1.existing; _nwr_id=visitor-1',
    },
    payload: {
      event_name: 'PageView',
      event_source_url: 'https://klient.sk/?fbclid=CLICK',
      consent: { marketing: false, statistics: true },
    },
  });
  assert.equal(res.statusCode, 200);
  const names = res.cookies.map((c) => c.name);
  for (const n of ['_fbp', '_fbc', '_nwr_id']) assert.ok(!names.includes(n), `${n} must not be set`);

  const ev = inserted.at(-1).event;
  assert.equal(ev.context.fbp, null);
  assert.equal(ev.context.fbc, null);
  assert.equal(ev.user.external_id, undefined, 'visitor id is a marketing identifier too');
  assert.deepEqual(ev.consent, { marketing: false, statistics: true });
});

test('with marketing consent the identifiers flow as before', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'PageView', consent: { marketing: true, statistics: true } },
  });
  const names = res.cookies.map((c) => c.name);
  assert.ok(names.includes('_fbp'));
  assert.ok(names.includes('_nwr_id'));
  assert.ok(inserted.at(-1).event.user.external_id);
});

test('px.js carries the tenant consent mode so cached pages are covered too', async () => {
  const res = await app.inject({ method: 'GET', url: '/px.js', headers: { host: HOST } });
  assert.match(res.body, /var TENANT_CONSENT = \{"mode":"cookiescript","prefix":"cmplz_"\}/);
});

test('the visitor id from the loader wins over the gateway cookie', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: {
      host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json',
      cookie: '_nwr_id=older-cookie-id',
    },
    payload: { event_name: 'PageView', visitor_id: 'rnd-from-page-01' },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(inserted.at(-1).event.user.external_id, sha('rnd-from-page-01'), 'same id the pixel was given, hashed');
  const cookie = res.cookies.find((c) => c.name === '_nwr_id');
  assert.equal(cookie.value, 'rnd-from-page-01');
  assert.equal(cookie.domain, '.klient.sk');
});

test('a malformed visitor id from the page is ignored', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: {
      host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json',
      cookie: '_nwr_id=older-cookie-id',
    },
    payload: { event_name: 'PageView', visitor_id: '<script>alert(1)</script>' },
  });
  assert.equal(inserted.at(-1).event.user.external_id, sha('older-cookie-id'));
  assert.ok(!res.cookies.some((c) => c.name === '_nwr_id'), 'unchanged cookie is not rewritten');
});

test('px.js tells the loader which cookie domain the gateway writes to', async () => {
  const res = await app.inject({ method: 'GET', url: '/px.js', headers: { host: HOST } });
  assert.match(res.body, /var COOKIE_DOMAIN = "\.klient\.sk";/);
});

test('a crawler gets a polite answer and nothing else', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: {
      host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json',
      'user-agent': 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    },
    payload: { event_name: 'PageView', consent: { marketing: true, statistics: true } },
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true, filtered: 'bot' });
  assert.equal(inserted.length, 0, 'nothing queued');
  assert.equal(res.cookies.length, 0, 'no identity cookie for a crawler');

  const botPayload = JSON.stringify({ event_name: 'PageView', client_user_agent: 'AhrefsBot/7.0' });
  const server = await app.inject({
    method: 'POST', url: '/s',
    headers: {
      host: HOST, 'content-type': 'application/json',
      'x-nwr-signature': createHmac('sha256', 'ingest-secret').update(botPayload).digest('hex'),
    },
    payload: botPayload,
  });
  assert.equal(server.statusCode, 200);
  assert.equal(inserted.length, 0);
});

test('the click id is derived from the landing url when the site has no cookie yet', async () => {
  inserted.length = 0;
  const payload = JSON.stringify({
    event_name: 'InitiateCheckout',
    event_source_url: 'https://klient.sk/pokladna/?fbclid=CLICK123',
  });
  const res = await app.inject({
    method: 'POST', url: '/s',
    headers: {
      host: HOST, 'content-type': 'application/json',
      'x-nwr-signature': createHmac('sha256', 'ingest-secret').update(payload).digest('hex'),
    },
    payload,
  });
  assert.equal(res.statusCode, 200);
  assert.match(inserted.at(-1).event.context.fbc, /^fb\.1\.\d+\.CLICK123$/);
});

test('px.js carries the cookie keeper path, for pages cached before the site published it', async () => {
  const res = await app.inject({ method: 'GET', url: '/px.js', headers: { host: HOST } });
  assert.match(res.body, /var TENANT_KEEP = "\/wp-content\/plugins\/nowera-capi\/keep\.php";/);
});

// ------------------------------------------------------------ tenant keys

const signed = (secret, body, ts) => (ts === undefined
  ? createHmac('sha256', secret).update(body).digest('hex')
  : createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex'));
const now = () => Math.floor(Date.now() / 1000);

async function postServer(host, body, headers) {
  return app.inject({
    method: 'POST', url: '/s',
    headers: { host, 'content-type': 'application/json', ...headers },
    payload: body,
  });
}

test('a tenant with its own key: timestamped signature accepted, the shared key and old style refused', async () => {
  const body = JSON.stringify({ event_name: 'Purchase', event_id: 'ord-1', custom_data: { value: 5, currency: 'EUR' } });
  const ts = now();

  const ok = await postServer('t.prisny.sk', body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('tenant-key', body, ts) });
  assert.equal(ok.statusCode, 200);

  const shared = await postServer('t.prisny.sk', body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('ingest-secret', body, ts) });
  assert.equal(shared.statusCode, 401, 'another client\u2019s key must not work here');

  const old = await postServer('t.prisny.sk', body, { 'x-nwr-signature': signed('tenant-key', body) });
  assert.equal(old.statusCode, 401);
  assert.equal(old.json().error, 'timestamp required');
});

test('a signed request cannot be replayed after five minutes', async () => {
  const body = JSON.stringify({ event_name: 'Purchase', event_id: 'ord-2' });
  const ts = now() - 301;
  const res = await postServer('t.prisny.sk', body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('tenant-key', body, ts) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'stale request');
});

test('a tenant still on the shared key keeps working, old and new plugin alike', async () => {
  const body = JSON.stringify({ event_name: 'AddToCart' });
  const ts = now();
  assert.equal((await postServer(HOST, body, { 'x-nwr-signature': signed('ingest-secret', body) })).statusCode, 200);
  assert.equal((await postServer(HOST, body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('ingest-secret', body, ts) })).statusCode, 200);
});

test('events the tenant reports only from its server are not accepted from the browser', async () => {
  inserted.length = 0;
  const res = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: 't.prisny.sk', origin: 'https://prisny.sk', 'content-type': 'application/json' },
    payload: { event_name: 'Purchase', event_id: 'ord-3', custom_data: { value: 99999, currency: 'EUR' } },
  });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ignored, 'server_only');
  assert.equal(inserted.length, 0);
});

test('event ids and page addresses are bounded', async () => {
  const bad = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'PageView', event_id: 'x'.repeat(101) },
  });
  assert.equal(bad.statusCode, 400);

  inserted.length = 0;
  const long = 'https://klient.sk/produkt/?q=' + 'a'.repeat(3000);
  const ok = await app.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'PageView', event_source_url: long },
  });
  assert.equal(ok.statusCode, 200);
  assert.equal(inserted[0].event.event_source_url, 'https://klient.sk/produkt/');
});

test('a flood from one address is cut off, other visitors are not', async () => {
  const Fastify = (await import('fastify')).default;
  const cookie = (await import('@fastify/cookie')).default;
  const collectRoutes = (await import('../src/routes/collect.js')).default;
  const small = Fastify({ logger: false, trustProxy: true });
  await small.register(cookie, { secret: 'x'.repeat(40) });
  await small.register(collectRoutes, { ...stubs, browserLimit: { windowMs: 60_000, max: 2 } });
  await small.ready();
  const hit = (ip) => small.inject({
    method: 'POST', url: '/e',
    headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json', 'x-forwarded-for': ip },
    payload: { event_name: 'PageView' },
  });
  assert.equal((await hit('81.0.0.1')).statusCode, 200);
  assert.equal((await hit('81.0.0.1')).statusCode, 200);
  assert.equal((await hit('81.0.0.1')).statusCode, 429);
  assert.equal((await hit('81.0.0.2')).statusCode, 200);
  await small.close();
});

test('only the signed server leg may mark an event as never seen by a browser', async () => {
  inserted.length = 0;
  const ts = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ event_name: 'Refund', event_id: 'refund-9', browserless: true, custom_data: { order_id: 9, value: 5, currency: 'EUR' } });
  const sig = createHmac('sha256', 'tenant-key').update(`${ts}.${body}`).digest('hex');
  const res = await app.inject({ method: 'POST', url: '/s', headers: { host: 't.prisny.sk', 'content-type': 'application/json', 'x-nwr-timestamp': ts, 'x-nwr-signature': sig }, payload: body });
  assert.equal(res.statusCode, 200);
  assert.equal(inserted.at(-1).event.browserless, true);

  await app.inject({ method: 'POST', url: '/e', headers: { host: HOST, origin: 'https://klient.sk', 'content-type': 'application/json' },
    payload: { event_name: 'Purchase', browserless: true } });
  assert.notEqual(inserted.at(-1).event.browserless, true, 'a browser cannot claim it');
});


// ------------------------------------------------------------ order audit (/r)

async function postAudit(host, body, headers) {
  return app.inject({ method: 'POST', url: '/r', headers: { host, 'content-type': 'application/json', ...headers }, payload: body });
}

test('/r takes the shop\'s signed order list and nothing unsigned', async () => {
  audits.length = 0;
  const body = JSON.stringify({ day: '2026-10-06', page: 1, pages: 1, orders: [
    { id: 2025003069, created: 1791300000, paid: 1791300060, status: 'processing', total: 9244, currency: 'CZK',
      ready: true, consent: 'marketing', ctx: true, sent: true, thankyou: false, via: 'checkout', email: 'x@y.sk' },
    { id: 'not-an-id' },
  ] });
  const ts = now();
  const ok = await postAudit('t.prisny.sk', body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('tenant-key', body, ts) });
  assert.equal(ok.statusCode, 200);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].tenantId, 2);
  assert.equal(audits[0].snap.orders.length, 1, 'the line that is no order is dropped');
  assert.equal(audits[0].snap.orders[0].order_id, '2025003069');
  assert.equal(audits[0].snap.orders[0].email, undefined, 'no contact data is kept');

  const forged = await postAudit('t.prisny.sk', body, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('wrong', body, ts) });
  assert.equal(forged.statusCode, 401);
  const bad = JSON.stringify({ day: 'yesterday', orders: [] });
  const badRes = await postAudit('t.prisny.sk', bad, { 'x-nwr-timestamp': String(ts), 'x-nwr-signature': signed('tenant-key', bad, ts) });
  assert.equal(badRes.statusCode, 400);
  assert.equal(audits.length, 1);
});
