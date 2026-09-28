import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import {
  MIN_PASSWORD_LENGTH, changePassword, createSession, destroySession,
  getSessionUser, hashPassword, validateNewPassword, verifyPassword,
} from '../lib/auth.js';
import { SCHEMAS, TEST_MODE_MINUTES, testModeActive } from '../destinations/index.js';
import { createLimiter } from '../lib/ratelimit.js';
import { clientIp } from '../lib/client-ip.js';
import { invalidateTenantCache } from '../lib/tenants.js';
import { enqueue } from '../lib/queue.js';
import { newEventId } from '../lib/ids.js';
import { page } from '../views/layout.js';
import { normalizeConsent, normalizeKeepPath } from '../lib/consent.js';
import {
  accountPage, destinationForm, ingestKeyPage, loginPage, newTenantPage,
} from '../views/pages.js';
import {
  destinationStats, eventDetail, eventList, eventNames, healthOf, overview, quality, qualityFindings,
  retryEvent, tenantOverview,
} from '../lib/stats.js';
import { forgetChecks, runChecks } from '../lib/checks.js';
import { verifyMeta } from '../destinations/verify.js';
import { overviewPage } from '../views/overview.js';
import {
  TABS, destinationsTab, installTab, overviewTab, qualityTab, settingsTab, tenantHeader,
} from '../views/tenant.js';
import { eventBrowser } from '../views/events.js';

/** A tenant's signing key: 256 random bits, shown once and pasted into the plugin. */
const newIngestKey = () => randomBytes(32).toString('hex');

/** Event names typed into the form, as a clean comma-separated list. */
const cleanEventNames = (value) => String(value || '')
  .split(',').map((s) => s.trim()).filter((s) => /^[A-Za-z0-9_ ]{1,64}$/.test(s)).join(',');

/** Saving a Meta test code (re)starts its hour; clearing it ends test mode. */
function withTestWindow(kind, settings) {
  const out = { ...settings };
  if (kind === 'meta' && out.test_event_code) {
    out.test_until = new Date(Date.now() + TEST_MODE_MINUTES * 60_000).toISOString();
  } else {
    delete out.test_until;
  }
  return out;
}

// Failed sign-ins per address and per e-mail. Scrypt already makes each guess
// slow; this stops a patient guesser from trying all night.
const LOGIN_WINDOW_MS = 15 * 60_000;
const loginByIp = createLimiter({ windowMs: LOGIN_WINDOW_MS, max: 20 });
const loginByEmail = createLimiter({ windowMs: LOGIN_WINDOW_MS, max: 5 });

// An unknown e-mail still pays for one scrypt, so the response time does not
// reveal which addresses have an account.
let decoyHash = null;
const decoy = async () => (decoyHash ||= await hashPassword(randomBytes(16).toString('hex')));

const SESSION_COOKIE = 'nwr_admin';

function cookieOptions() {
  return {
    path: '/',
    httpOnly: true,
    secure: config.isProd,
    // Strict also serves as CSRF protection: no cross-site POST carries this cookie.
    sameSite: 'strict',
    maxAge: 14 * 86400,
  };
}

const redirect = (reply, to, msg, type = 'ok') =>
  reply.redirect(`${to}${to.includes('?') ? '&' : '?'}m=${encodeURIComponent(msg)}&t=${type}`, 303);

const flashFrom = (q) => (q.m ? { text: q.m, type: q.t === 'err' ? 'err' : 'ok' } : null);

/** A numeric id from the URL, or null so the route can answer 404. */
const idOf = (v) => (/^\d{1,9}$/.test(String(v)) ? Number(v) : null);

const tabUrl = (tenantId, tab) => (tab === 'prehlad' ? `/admin/tenants/${tenantId}` : `/admin/tenants/${tenantId}/${tab}`);

/** Filters for the event browser, from the query string, each checked. */
function eventFilters(q) {
  return {
    q: typeof q.q === 'string' ? q.q.slice(0, 100) : '',
    name: /^[A-Za-z0-9_ ]{1,64}$/.test(q.name || '') ? q.name : '',
    status: ['pending', 'sending', 'sent', 'dead'].includes(q.status) ? q.status : '',
    source: ['browser', 'server'].includes(q.source) ? q.source : '',
    period: ['24h', '7d', '30d'].includes(q.period) ? q.period : '24h',
    tenant: idOf(q.tenant) ? String(idOf(q.tenant)) : '',
  };
}

export default async function adminRoutes(app) {
  // Every admin route is scoped to the dashboard host. A tenant's collector
  // subdomain resolves to the same process but must never expose this UI.
  app.addHook('onRequest', async (req, reply) => {
    const host = String(req.headers.host || '').toLowerCase().split(':')[0];
    if (host !== config.adminHost.toLowerCase()) {
      return reply.code(404).type('text/plain').send('not found');
    }
    if (req.url.startsWith('/admin/login')) return;
    const user = await getSessionUser(req.cookies?.[SESSION_COOKIE]);
    if (!user) return reply.redirect('/admin/login', 303);
    req.adminUser = user;
  });

  // The bare domain is where someone lands when they type the host by hand.
  // The host hook above has already refused every other host, so this only ever
  // answers on ADMIN_HOST.
  app.get('/', async (req, reply) => reply.redirect('/admin', 303));

  app.get('/admin/login', async (req, reply) =>
    reply.type('text/html').send(page({
      title: 'Prihlásenie',
      body: loginPage(),
      flash: flashFrom(req.query),
    })));

  app.post('/admin/login', async (req, reply) => {
    const { email = '', password = '' } = req.body || {};
    const address = String(email).trim().toLowerCase();
    const ip = clientIp(req);
    if (loginByIp.blocked(ip) || loginByEmail.blocked(address)) {
      return redirect(reply, '/admin/login', 'Príliš veľa neúspešných pokusov. Skúste to znova o 15 minút.', 'err');
    }
    const user = await one('SELECT id, email, password_hash FROM admin_users WHERE email = $1', [address]);
    const valid = await verifyPassword(password, user ? user.password_hash : await decoy());
    if (!user || !valid) {
      loginByIp.hit(ip);
      loginByEmail.hit(address);
      return redirect(reply, '/admin/login', 'Nesprávny e-mail alebo heslo.', 'err');
    }
    loginByEmail.reset(address);
    const { token } = await createSession(user.id);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return reply.redirect('/admin', 303);
  });

  app.post('/admin/logout', async (req, reply) => {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/admin/login', 303);
  });

  app.get('/admin/account', async (req, reply) =>
    reply.type('text/html').send(page({
      title: 'Môj účet', user: req.adminUser, flash: flashFrom(req.query),
      body: accountPage(req.adminUser, MIN_PASSWORD_LENGTH),
    })));

  app.post('/admin/account', async (req, reply) => {
    const b = req.body || {};
    const token = req.cookies?.[SESSION_COOKIE];

    // Re-read the hash rather than trusting the session: the point of asking for
    // the current password is to prove the person at the keyboard knows it.
    const row = await one('SELECT password_hash FROM admin_users WHERE id = $1', [req.adminUser.id]);
    if (!row || !(await verifyPassword(b.current_password || '', row.password_hash))) {
      return redirect(reply, '/admin/account', 'Súčasné heslo nesedí.', 'err');
    }

    const problem = validateNewPassword(b.new_password || '', b.confirm_password || '');
    if (problem) return redirect(reply, '/admin/account', problem, 'err');

    const dropped = await changePassword(req.adminUser.id, b.new_password, token);
    const note = dropped
      ? ` Odhlásených ostatných prihlásení: ${dropped}.`
      : '';
    return redirect(reply, '/admin/account', `Heslo zmenené.${note}`);
  });

  app.get('/admin', async (req, reply) => {
    const data = await overview();
    return reply.type('text/html').send(page({
      title: 'Prehľad', user: req.adminUser, flash: flashFrom(req.query), nav: 'prehlad',
      body: overviewPage(data),
    }));
  });

  app.get('/admin/tenants/new', async (req, reply) =>
    reply.type('text/html').send(page({
      title: 'Nový klient', user: req.adminUser, flash: flashFrom(req.query),
      body: newTenantPage(),
    })));

  app.post('/admin/tenants', async (req, reply) => {
    const b = req.body || {};
    const slug = String(b.slug || '').trim().toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      return redirect(reply, '/admin/tenants/new', 'Slug smie obsahovať len malé písmená, čísla a pomlčky.', 'err');
    }
    try {
      const consent = normalizeConsent(b.consent_mode, b.consent_prefix);
      // A new site starts on its own key: no shared key, no unsigned timestamps.
      const key = newIngestKey();
      const row = await one(
        `INSERT INTO tenants (slug, name, collector_host, allowed_origins, cookie_domain, active,
                              consent_mode, consent_prefix, keep_path,
                              ingest_secret, legacy_ingest, server_only_events)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, FALSE, $10)
         RETURNING id, name, collector_host`,
        [slug, String(b.name || slug).trim(), String(b.collector_host || '').trim().toLowerCase(),
         String(b.allowed_origins || '').trim(), String(b.cookie_domain || '').trim() || null,
         consent.mode, consent.prefix, normalizeKeepPath(b.keep_path), key, cleanEventNames(b.server_only_events)],
      );
      invalidateTenantCache();
      return reply.type('text/html').send(page({
        title: `${row.name} · kľúč`, user: req.adminUser,
        flash: { text: 'Klient vytvorený. Skopírujte si kľúč pre plugin, potom pokračujte na inštaláciu.', type: 'ok' },
        body: ingestKeyPage(row, key, { created: true }),
      }));
    } catch (err) {
      const msg = err.code === '23505' ? 'Slug alebo collector host už existuje.' : err.message;
      return redirect(reply, '/admin/tenants/new', msg, 'err');
    }
  });

  /** One tenant, one tab: /admin/tenants/:id and /admin/tenants/:id/<tab>. */
  async function tenantTab(req, reply, tab) {
    const id = idOf(req.params.id);
    const tenant = id && await one('SELECT * FROM tenants WHERE id = $1', [id]);
    if (!tenant) return reply.code(404).type('text/plain').send('not found');
    const destinations = await destinationStats(id);
    const health = healthOf(tenant, destinations);
    let body;
    if (tab === 'prehlad') {
      body = overviewTab(tenant, await tenantOverview(id));
    } else if (tab === 'kvalita') {
      const rows = await quality(id);
      body = qualityTab(rows, qualityFindings(rows));
    } else if (tab === 'destinacie') {
      body = destinationsTab(tenant, destinations, SCHEMAS, config.metaApiVersion);
    } else if (tab === 'instalacia') {
      body = installTab(tenant, await runChecks(tenant, destinations));
    } else if (tab === 'eventy') {
      const filters = eventFilters(req.query);
      const rows = await eventList(id, filters);
      const e = idOf(req.query.e);
      const detail = e ? await eventDetail(e, id) : null;
      body = eventBrowser({ base: tabUrl(id, 'eventy'), rows, names: await eventNames(id), filters, detail });
    } else {
      body = settingsTab(tenant);
    }
    return reply.type('text/html').send(page({
      title: tenant.name, user: req.adminUser, flash: flashFrom(req.query),
      body: tenantHeader(tenant, destinations, health, tab) + body,
    }));
  }

  app.get('/admin/tenants/:id', (req, reply) => tenantTab(req, reply, 'prehlad'));
  app.get('/admin/tenants/:id/:tab', (req, reply) => {
    const tab = TABS.find(([key]) => key === req.params.tab)?.[0];
    if (!tab) return reply.code(404).type('text/plain').send('not found');
    return tenantTab(req, reply, tab);
  });

  app.post('/admin/tenants/:id/checks', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(404).send('not found');
    forgetChecks(id);
    return reply.redirect(tabUrl(id, 'instalacia'), 303);
  });

  app.post('/admin/tenants/:id', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(404).send('not found');
    const b = req.body || {};
    const consent = normalizeConsent(b.consent_mode, b.consent_prefix);
    await query(
      `UPDATE tenants SET name = $2, collector_host = $3, allowed_origins = $4,
              cookie_domain = $5, active = $6, consent_mode = $7, consent_prefix = $8,
              keep_path = $9, legacy_ingest = $10, server_only_events = $11
        WHERE id = $1`,
      [id, String(b.name || '').trim(), String(b.collector_host || '').trim().toLowerCase(),
       String(b.allowed_origins || '').trim(), String(b.cookie_domain || '').trim() || null,
       b.active === 'on', consent.mode, consent.prefix, normalizeKeepPath(b.keep_path),
       b.legacy_ingest === 'on', cleanEventNames(b.server_only_events)],
    );
    invalidateTenantCache();
    forgetChecks(id);
    return redirect(reply, tabUrl(id, 'nastavenia'), 'Uložené.');
  });

  /**
   * A new signing key for the tenant's plugin. The previous one keeps working
   * until it is revoked, so the site loses nothing while the plugin is updated.
   * The key is shown once, on this response, and never put in a URL.
   */
  app.post('/admin/tenants/:id/key', async (req, reply) => {
    const id = idOf(req.params.id);
    const key = newIngestKey();
    const row = id && await one(
      `UPDATE tenants SET ingest_secret_prev = ingest_secret, ingest_secret = $2
        WHERE id = $1 RETURNING id, name, collector_host`,
      [id, key],
    );
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    forgetChecks(id);
    return reply.type('text/html').send(page({
      title: `${row.name} · kľúč`, user: req.adminUser, body: ingestKeyPage(row, key),
    }));
  });

  app.post('/admin/tenants/:id/key/revoke-previous', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(404).send('not found');
    await query('UPDATE tenants SET ingest_secret_prev = NULL WHERE id = $1', [id]);
    invalidateTenantCache();
    return redirect(reply, tabUrl(id, 'nastavenia'), 'Predchádzajúci kľúč zrušený.');
  });

  app.post('/admin/tenants/:id/destinations', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(404).send('not found');
    const b = req.body || {};
    const kind = String(b.kind || '');
    const schema = SCHEMAS[kind];
    if (!schema) return redirect(reply, tabUrl(id, 'destinacie'), 'Neznámy typ destinácie.', 'err');

    const settings = {};
    for (const field of schema) {
      const value = String(b[field.key] || '').trim();
      if (field.required && !value) {
        return redirect(reply, tabUrl(id, 'destinacie'), `Chýba pole: ${field.label}`, 'err');
      }
      if (value) settings[field.key] = value;
    }
    await query(
      'INSERT INTO destinations (tenant_id, kind, settings) VALUES ($1, $2, $3)',
      [id, kind, JSON.stringify(withTestWindow(kind, settings))],
    );
    invalidateTenantCache();
    forgetChecks(id);
    return redirect(reply, tabUrl(id, 'destinacie'), 'Destinácia pridaná.');
  });

  app.get('/admin/destinations/:id/edit', async (req, reply) => {
    const id = idOf(req.params.id);
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');
    const tenant = await one('SELECT id, name FROM tenants WHERE id = $1', [dest.tenant_id]);
    return reply.type('text/html').send(page({
      title: `${tenant.name} · ${dest.kind}`, user: req.adminUser, flash: flashFrom(req.query),
      body: destinationForm(tenant, dest, SCHEMAS[dest.kind] || []),
    }));
  });

  app.post('/admin/destinations/:id', async (req, reply) => {
    const id = idOf(req.params.id);
    const b = req.body || {};
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');

    const settings = { ...(dest.settings || {}) };
    for (const field of SCHEMAS[dest.kind] || []) {
      const value = String(b[field.key] ?? '').trim();
      if (field.secret && !value) continue;      // blank means keep the stored secret
      if (value) settings[field.key] = value;
      else delete settings[field.key];           // clearing an optional field is deliberate
    }
    for (const field of SCHEMAS[dest.kind] || []) {
      if (field.required && !settings[field.key]) {
        return redirect(reply, `/admin/destinations/${dest.id}/edit`, `Chýba pole: ${field.label}`, 'err');
      }
    }
    // A changed token has not been checked yet.
    if (b.access_token) { delete settings.verified_at; delete settings.verify_error; delete settings.verified_name; }

    await query('UPDATE destinations SET settings = $2 WHERE id = $1', [dest.id, JSON.stringify(withTestWindow(dest.kind, settings))]);
    invalidateTenantCache();
    forgetChecks(dest.tenant_id);
    return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Destinácia upravená.');
  });

  /** Ask Meta whether the stored token works, and remember the answer. */
  app.post('/admin/destinations/:id/verify', async (req, reply) => {
    const id = idOf(req.params.id);
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');
    if (dest.kind !== 'meta') return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Overiť sa dá len token Mety.', 'err');
    const result = await verifyMeta(dest.settings);
    const patch = result.ok
      ? { verified_at: new Date().toISOString(), verified_name: result.name || null, verify_error: null }
      : { verify_error: result.error, verified_at: null };
    await query(`UPDATE destinations SET settings = jsonb_strip_nulls(settings || $2::jsonb) WHERE id = $1`, [id, JSON.stringify(patch)]);
    forgetChecks(dest.tenant_id);
    return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'),
      result.ok ? `Token funguje${result.name ? ` (${result.name})` : ''}.` : `Token nefunguje: ${result.error}.`, result.ok ? 'ok' : 'err');
  });

  app.post('/admin/destinations/:id/test-on', async (req, reply) => {
    const id = idOf(req.params.id);
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');
    const code = String(req.body?.test_event_code || '').trim();
    if (dest.kind !== 'meta' || !/^[A-Za-z0-9_-]{1,64}$/.test(code)) {
      return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Zadajte test event code z Events Managera.', 'err');
    }
    const settings = withTestWindow('meta', { ...(dest.settings || {}), test_event_code: code });
    await query('UPDATE destinations SET settings = $2 WHERE id = $1', [id, JSON.stringify(settings)]);
    invalidateTenantCache();
    return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Testovací režim zapnutý na 60 minút.');
  });

  app.post('/admin/destinations/:id/test-off', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one(
      `UPDATE destinations SET settings = settings - 'test_event_code' - 'test_until'
        WHERE id = $1 RETURNING tenant_id`, [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    return redirect(reply, tabUrl(row.tenant_id, 'destinacie'), 'Testovací režim ukončený. Eventy sa znova počítajú do kampaní.');
  });

  app.post('/admin/destinations/:id/toggle', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('UPDATE destinations SET active = NOT active WHERE id = $1 RETURNING tenant_id, active', [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    return redirect(reply, tabUrl(row.tenant_id, 'destinacie'), row.active ? 'Destinácia zapnutá.' : 'Destinácia vypnutá.');
  });

  app.post('/admin/destinations/:id/delete', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('DELETE FROM destinations WHERE id = $1 RETURNING tenant_id', [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    forgetChecks(row.tenant_id);
    return redirect(reply, tabUrl(row.tenant_id, 'destinacie'), 'Destinácia zmazaná.');
  });

  /**
   * Push a synthetic event through the real queue so the whole path gets
   * exercised — but never into a client's live data: Meta only while its test
   * code is active, GA4 through the validation endpoint.
   */
  app.post('/admin/tenants/:id/test', async (req, reply) => {
    const id = idOf(req.params.id);
    const tenant = id && await one('SELECT * FROM tenants WHERE id = $1', [id]);
    if (!tenant) return reply.code(404).send('not found');
    const destinations = await many('SELECT id, kind, settings FROM destinations WHERE tenant_id = $1 AND active', [tenant.id]);
    if (!destinations.length) {
      return redirect(reply, tabUrl(id, 'destinacie'), 'Najprv pridajte aspoň jednu aktívnu destináciu.', 'err');
    }
    if (destinations.some((d) => d.kind === 'meta' && !testModeActive(d.settings))) {
      return redirect(reply, tabUrl(id, 'destinacie'),
        'Najprv zapnite testovací režim: v destinácii Meta vyplňte Test event code z Events Managera.', 'err');
    }
    const event = {
      test: true,
      event_name: 'Lead',
      event_id: newEventId(),
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: `https://${tenant.collector_host}/`,
      action_source: 'website',
      source: 'server',
      user: { em: 'test@example.com' },
      properties: { value: 1, currency: 'EUR' },
      context: { ip: '127.0.0.1', userAgent: 'nowera-gateway-test/1.0' },
    };
    await enqueue(tenant.id, event, destinations);
    return redirect(reply, tabUrl(id, 'eventy'), `Testovací event zaradený (${destinations.length} destinácií). Výsledok sa ukáže o pár sekúnd.`);
  });

  app.get('/admin/events', async (req, reply) => {
    const filters = eventFilters(req.query);
    const tenantId = filters.tenant ? Number(filters.tenant) : null;
    const rows = await eventList(tenantId, filters);
    const e = idOf(req.query.e);
    const detail = e ? await eventDetail(e, null) : null;
    const tenants = await many('SELECT id, name FROM tenants ORDER BY name');
    return reply.type('text/html').send(page({
      title: 'Eventy', user: req.adminUser, flash: flashFrom(req.query), nav: 'eventy',
      body: `<div class="head"><div><h1>Eventy</h1><p class="meta"><span>všetci klienti</span><span>doručenia do Mety a GA4</span></p></div></div>`
        + eventBrowser({ base: '/admin/events', rows, names: await eventNames(tenantId), filters, detail, showTenant: true, tenants }),
    }));
  });

  app.post('/admin/events/:id/retry', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('SELECT tenant_id FROM events WHERE id = $1', [id]);
    if (!row) return reply.code(404).send('not found');
    const n = await retryEvent(id);
    return redirect(reply, `${tabUrl(row.tenant_id, 'eventy')}?e=${id}`,
      n ? 'Event je znova vo fronte, odošle sa o pár sekúnd.' : 'Tento event sa nedá poslať znova (nie je v stave chyba).', n ? 'ok' : 'err');
  });
}
