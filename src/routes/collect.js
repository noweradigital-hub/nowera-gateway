import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { normalizeEvent } from '../lib/event.js';
import { enqueue as defaultEnqueue } from '../lib/queue.js';
import { newEventId, newFbp, resolveFbc } from '../lib/ids.js';
import { originAllowed, tenantByHost as defaultTenantByHost } from '../lib/tenants.js';
import { loaderScript } from '../lib/loader.js';

const COOKIE_MAX_AGE = 90 * 86400; // Meta treats _fbp/_fbc as valid for 90 days

/**
 * Cookies are written from the server, not from JavaScript. Safari's ITP caps
 * document.cookie lifetimes at 7 days but leaves Set-Cookie from a first-party
 * host alone — that is the whole point of running on the client's own subdomain.
 * They are deliberately NOT HttpOnly: the Meta browser pixel has to read _fbp so
 * both legs of the same visit share one browser id.
 */
function persistCookie(reply, tenant, name, value) {
  reply.setCookie(name, value, {
    path: '/',
    domain: tenant.cookie_domain || undefined,
    maxAge: COOKIE_MAX_AGE,
    sameSite: 'lax',
    secure: true,
    httpOnly: false,
  });
}

function clientIp(req) {
  // Traefik terminates TLS and sets X-Forwarded-For; take the original client.
  const fwd = req.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return req.ip;
}

function ensureIdentity(req, reply, tenant, body = {}) {
  const cookies = req.cookies || {};

  // A first-party id that survives across sessions. Meta hashes it as external_id
  // and it is often the only stable identifier a guest checkout ever produces.
  let visitorId = cookies._nwr_id || null;
  if (!visitorId) {
    visitorId = newEventId();
    persistCookie(reply, tenant, '_nwr_id', visitorId);
  }

  let fbp = cookies._fbp || body.fbp || null;
  if (!fbp) {
    fbp = newFbp();
    persistCookie(reply, tenant, '_fbp', fbp);
  }
  const fbc = resolveFbc({
    cookie: cookies._fbc || body.fbc || null,
    fbclid: body.fbclid,
    url: body.event_source_url || body.url || req.headers.referer,
  });
  if (fbc && fbc !== cookies._fbc) persistCookie(reply, tenant, '_fbc', fbc);
  return { fbp, fbc, visitorId };
}

function verifySignature(rawBody, signature) {
  if (!signature) return false;
  const expected = createHmac('sha256', config.ingestSecret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Data access is injected rather than imported directly so the tests can drive
 * these routes without a database — and without experimental module mocking,
 * whose option names have already drifted between Node releases.
 */
export default async function collectRoutes(app, opts = {}) {
  const tenantByHost = opts.tenantByHost || defaultTenantByHost;
  const enqueue = opts.enqueue || defaultEnqueue;

  // Keep the raw body around so the HMAC is computed over exactly what was sent.
  app.addHook('preParsing', async (req, _reply, payload) => {
    if (req.routeOptions?.url !== '/s') return payload;
    const chunks = [];
    for await (const chunk of payload) chunks.push(chunk);
    const raw = Buffer.concat(chunks);
    req.rawBody = raw.toString('utf8');
    const stream = (await import('node:stream')).Readable.from(raw);
    return stream;
  });

  app.get('/health', async () => ({ ok: true }));

  /** First-party loader, served from the client's own subdomain. */
  app.get('/px.js', async (req, reply) => {
    const tenant = await tenantByHost(req.headers.host);
    if (!tenant) return reply.code(404).type('text/plain').send('// unknown host');

    const metaDest = tenant.destinations.find((d) => d.kind === 'meta');
    const ga4Dest = tenant.destinations.find((d) => d.kind === 'ga4');
    reply
      .type('application/javascript; charset=utf-8')
      .header('cache-control', 'public, max-age=300')
      .send(loaderScript({
        endpoint: `https://${tenant.collector_host}/e`,
        pixelId: metaDest?.settings?.dataset_id || null,
        measurementId: ga4Dest?.settings?.measurement_id || null,
      }));
  });

  app.options('/e', async (req, reply) => {
    const tenant = await tenantByHost(req.headers.host);
    const origin = req.headers.origin;
    if (!tenant || !originAllowed(tenant, origin)) return reply.code(403).send();
    reply
      .header('access-control-allow-origin', origin)
      .header('access-control-allow-credentials', 'true')
      .header('access-control-allow-headers', 'content-type')
      .header('access-control-allow-methods', 'POST, OPTIONS')
      .header('access-control-max-age', '86400')
      .code(204)
      .send();
  });

  /** Browser events. Authenticated by Origin, not by a secret — the page is public. */
  app.post('/e', async (req, reply) => {
    const tenant = await tenantByHost(req.headers.host);
    if (!tenant) return reply.code(404).send({ error: 'unknown host' });

    const origin = req.headers.origin;
    if (!originAllowed(tenant, origin)) {
      return reply.code(403).send({ error: 'origin not allowed' });
    }
    reply
      .header('access-control-allow-origin', origin)
      .header('access-control-allow-credentials', 'true');

    const body = req.body || {};
    const { visitorId, ...identity } = ensureIdentity(req, reply, tenant, body);

    // Only as a fallback: a real customer id from the site is always better.
    if (visitorId && !body.user_data?.external_id && !body.user?.external_id) {
      body.user_data = { ...(body.user_data || body.user || {}), external_id: visitorId };
    }

    let event;
    try {
      event = normalizeEvent(body, {
        ip: clientIp(req),
        userAgent: req.headers['user-agent'],
        referer: req.headers.referer,
        actionSource: 'website',
        ...identity,
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    const queued = await enqueue(tenant.id, event, tenant.destinations);
    return reply.send({ ok: true, event_id: event.event_id, queued });
  });

  /**
   * Server-to-server events from the WordPress plugin. Signed with the shared
   * ingest secret so nobody can inject fake purchases into a client's dataset.
   */
  app.post('/s', async (req, reply) => {
    const tenant = await tenantByHost(req.headers.host);
    if (!tenant) return reply.code(404).send({ error: 'unknown host' });

    if (!verifySignature(req.rawBody || '', req.headers['x-nwr-signature'])) {
      return reply.code(401).send({ error: 'bad signature' });
    }

    const body = req.body || {};
    let event;
    try {
      event = normalizeEvent(body, {
        // The plugin forwards the visitor's own address; req.ip here is the web server.
        ip: body.client_ip_address || clientIp(req),
        userAgent: body.client_user_agent || req.headers['user-agent'],
        referer: null,
        actionSource: body.action_source || 'website',
        fbp: body.fbp || req.cookies?._fbp || null,
        fbc: body.fbc || req.cookies?._fbc || null,
        gaClientId: body.ga_client_id || null,
        gaSessionId: body.ga_session_id || null,
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    const queued = await enqueue(tenant.id, event, tenant.destinations);
    return reply.send({ ok: true, event_id: event.event_id, queued });
  });
}
