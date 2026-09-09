import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

process.env.SESSION_SECRET = 'x'.repeat(40);
process.env.INGEST_SECRET = 'ingest-secret';
process.env.DATABASE_URL = 'postgres://stub';
process.env.ADMIN_HOST = 'gw.example.com';

const TENANT = {
  id: 1, slug: 'klient', name: 'Klient', collector_host: 't.klient.sk',
  allowed_origins: 'https://klient.sk,https://www.klient.sk',
  cookie_domain: '.klient.sk',
  destinations: [{ id: 10, kind: 'meta', settings: { dataset_id: '1', access_token: 't' } }],
};

// Stand in for Postgres: the collector only needs a tenant lookup and an enqueue.
const inserted = [];
const stubs = {
  tenantByHost: async (host) =>
    (String(host).split(':')[0] === TENANT.collector_host ? TENANT : null),
  enqueue: async (tenantId, event, destinations) => {
    inserted.push({ tenantId, event, destinations });
    return destinations.length;
  },
};

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
