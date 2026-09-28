import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { normalizeEvent } from '../lib/event.js';
import { enqueue as defaultEnqueue } from '../lib/queue.js';
import { newEventId, newFbp, resolveFbc } from '../lib/ids.js';
import { originAllowed, tenantByHost as defaultTenantByHost } from '../lib/tenants.js';
import { loaderScript } from '../lib/loader.js';
import { normalizeConsent } from '../lib/consent.js';
import { isBot } from '../lib/bots.js';
import { clientIp } from '../lib/client-ip.js';
import { createLimiter } from '../lib/ratelimit.js';
import * as defaultStats from '../lib/stats-writer.js';

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

const VISITOR_ID = /^[A-Za-z0-9_-]{8,64}$/;

function ensureIdentity(req, reply, tenant, body = {}) {
  const cookies = req.cookies || {};

  // A first-party id that survives across sessions. Meta hashes it as external_id
  // and it is often the only stable identifier a guest checkout ever produces.
  // The loader's copy wins: it is the one the pixel was initialised with and the
  // one the site's own server events read, whatever the cookie domain setting.
  const fromPage = typeof body.visitor_id === 'string' && VISITOR_ID.test(body.visitor_id)
    ? body.visitor_id
    : null;
  let visitorId = fromPage || cookies._nwr_id || null;
  if (!visitorId) visitorId = newEventId();
  if (visitorId !== cookies._nwr_id) persistCookie(reply, tenant, '_nwr_id', visitorId);

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

// A signed request older than this is refused, so one captured on the way cannot
// be sent again later.
const REPLAY_WINDOW_SECONDS = 300;

const hmacHex = (secret, text) => createHmac('sha256', secret).update(text).digest('hex');

function sameHex(expected, given) {
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(given), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Check a server-to-server request from the tenant's site.
 *
 * The tenant's own key signs `<timestamp>.<body>`, the timestamp travelling in
 * X-NWR-Timestamp. While the tenant still allows the old way (legacy_ingest),
 * the shared INGEST_SECRET and a signature over the body alone are accepted
 * too — that is how sites keep working until their plugin has the new key.
 */
export function verifyServerRequest(tenant, rawBody, headers, nowMs = Date.now()) {
  const signature = headers['x-nwr-signature'];
  if (!signature) return 'bad signature';

  const legacy = tenant.legacy_ingest !== false;
  const secrets = [tenant.ingest_secret, tenant.ingest_secret_prev, legacy ? config.ingestSecret : null].filter(Boolean);

  const stamp = headers['x-nwr-timestamp'];
  if (stamp !== undefined) {
    const ts = Number(stamp);
    if (!Number.isInteger(ts) || Math.abs(nowMs / 1000 - ts) > REPLAY_WINDOW_SECONDS) return 'stale request';
    return secrets.some((s) => sameHex(hmacHex(s, `${ts}.${rawBody}`), signature)) ? null : 'bad signature';
  }
  if (!legacy) return 'timestamp required';
  return secrets.some((s) => sameHex(hmacHex(s, rawBody), signature)) ? null : 'bad signature';
}

/** Event names this tenant accepts only from its signed server leg. */
function serverOnly(tenant) {
  return new Set(String(tenant.server_only_events || '').split(',').map((s) => s.trim()).filter(Boolean));
}

// Browser requests per visitor address and minute. A shop page sends one to three
// events; this only stops a script hammering the endpoint.
const BROWSER_LIMIT = { windowMs: 60_000, max: 300 };

/**
 * Data access is injected rather than imported directly so the tests can drive
 * these routes without a database — and without experimental module mocking,
 * whose option names have already drifted between Node releases.
 */
export default async function collectRoutes(app, opts = {}) {
  const tenantByHost = opts.tenantByHost || defaultTenantByHost;
  const enqueue = opts.enqueue || defaultEnqueue;
  const browserLimit = createLimiter(opts.browserLimit || BROWSER_LIMIT);
  const stats = opts.stats || defaultStats;

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
        consent: normalizeConsent(tenant.consent_mode, tenant.consent_prefix),
        cookieDomain: tenant.cookie_domain || null,
        keepPath: tenant.keep_path || null,
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

    if (!browserLimit.hit(`${tenant.id}|${clientIp(req)}`)) {
      stats.countDropped(tenant.id, 'rate_limited');
      return reply.code(429).send({ error: 'too many requests' });
    }

    // A crawler is not a customer: answer it, but keep it out of the data and
    // give it no identity cookies.
    if (isBot(req.headers['user-agent'])) {
      stats.countDropped(tenant.id, 'bot');
      return reply.send({ ok: true, filtered: 'bot' });
    }

    const body = req.body || {};

    // _fbp, _fbc and _nwr_id are marketing identifiers. When the site says
    // marketing consent is missing, set none of them and forward none of them.
    const marketingDenied = body.consent && body.consent.marketing === false;
    const { visitorId, ...identity } = marketingDenied
      ? { visitorId: null, fbp: null, fbc: null }
      : ensureIdentity(req, reply, tenant, body);

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

    // The site's server already reports these, signed. A browser copy adds
    // nothing but a way to forge one, e.g. a Purchase with any value.
    if (serverOnly(tenant).has(event.event_name)) {
      stats.countDropped(tenant.id, 'server_only');
      return reply.send({ ok: true, event_id: event.event_id, queued: 0, ignored: 'server_only' });
    }

    event.source = 'browser';
    stats.recordReceived(tenant.id, event, 'browser');
    const queued = await enqueue(tenant.id, event, tenant.destinations);
    return reply.send({ ok: true, event_id: event.event_id, queued });
  });

  /**
   * Server-to-server events from the WordPress plugin, signed with the tenant's
   * key so nobody can inject fake purchases into a client's dataset.
   */
  app.post('/s', async (req, reply) => {
    const tenant = await tenantByHost(req.headers.host);
    if (!tenant) return reply.code(404).send({ error: 'unknown host' });

    const refused = verifyServerRequest(tenant, req.rawBody || '', req.headers);
    if (refused) return reply.code(401).send({ error: refused });
    stats.notePlugin(tenant.id, req.headers['x-nwr-plugin']);

    const body = req.body || {};
    if (isBot(body.client_user_agent || req.headers['user-agent'])) {
      stats.countDropped(tenant.id, 'bot');
      return reply.send({ ok: true, filtered: 'bot' });
    }

    let event;
    try {
      event = normalizeEvent(body, {
        // The plugin forwards the visitor's own address; req.ip here is the web server.
        ip: body.client_ip_address || clientIp(req),
        userAgent: body.client_user_agent || req.headers['user-agent'],
        referer: null,
        actionSource: body.action_source || 'website',
        fbp: body.fbp || req.cookies?._fbp || null,
        // The site may hold no _fbc cookie yet and still be serving the very
        // landing page that carries ?fbclid=.
        fbc: resolveFbc({
          cookie: body.fbc || req.cookies?._fbc || null,
          fbclid: body.fbclid,
          url: body.event_source_url,
        }),
        gaClientId: body.ga_client_id || null,
        gaSessionId: body.ga_session_id || null,
      });
    } catch (err) {
      return reply.code(400).send({ error: err.message });
    }

    event.source = 'server';
    stats.recordReceived(tenant.id, event, 'server');
    const queued = await enqueue(tenant.id, event, tenant.destinations);
    return reply.send({ ok: true, event_id: event.event_id, queued });
  });
}
