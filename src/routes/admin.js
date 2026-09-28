import { randomBytes } from 'node:crypto';
import { config } from '../config.js';
import { many, one, query } from '../db.js';
import {
  MIN_PASSWORD_LENGTH, changePassword, createSession, destroySession,
  getSessionUser, hashPassword, validateNewPassword, verifyPassword,
} from '../lib/auth.js';
import {
  SCHEMAS, TEST_MODE_MINUTES, openSettings, sealSettings, testModeActive,
} from '../destinations/index.js';
import { open, seal } from '../lib/secrets.js';
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
  destinationStats, eventDetail, eventList, eventNames, healthOf, overview, plural, quality, qualityFindings,
  retryEvent, tenantOverview,
} from '../lib/stats.js';
import { forgetChecks, runChecks } from '../lib/checks.js';
import { verifyMeta } from '../destinations/verify.js';
import { overviewPage } from '../views/overview.js';
import {
  TABS, destinationsTab, installTab, overviewTab, qualityTab, settingsTab, tenantHeader,
} from '../views/tenant.js';
import { eventBrowser } from '../views/events.js';
import {
  RULES, alertHistory, alertSettings, openAlertCount, saveAlertSettings, testWebhook, validWebhook,
} from '../lib/alerts.js';
import { alertsPage } from '../views/alerts.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../lib/totp.js';
import {
  invitedPage, twoFactorCard, twoFactorLoginPage, twoFactorSetupPage, usersPage,
} from '../views/users.js';
import {
  backupSettings, backupState, cleanSettings, configured, fetchBackup, inspectBackup, listBackups,
  restoreBackup, runBackup, saveBackupSettings, testStorage,
} from '../lib/backup.js';
import { keySource, recoveryKey } from '../lib/secrets.js';
import { deriveFromSite, detectConsent, gatewayIp, pairingCode } from '../lib/onboarding.js';
import { backupsPage, recoveryKeyPage } from '../views/backups.js';

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
// Asking for the recovery key checks the password again; a stolen session must
// not be able to guess it.
const keyReveal = createLimiter({ windowMs: LOGIN_WINDOW_MS, max: 5 });

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

// Signed in with the password, waiting for the authenticator code. In memory:
// a restart simply asks for the password again.
const PENDING_COOKIE = 'nwr_2fa';
const pendingLogins = new Map(); // token -> { userId, exp, tries }
const PENDING_MS = 5 * 60_000;

/** Remember who changed what; never lets a logging failure break the action. */
async function audit(req, action, target = null) {
  try {
    await query('INSERT INTO admin_audit (user_id, email, action, target) VALUES ($1, $2, $3, $4)',
      [req.adminUser?.id ?? null, req.adminUser?.email ?? null, action, target ? String(target).slice(0, 200) : null]);
  } catch { /* the change itself already happened */ }
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
    // The sidebar shows how many problems are open, on every page.
    if (req.method === 'GET') {
      req.openAlerts = await openAlertCount().catch(() => 0);
      req.backupWarn = await backupSettings().then((s) => !configured(s)).catch(() => false);
    }
  });

  // The bare domain is where someone lands when they type the host by hand.
  // The host hook above has already refused every other host, so this only ever
  // answers on ADMIN_HOST.
  app.get('/', async (req, reply) => reply.redirect('/admin', 303));

  app.get('/admin/login', async (req, reply) =>
    reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Prihlásenie',
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
    const full = await one('SELECT totp_enabled FROM admin_users WHERE id = $1', [user.id]);
    if (full?.totp_enabled) {
      const pending = randomBytes(24).toString('hex');
      pendingLogins.set(pending, { userId: user.id, exp: Date.now() + PENDING_MS, tries: 0 });
      reply.setCookie(PENDING_COOKIE, pending, { ...cookieOptions(), maxAge: PENDING_MS / 1000 });
      return reply.redirect('/admin/login/2fa', 303);
    }
    return startSession(reply, user.id);
  });

  async function startSession(reply, userId) {
    const { token } = await createSession(userId);
    await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [userId]);
    reply.setCookie(SESSION_COOKIE, token, cookieOptions());
    return reply.redirect('/admin', 303);
  }

  const pendingFrom = (req) => {
    const token = req.cookies?.[PENDING_COOKIE];
    const p = token && pendingLogins.get(token);
    if (!p || p.exp < Date.now()) {
      if (token) pendingLogins.delete(token);
      return null;
    }
    return { token, ...p };
  };

  app.get('/admin/login/2fa', async (req, reply) => {
    if (!pendingFrom(req)) return redirect(reply, '/admin/login', 'Prihlásenie vypršalo, zadajte heslo znova.', 'err');
    return reply.type('text/html').send(page({ title: 'Overenie', body: twoFactorLoginPage(), flash: flashFrom(req.query) }));
  });

  app.post('/admin/login/2fa', async (req, reply) => {
    const p = pendingFrom(req);
    if (!p) return redirect(reply, '/admin/login', 'Prihlásenie vypršalo, zadajte heslo znova.', 'err');
    const user = await one('SELECT id, totp_secret, totp_last_step FROM admin_users WHERE id = $1 AND totp_enabled', [p.userId]);
    const step = user && verifyTotp(open(user.totp_secret), req.body?.code, { lastStep: Number(user.totp_last_step) });
    if (!step) {
      const tries = p.tries + 1;
      if (tries >= 5) {
        pendingLogins.delete(p.token);
        return redirect(reply, '/admin/login', 'Príliš veľa nesprávnych kódov. Prihláste sa znova.', 'err');
      }
      pendingLogins.set(p.token, { userId: p.userId, exp: p.exp, tries });
      return redirect(reply, '/admin/login/2fa', 'Kód nesedí. Skúste aktuálny kód z aplikácie.', 'err');
    }
    pendingLogins.delete(p.token);
    reply.clearCookie(PENDING_COOKIE, { path: '/' });
    await query('UPDATE admin_users SET totp_last_step = $2 WHERE id = $1', [user.id, step]);
    return startSession(reply, user.id);
  });

  app.post('/admin/logout', async (req, reply) => {
    await destroySession(req.cookies?.[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/admin/login', 303);
  });

  app.get('/admin/account', async (req, reply) => {
    const me = await one('SELECT id, email, totp_enabled FROM admin_users WHERE id = $1', [req.adminUser.id]);
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Môj účet', user: req.adminUser, flash: flashFrom(req.query), nav: 'account',
      body: accountPage(req.adminUser, MIN_PASSWORD_LENGTH) + `<div style="margin-top:14px">${twoFactorCard(me)}</div>`,
    }));
  });

  app.post('/admin/account/2fa/start', async (req, reply) => {
    const secret = newTotpSecret();
    await query('UPDATE admin_users SET totp_pending = $2 WHERE id = $1', [req.adminUser.id, seal(secret)]);
    return reply.type('text/html').send(page({
      title: 'Dvojfaktorové overenie', user: req.adminUser, nav: 'account',
      body: twoFactorSetupPage(secret, otpauthUrl(secret, req.adminUser.email)),
    }));
  });

  app.post('/admin/account/2fa/confirm', async (req, reply) => {
    const me = await one('SELECT totp_pending FROM admin_users WHERE id = $1', [req.adminUser.id]);
    const step = me?.totp_pending && verifyTotp(open(me.totp_pending), req.body?.code);
    if (!step) return redirect(reply, '/admin/account', 'Kód nesedel, 2FA nie je zapnuté. Skúste to znova.', 'err');
    await query(
      `UPDATE admin_users SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled = TRUE, totp_last_step = $2
        WHERE id = $1`, [req.adminUser.id, step]);
    await audit(req, 'account.2fa_on');
    return redirect(reply, '/admin/account', 'Dvojfaktorové overenie je zapnuté.');
  });

  app.post('/admin/account/2fa/disable', async (req, reply) => {
    const me = await one('SELECT password_hash, totp_secret, totp_last_step FROM admin_users WHERE id = $1', [req.adminUser.id]);
    const passwordOk = me && await verifyPassword(req.body?.password || '', me.password_hash);
    const step = passwordOk && verifyTotp(open(me.totp_secret), req.body?.code, { lastStep: Number(me.totp_last_step) });
    if (!step) return redirect(reply, '/admin/account', 'Heslo alebo kód nesedí.', 'err');
    await query(`UPDATE admin_users SET totp_secret = NULL, totp_enabled = FALSE, totp_pending = NULL WHERE id = $1`, [req.adminUser.id]);
    await audit(req, 'account.2fa_off');
    return redirect(reply, '/admin/account', 'Dvojfaktorové overenie je vypnuté.');
  });

  app.get('/admin/pouzivatelia', async (req, reply) => {
    const users = await many('SELECT id, email, totp_enabled, last_login_at, created_at FROM admin_users ORDER BY email');
    const log = await many('SELECT at, email, action, target FROM admin_audit ORDER BY id DESC LIMIT 100');
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Používatelia', user: req.adminUser, flash: flashFrom(req.query), nav: 'pouzivatelia',
      body: usersPage({ users, audit: log, me: req.adminUser }),
    }));
  });

  app.post('/admin/pouzivatelia', async (req, reply) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return redirect(reply, '/admin/pouzivatelia', 'Zadajte platný e-mail.', 'err');
    const password = randomBytes(12).toString('base64url');
    try {
      await query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [email, await hashPassword(password)]);
    } catch (err) {
      return redirect(reply, '/admin/pouzivatelia', err.code === '23505' ? 'Tento e-mail už prístup má.' : err.message, 'err');
    }
    await audit(req, 'user.invite', email);
    return reply.type('text/html').send(page({
      title: 'Používatelia', user: req.adminUser, nav: 'pouzivatelia', body: invitedPage(email, password),
    }));
  });

  app.post('/admin/pouzivatelia/:id/delete', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id || id === req.adminUser.id) return redirect(reply, '/admin/pouzivatelia', 'Seba odobrať nemôžete.', 'err');
    const row = await one('DELETE FROM admin_users WHERE id = $1 RETURNING email', [id]);
    if (row) await audit(req, 'user.remove', row.email);
    return redirect(reply, '/admin/pouzivatelia', row ? 'Prístup odobraný.' : 'Používateľ neexistuje.', row ? 'ok' : 'err');
  });

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
    await audit(req, 'account.password');
    const note = dropped
      ? ` Odhlásených ostatných prihlásení: ${dropped}.`
      : '';
    return redirect(reply, '/admin/account', `Heslo zmenené.${note}`);
  });

  app.get('/admin', async (req, reply) => {
    const data = await overview();
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Prehľad', user: req.adminUser, flash: flashFrom(req.query), nav: 'prehlad',
      body: overviewPage(data),
    }));
  });

  app.get('/admin/tenants/new', async (req, reply) =>
    reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Nový klient', user: req.adminUser, flash: flashFrom(req.query),
      body: newTenantPage({ serverIp: await gatewayIp(), adminHost: config.adminHost }),
    })));

  /**
   * Create a client. From the three-step form only the name and the website are
   * needed: host, origins, cookie domain and slug follow from the address unless
   * typed in, and the consent tool is recognised from the site.
   */
  app.post('/admin/tenants', async (req, reply) => {
    const b = req.body || {};
    const derived = b.site ? deriveFromSite(b.site) : null;
    if (b.site && !derived) return redirect(reply, '/admin/tenants/new', 'Adresa webu nie je platná, napr. https://www.klient.sk.', 'err');
    const pick = (field) => String(b[field] || '').trim() || derived?.[field] || '';

    let slug = pick('slug').toLowerCase();
    if (!/^[a-z0-9-]{2,40}$/.test(slug)) {
      return redirect(reply, '/admin/tenants/new', 'Slug smie obsahovať len malé písmená, čísla a pomlčky.', 'err');
    }
    const collectorHost = pick('collector_host').toLowerCase();
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(collectorHost)) return redirect(reply, '/admin/tenants/new', 'Collector host nie je platný.', 'err');
    if (collectorHost === config.adminHost.toLowerCase()) return redirect(reply, '/admin/tenants/new', 'Collector host nesmie byť adresa administrácie.', 'err');
    // A second client on the same brand gets klient-2 rather than an error.
    if (!String(b.slug || '').trim()) {
      const taken = new Set((await many('SELECT slug FROM tenants WHERE slug LIKE $1', [`${slug}%`])).map((r) => r.slug));
      for (let i = 2; taken.has(slug); i += 1) slug = `${derived.slug}-${i}`;
    }

    const notes = [];
    let mode = b.consent_mode;
    if (mode === 'auto') {
      const found = derived ? await detectConsent(derived.site_url) : null;
      mode = found || 'none';
      notes.push(found === null ? 'Web sa nepodarilo načítať, súhlasy sa zatiaľ nekontrolujú — nastavte ich v Nastaveniach.'
        : found === 'none' ? 'Na webe sa nenašiel CookieScript ani Complianz, súhlasy sa nekontrolujú. Skontrolujte to v Nastaveniach.'
          : `Rozpoznaný nástroj na súhlasy: ${found === 'cookiescript' ? 'CookieScript' : 'Complianz'}.`);
    }
    const consent = normalizeConsent(mode, b.consent_prefix);
    // The old single form sends keep_path; the new one a WordPress checkbox.
    const keepPath = 'keep_path' in b ? normalizeKeepPath(b.keep_path)
      : b.wordpress === 'on' ? '/wp-content/plugins/nowera-capi/keep.php' : null;

    try {
      // A new site starts on its own key: no shared key, no unsigned timestamps.
      const key = newIngestKey();
      const row = await one(
        `INSERT INTO tenants (slug, name, collector_host, allowed_origins, cookie_domain, active,
                              consent_mode, consent_prefix, keep_path,
                              ingest_secret, legacy_ingest, server_only_events)
         VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9, FALSE, $10)
         RETURNING id, name, collector_host`,
        [slug, String(b.name || derived?.domain || slug).trim(), collectorHost,
         pick('allowed_origins'), pick('cookie_domain') || null,
         consent.mode, consent.prefix, keepPath, seal(key), cleanEventNames(b.server_only_events)],
      );
      invalidateTenantCache();
      await audit(req, 'tenant.create', row.name);
      return reply.header('cache-control', 'no-store').type('text/html').send(page({
        alerts: req.openAlerts, backupWarn: req.backupWarn, title: `${row.name} · kľúč`, user: req.adminUser,
        flash: { text: 'Klient vytvorený. Skopírujte si párovací kód pre plugin, potom pokračujte na inštaláciu.', type: 'ok' },
        body: ingestKeyPage(row, key, { created: true, pairing: pairingCode(row.collector_host, key), notes }),
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
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: tenant.name, user: req.adminUser, flash: flashFrom(req.query),
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
    await audit(req, 'tenant.update', b.name);
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
      [id, seal(key)],
    );
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    forgetChecks(id);
    await audit(req, 'tenant.key', row.name);
    return reply.header('cache-control', 'no-store').type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: `${row.name} · kľúč`, user: req.adminUser,
      body: ingestKeyPage(row, key, { pairing: pairingCode(row.collector_host, key) }),
    }));
  });

  app.post('/admin/tenants/:id/key/revoke-previous', async (req, reply) => {
    const id = idOf(req.params.id);
    if (!id) return reply.code(404).send('not found');
    await query('UPDATE tenants SET ingest_secret_prev = NULL WHERE id = $1', [id]);
    invalidateTenantCache();
    await audit(req, 'tenant.key_revoke', `klient ${id}`);
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
      [id, kind, JSON.stringify(sealSettings(kind, withTestWindow(kind, settings)))],
    );
    invalidateTenantCache();
    forgetChecks(id);
    await audit(req, 'destination.add', `${kind} · klient ${id}`);
    return redirect(reply, tabUrl(id, 'destinacie'), 'Destinácia pridaná.');
  });

  app.get('/admin/destinations/:id/edit', async (req, reply) => {
    const id = idOf(req.params.id);
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');
    const tenant = await one('SELECT id, name FROM tenants WHERE id = $1', [dest.tenant_id]);
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: `${tenant.name} · ${dest.kind}`, user: req.adminUser, flash: flashFrom(req.query),
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

    await query('UPDATE destinations SET settings = $2 WHERE id = $1', [dest.id, JSON.stringify(sealSettings(dest.kind, withTestWindow(dest.kind, settings)))]);
    invalidateTenantCache();
    forgetChecks(dest.tenant_id);
    await audit(req, 'destination.update', `${dest.kind} · klient ${dest.tenant_id}`);
    return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Destinácia upravená.');
  });

  /** Ask Meta whether the stored token works, and remember the answer. */
  app.post('/admin/destinations/:id/verify', async (req, reply) => {
    const id = idOf(req.params.id);
    const dest = id && await one('SELECT * FROM destinations WHERE id = $1', [id]);
    if (!dest) return reply.code(404).send('not found');
    if (dest.kind !== 'meta') return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Overiť sa dá len token Mety.', 'err');
    const result = await verifyMeta(openSettings('meta', dest.settings));
    const patch = result.ok
      ? { verified_at: new Date().toISOString(), verified_name: result.name || null, verify_error: null }
      : { verify_error: result.error, verified_at: null };
    await query(`UPDATE destinations SET settings = jsonb_strip_nulls(settings || $2::jsonb) WHERE id = $1`, [id, JSON.stringify(patch)]);
    forgetChecks(dest.tenant_id);
    await audit(req, 'destination.verify', `${result.ok ? 'ok' : result.error} · klient ${dest.tenant_id}`);
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
    await audit(req, 'destination.test_on', `klient ${dest.tenant_id}`);
    return redirect(reply, tabUrl(dest.tenant_id, 'destinacie'), 'Testovací režim zapnutý na 60 minút.');
  });

  app.post('/admin/destinations/:id/test-off', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one(
      `UPDATE destinations SET settings = settings - 'test_event_code' - 'test_until'
        WHERE id = $1 RETURNING tenant_id`, [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    await audit(req, 'destination.test_off', `klient ${row.tenant_id}`);
    return redirect(reply, tabUrl(row.tenant_id, 'destinacie'), 'Testovací režim ukončený. Eventy sa znova počítajú do kampaní.');
  });

  app.post('/admin/destinations/:id/toggle', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('UPDATE destinations SET active = NOT active WHERE id = $1 RETURNING tenant_id, active', [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    await audit(req, 'destination.toggle', `${row.active ? 'zapnutá' : 'vypnutá'} · klient ${row.tenant_id}`);
    return redirect(reply, tabUrl(row.tenant_id, 'destinacie'), row.active ? 'Destinácia zapnutá.' : 'Destinácia vypnutá.');
  });

  app.post('/admin/destinations/:id/delete', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('DELETE FROM destinations WHERE id = $1 RETURNING tenant_id', [id]);
    if (!row) return reply.code(404).send('not found');
    invalidateTenantCache();
    forgetChecks(row.tenant_id);
    await audit(req, 'destination.delete', `klient ${row.tenant_id}`);
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
    await audit(req, 'tenant.test_event', tenant.name);
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
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Eventy', user: req.adminUser, flash: flashFrom(req.query), nav: 'eventy',
      body: `<div class="head"><div><h1>Eventy</h1><p class="meta"><span>všetci klienti</span><span>doručenia do Mety a GA4</span></p></div></div>`
        + eventBrowser({ base: '/admin/events', rows, names: await eventNames(tenantId), filters, detail, showTenant: true, tenants }),
    }));
  });

  app.post('/admin/events/:id/retry', async (req, reply) => {
    const id = idOf(req.params.id);
    const row = id && await one('SELECT tenant_id FROM events WHERE id = $1', [id]);
    if (!row) return reply.code(404).send('not found');
    const n = await retryEvent(id);
    if (n) await audit(req, 'event.retry', `event ${id}`);
    return redirect(reply, `${tabUrl(row.tenant_id, 'eventy')}?e=${id}`,
      n ? 'Event je znova vo fronte, odošle sa o pár sekúnd.' : 'Tento event sa nedá poslať znova (nie je v stave chyba).', n ? 'ok' : 'err');
  });

  app.get('/admin/upozornenia', async (req, reply) => {
    const [settings, history] = await Promise.all([alertSettings(), alertHistory()]);
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Upozornenia', user: req.adminUser, flash: flashFrom(req.query), nav: 'upozornenia',
      body: alertsPage({ settings, history }),
    }));
  });

  app.post('/admin/upozornenia', async (req, reply) => {
    const b = req.body || {};
    const current = await alertSettings();
    const typed = String(b.webhook_url || '').trim();
    let webhook = current.webhook_url;
    if (b.clear_webhook === 'on') webhook = '';
    else if (typed) {
      webhook = validWebhook(typed);
      if (!webhook) return redirect(reply, '/admin/upozornenia', 'Webhook musí byť adresa začínajúca https://.', 'err');
    }
    const rules = Object.fromEntries(Object.keys(RULES).map((k) => [k, b[`rule_${k}`] === 'on']));
    await saveAlertSettings({ webhook_url: webhook, rules });
    await audit(req, 'alerts.update');
    return redirect(reply, '/admin/upozornenia', 'Uložené.');
  });

  app.post('/admin/upozornenia/test', async (req, reply) => {
    const { webhook_url: url } = await alertSettings();
    if (!url) return redirect(reply, '/admin/upozornenia', 'Najprv uložte webhook.', 'err');
    try {
      await testWebhook(url);
      return redirect(reply, '/admin/upozornenia', 'Skúšobné upozornenie odoslané. Skontrolujte, či prišlo.');
    } catch (err) {
      return redirect(reply, '/admin/upozornenia', `Webhook neodpovedal: ${err.message}.`, 'err');
    }
  });

  // ------------------------------------------------------------------ zálohy

  app.get('/admin/zalohy', async (req, reply) => {
    const [settings, st, me, tenants] = await Promise.all([
      backupSettings(), backupState(), one('SELECT totp_enabled FROM admin_users WHERE id = $1', [req.adminUser.id]),
      one('SELECT count(*)::int AS n FROM tenants'),
    ]);
    let list = [];
    let listError = null;
    if (configured(settings)) list = await listBackups().catch((err) => { listError = err.message; return []; });
    return reply.type('text/html').send(page({
      alerts: req.openAlerts, backupWarn: req.backupWarn, title: 'Zálohy', user: req.adminUser, flash: flashFrom(req.query), nav: 'zalohy',
      body: backupsPage({
        settings, state: st, list, listError, isConfigured: configured(settings),
        emptyInstall: tenants.n === 0, keySource: keySource(), totpEnabled: Boolean(me?.totp_enabled),
      }),
    }));
  });

  app.post('/admin/zalohy', async (req, reply) => {
    const current = await backupSettings();
    const { value, error } = cleanSettings(req.body || {}, current);
    if (error) return redirect(reply, '/admin/zalohy', error, 'err');
    await saveBackupSettings(value);
    await audit(req, 'backup.settings', `${value.bucket}`);
    try {
      await testStorage(value);
      return redirect(reply, '/admin/zalohy', 'Uložené. Úložisko funguje: skúšobný súbor sa zapísal aj zmazal.');
    } catch (err) {
      return redirect(reply, '/admin/zalohy', `Uložené, ale úložisko odmietlo zápis: ${err.message}`, 'err');
    }
  });

  app.post('/admin/zalohy/teraz', async (req, reply) => {
    try {
      const r = await runBackup({ log: req.log });
      await audit(req, 'backup.run', r.key);
      return redirect(reply, '/admin/zalohy', `Záloha hotová za ${(r.ms / 1000).toFixed(1)} s (${(r.size / 1e6).toFixed(1)} MB).`);
    } catch (err) {
      return redirect(reply, '/admin/zalohy', `Záloha zlyhala: ${err.message}`, 'err');
    }
  });

  app.post('/admin/zalohy/overit', async (req, reply) => {
    try {
      const [latest] = await listBackups(1);
      if (!latest) return redirect(reply, '/admin/zalohy', 'V úložisku zatiaľ nie je žiadna záloha.', 'err');
      const info = await inspectBackup(await fetchBackup(latest.key));
      const c = info.counts;
      return redirect(reply, '/admin/zalohy', `Záloha ${latest.key.split('/').pop()} je úplná a dá sa rozšifrovať: `
        + `${plural(c.tenants, 'klient', 'klienti', 'klientov')}, ${plural(c.destinations, 'destinácia', 'destinácie', 'destinácií')}, `
        + `${plural(c.events, 'event', 'eventy', 'eventov')}.`);
    } catch (err) {
      return redirect(reply, '/admin/zalohy', `Overenie zlyhalo: ${err.message}`, 'err');
    }
  });

  app.get('/admin/zalohy/stiahnut', async (req, reply) => {
    const key = String(req.query.key || '');
    try {
      const file = await fetchBackup(key);
      await audit(req, 'backup.download', key);
      return reply.type('application/octet-stream')
        .header('content-disposition', `attachment; filename="${key.split('/').pop().replace(/[^A-Za-z0-9._-]/g, '')}"`)
        .header('cache-control', 'no-store')
        .send(file);
    } catch (err) {
      return redirect(reply, '/admin/zalohy', `Zálohu sa nepodarilo stiahnuť: ${err.message}`, 'err');
    }
  });

  app.post('/admin/zalohy/kluc', async (req, reply) => {
    const who = String(req.adminUser.id);
    if (keyReveal.blocked(who)) return redirect(reply, '/admin/zalohy', 'Príliš veľa pokusov. Skúste to znova o 15 minút.', 'err');
    const me = await one('SELECT password_hash, totp_enabled, totp_secret, totp_last_step FROM admin_users WHERE id = $1', [req.adminUser.id]);
    const passwordOk = me && await verifyPassword(req.body?.password || '', me.password_hash);
    const step = passwordOk && me.totp_enabled
      ? verifyTotp(open(me.totp_secret), req.body?.code, { lastStep: Number(me.totp_last_step) })
      : passwordOk;
    if (!step) {
      keyReveal.hit(who);
      return redirect(reply, '/admin/zalohy', me?.totp_enabled ? 'Heslo alebo kód nesedí.' : 'Heslo nesedí.', 'err');
    }
    if (me.totp_enabled) await query('UPDATE admin_users SET totp_last_step = $2 WHERE id = $1', [req.adminUser.id, step]);
    await audit(req, 'backup.key_shown');
    return reply.header('cache-control', 'no-store').type('text/html').send(page({
      title: 'Kľúč na obnovu', user: req.adminUser, nav: 'zalohy', body: recoveryKeyPage(recoveryKey()),
    }));
  });

  // The file comes as the raw request body (a fetch from the page), up to 512 MB.
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: 512 * 1024 * 1024 },
    (req, body, done) => done(null, body));

  app.post('/admin/zalohy/obnova', { bodyLimit: 512 * 1024 * 1024 }, async (req, reply) => {
    const { n } = await one('SELECT count(*)::int AS n FROM tenants');
    if (n > 0) return reply.code(409).type('text/plain').send('Obnova je možná len na prázdnej inštalácii (bez klientov).');
    if (!Buffer.isBuffer(req.body) || !req.body.length) return reply.code(400).type('text/plain').send('Chýba súbor zálohy.');
    try {
      const counts = await restoreBackup(req.body);
      invalidateTenantCache();
      req.log.warn({ counts }, 'database restored from a backup');
      await query(`INSERT INTO admin_audit (email, action, target) VALUES ($1, 'backup.restore', $2)`,
        [req.adminUser.email, `${counts.tenants || 0} klientov, ${counts.events || 0} eventov`]).catch(() => {});
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.type('text/plain').send(`Obnovené: ${plural(counts.tenants || 0, 'klient', 'klienti', 'klientov')}, `
        + `${plural(counts.events || 0, 'event', 'eventy', 'eventov')}. Prihláste sa účtom zo zálohy.`);
    } catch (err) {
      return reply.code(400).type('text/plain').send(`Obnova zlyhala, nič sa nezmenilo: ${err.message}`);
    }
  });
}
