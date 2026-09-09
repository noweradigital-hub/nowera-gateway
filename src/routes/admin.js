import { config } from '../config.js';
import { many, one, query } from '../db.js';
import {
  MIN_PASSWORD_LENGTH, changePassword, createSession, destroySession,
  getSessionUser, validateNewPassword, verifyPassword,
} from '../lib/auth.js';
import { SCHEMAS } from '../destinations/index.js';
import { invalidateTenantCache } from '../lib/tenants.js';
import { enqueue } from '../lib/queue.js';
import { newEventId } from '../lib/ids.js';
import { page } from '../views/layout.js';
import { accountPage, tenantForm, tenantList, tenantDetail, eventLog, loginPage } from '../views/pages.js';

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
    const user = await one('SELECT id, email, password_hash FROM admin_users WHERE email = $1', [String(email).trim().toLowerCase()]);
    if (!user || !(await verifyPassword(password, user.password_hash))) {
      return redirect(reply, '/admin/login', 'Nesprávny e-mail alebo heslo.', 'err');
    }
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
                AND e.created_at > now() - interval '24 hours') AS dead_24h
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
      const row = await one(
        `INSERT INTO tenants (slug, name, collector_host, allowed_origins, cookie_domain, active)
         VALUES ($1, $2, $3, $4, $5, TRUE) RETURNING id`,
        [slug, String(b.name || slug).trim(), String(b.collector_host || '').trim().toLowerCase(),
         String(b.allowed_origins || '').trim(), String(b.cookie_domain || '').trim() || null],
      );
      invalidateTenantCache();
      return redirect(reply, `/admin/tenants/${row.id}`, 'Klient vytvorený. Pridajte destináciu.');
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
    await query(
      `UPDATE tenants SET name = $2, collector_host = $3, allowed_origins = $4,
              cookie_domain = $5, active = $6 WHERE id = $1`,
      [req.params.id, String(b.name || '').trim(), String(b.collector_host || '').trim().toLowerCase(),
       String(b.allowed_origins || '').trim(), String(b.cookie_domain || '').trim() || null,
       b.active === 'on'],
    );
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${req.params.id}`, 'Uložené.');
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
      [req.params.id, kind, JSON.stringify(settings)],
    );
    invalidateTenantCache();
    return redirect(reply, `/admin/tenants/${req.params.id}`, 'Destinácia pridaná.');
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

  /** Push a synthetic event through the real queue so the whole path gets exercised. */
  app.post('/admin/tenants/:id/test', async (req, reply) => {
    const tenant = await one('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
    const destinations = await many('SELECT id, kind, settings FROM destinations WHERE tenant_id = $1 AND active', [tenant.id]);
    if (!destinations.length) {
      return redirect(reply, `/admin/tenants/${tenant.id}`, 'Najprv pridajte aspoň jednu aktívnu destináciu.', 'err');
    }
    const event = {
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
