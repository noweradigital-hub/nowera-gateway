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
  accountPage, destinationForm, ingestKeyPage, tenantForm, tenantList, tenantDetail, eventLog, loginPage,
} from '../views/pages.js';

/** A tenant's signing key: 256 random bits, shown once and pasted into the plugin. */
const newIngestKey = () => randomBytes(32).toString('hex');

/** Event names typed into the form, as a clean comma-separated list. */
const eventList = (value) => String(value || '')
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
    const tenants = await many(`
      SELECT t.*,
             (SELECT count(*) FROM destinations d WHERE d.tenant_id = t.id AND d.active) AS destination_count,
             (SELECT count(*) FROM events e WHERE e.tenant_id = t.id AND e.status = 'sent'
                AND e.created_at > now() - interval '24 hours') AS sent_24h,
             (SELECT count(*) FROM events e WHERE e.tenant_id = t.id AND e.status = 'dead'
                AND e.created_at > now() - interval '24 hours') AS dead_24h,
             EXISTS (SELECT 1 FROM destinations d WHERE d.tenant_id = t.id AND d.active
                AND d.settings->>'test_event_code' <> ''
                AND (d.settings->>'test_until')::timestamptz > now()) AS testing
        FROM tenants t ORDER BY t.name`);
    return reply.type('text/html').send(page({
      title: 'Klienti', user: req.adminUser, flash: flashFrom(req.query),
      body: tenantList(tenants),
    }));
  });

  app.get('/admin/tenants/new', async (req, reply) =>
    reply.type('text/html').send(page({
      title: 'Nový klient', user: req.adminUser, flash: flashFrom(req.query),
      body: tenantForm(null),
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
         consent.mode, consent.prefix, normalizeKeepPath(b.keep_path), key, eventList(b.server_only_events)],
      );
      invalidateTenantCache();
      return reply.type('text/html').send(page({
        title: `${row.name} · kľúč`, user: req.adminUser,
        flash: { text: 'Klient vytvorený. Skopírujte si kľúč pre plugin, potom pridajte destináciu.', type: 'ok' },
        body: ingestKeyPage(row, key, { created: true }),
      }));
    } catch (err) {
      const msg = err.code === '23505' ? 'Slug alebo collector host už existuje.' : err.message;
      return redirect(reply, '/admin/tenants/new', msg, 'err');
    }
  });

  app.get('/admin/tenants/:id', async (req, reply) => {
    const tenant = await one('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    if (!tenant) return reply.code(404).send('not found');
    const destinations = await many('SELECT * FROM destinations WHERE tenant_id = $1 ORDER BY id', [tenant.id]);
    const events = await many(
      `SELECT id, event_name, status, attempts, last_error, created_at, sent_at, destination_id
         FROM events WHERE tenant_id = $1 ORDER BY id DESC LIMIT 25`, [tenant.id]);
    return reply.type('text/html').send(page({
      title: tenant.name, user: req.adminUser, flash: flashFrom(req.query),
      body: tenantDetail(tenant, destinations, events, SCHEMAS),
    }));
  });

  app.post('/admin/tenants/:id', async (req, reply) => {
    const b = req.body || {};
    const consent = normalizeConsent(b.consent_mode, b.consent_prefix);
    await query(
      `UPDATE tenants SET name = $2, collector_host = $3, allowed_origins = $4,
              cookie_domain = $5, active = $6, consent_mode = $7, consent_prefix = $8,
              keep_path = $9, legacy_ingest = $10, server_only_events = $11
        WHERE id = $1`,
      [req.params.id, String(b.name || '').trim(), String(b.collector_host || '').trim().toLowerCase(),
       String(b.allowed_origins || '').trim(), String(b.cookie_domain || '').trim() || null,
       b.active === 'on', consent.mode, consent.prefix, normalizeKeepPath(b.keep_path),
       b.legacy_ingest === 'on', eventList(b.server_only_events)],
    );
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${req.params.id}`, 'Uložené.');
  });

  /**
   * A new signing key for the tenant's plugin. The previous one keeps working
   * until it is revoked, so the site loses nothing while the plugin is updated.
   * The key is shown once, on this response, and never put in a URL.
   */
  app.post('/admin/tenants/:id/key', async (req, reply) => {
    const key = newIngestKey();
    const row = await one(
      `UPDATE tenants SET ingest_secret_prev = ingest_secret, ingest_secret = $2
        WHERE id = $1 RETURNING id, name, collector_host`,
      [req.params.id, key],
    );
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    return reply.type('text/html').send(page({
      title: `${row.name} · kľúč`, user: req.adminUser, body: ingestKeyPage(row, key),
    }));
  });

  app.post('/admin/tenants/:id/key/revoke-previous', async (req, reply) => {
    await query('UPDATE tenants SET ingest_secret_prev = NULL WHERE id = $1', [req.params.id]);
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${req.params.id}`, 'Predchádzajúci kľúč zrušený.');
  });

  app.post('/admin/tenants/:id/destinations', async (req, reply) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    const schema = SCHEMAS[kind];
    if (!schema) return redirect(reply, `/admin/tenants/${req.params.id}`, 'Neznámy typ destinácie.', 'err');

    const settings = {};
    for (const field of schema) {
      const value = String(b[field.key] || '').trim();
      if (field.required && !value) {
        return redirect(reply, `/admin/tenants/${req.params.id}`, `Chýba pole: ${field.label}`, 'err');
      }
      if (value) settings[field.key] = value;
    }
    await query(
      'INSERT INTO destinations (tenant_id, kind, settings) VALUES ($1, $2, $3)',
      [req.params.id, kind, JSON.stringify(withTestWindow(kind, settings))],
    );
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${req.params.id}`, 'Destinácia pridaná.');
  });

  app.get('/admin/destinations/:id/edit', async (req, reply) => {
    const dest = await one('SELECT * FROM destinations WHERE id = $1', [req.params.id]);
    if (!dest) return reply.code(404).send('not found');
    const tenant = await one('SELECT id, name FROM tenants WHERE id = $1', [dest.tenant_id]);
    return reply.type('text/html').send(page({
      title: `${tenant.name} · ${dest.kind}`, user: req.adminUser, flash: flashFrom(req.query),
      body: destinationForm(tenant, dest, SCHEMAS[dest.kind] || []),
    }));
  });

  app.post('/admin/destinations/:id', async (req, reply) => {
    const b = req.body || {};
    const dest = await one('SELECT * FROM destinations WHERE id = $1', [req.params.id]);
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

    await query('UPDATE destinations SET settings = $2 WHERE id = $1', [dest.id, JSON.stringify(withTestWindow(dest.kind, settings))]);
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${dest.tenant_id}`, 'Destinácia upravená.');
  });

  app.post('/admin/destinations/:id/test-off', async (req, reply) => {
    const row = await one(
      `UPDATE destinations SET settings = settings - 'test_event_code' - 'test_until'
        WHERE id = $1 RETURNING tenant_id`, [req.params.id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${row.tenant_id}`, 'Testovací režim ukončený. Eventy sa znova počítajú do kampaní.');
  });

  app.post('/admin/destinations/:id/toggle', async (req, reply) => {
    const row = await one('UPDATE destinations SET active = NOT active WHERE id = $1 RETURNING tenant_id, active', [req.params.id]);
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${row.tenant_id}`, row.active ? 'Destinácia zapnutá.' : 'Destinácia vypnutá.');
  });

  app.post('/admin/destinations/:id/delete', async (req, reply) => {
    const row = await one('DELETE FROM destinations WHERE id = $1 RETURNING tenant_id', [req.params.id]);
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${row.tenant_id}`, 'Destinácia zmazaná.');
  });

  /**
   * Push a synthetic event through the real queue so the whole path gets
   * exercised — but never into a client's live data: Meta only while its test
   * code is active, GA4 through the validation endpoint.
   */
  app.post('/admin/tenants/:id/test', async (req, reply) => {
    const tenant = await one('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    if (!tenant) return reply.code(404).send('not found');
    const destinations = await many('SELECT id, kind, settings FROM destinations WHERE tenant_id = $1 AND active', [tenant.id]);
    if (!destinations.length) {
      return redirect(reply, `/admin/tenants/${tenant.id}`, 'Najprv pridajte aspoň jednu aktívnu destináciu.', 'err');
    }
    if (destinations.some((d) => d.kind === 'meta' && !testModeActive(d.settings))) {
      return redirect(reply, `/admin/tenants/${tenant.id}`,
        'Najprv zapnite testovací režim: v destinácii Meta vyplňte Test event code z Events Managera.', 'err');
    }
    const event = {
      test: true,
      event_name: 'Lead',
      event_id: newEventId(),
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: `https://${tenant.collector_host}/`,
      action_source: 'website',
      user: { em: 'test@example.com' },
      properties: { value: 1, currency: 'EUR' },
      context: { ip: '127.0.0.1', userAgent: 'nowera-gateway-test/1.0' },
    };
    await enqueue(tenant.id, event, destinations);
    return redirect(reply, `/admin/tenants/${tenant.id}`, `Testovací event zaradený (${destinations.length} destinácií). Výsledok o pár sekúnd nižšie.`);
  });

  app.get('/admin/events', async (req, reply) => {
    const status = ['pending', 'sending', 'sent', 'dead'].includes(req.query.status) ? req.query.status : null;
    const tenantId = req.query.tenant ? Number(req.query.tenant) : null;
    const rows = await many(
      `SELECT e.id, e.event_name, e.event_id, e.status, e.attempts, e.last_error, e.created_at,
              t.name AS tenant_name, t.id AS tenant_id, d.kind
         FROM events e
         JOIN tenants t ON t.id = e.tenant_id
         LEFT JOIN destinations d ON d.id = e.destination_id
        WHERE ($1::text IS NULL OR e.status = $1)
          AND ($2::int IS NULL OR e.tenant_id = $2)
        ORDER BY e.id DESC LIMIT 150`,
      [status, tenantId],
    );
    const tenants = await many('SELECT id, name FROM tenants ORDER BY name');
    return reply.type('text/html').send(page({
      title: 'Eventy', user: req.adminUser, flash: flashFrom(req.query),
      body: eventLog(rows, tenants, { status, tenantId }),
    }));
  });
}
