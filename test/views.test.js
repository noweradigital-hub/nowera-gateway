import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tenantForm } = await import('../src/views/pages.js');
const { destinationsTab, settingsTab, tenantHeader, qualityTab } = await import('../src/views/tenant.js');
const { overviewPage } = await import('../src/views/overview.js');
const { eventDrawer } = await import('../src/views/events.js');
const { SCHEMAS } = await import('../src/destinations/index.js');

const tenant = {
  id: 1, name: 'Klient', collector_host: 't.klient.sk',
  allowed_origins: 'https://klient.sk', cookie_domain: '.klient.sk', active: true,
};
const dest = (over = {}) => ({
  id: 5, kind: 'meta', active: true, sent: 10, dead: 0, retrying: 0, p50: 1.2, p95: 3,
  last_success: new Date(), last_error: null, error_at: null, testing: false, tokenError: false,
  settings: { dataset_id: '123', access_token: 'EAAsecret' }, ...over,
});
const ok = { level: 'ok', reasons: [] };

test('every destination kind gets its own field group, and hidden fields are disabled', () => {
  const html = destinationsTab(tenant, [], SCHEMAS, 'v26.0');
  for (const kind of Object.keys(SCHEMAS)) {
    assert.ok(html.includes(`data-kind="${kind}"`), `missing group for ${kind}`);
  }
  // A required input inside a hidden group blocks form submission and cannot be
  // focused, which makes the submit button appear dead. The toggle must disable.
  assert.match(html, /input\.disabled = !active/);
  assert.match(html, /select\.addEventListener\('change', sync\)/);
  assert.match(html, /sync\(\);/);
});

test('secrets are never rendered on the destination cards', () => {
  const html = destinationsTab(tenant, [dest(), dest({ id: 6, kind: 'ga4', settings: { measurement_id: 'G-1', api_secret: 'GASECRET' } })], SCHEMAS, 'v26.0');
  assert.ok(html.includes('123'));
  assert.ok(!html.includes('EAAsecret') && !html.includes('GASECRET'));
});

test('tenant-supplied text is escaped', () => {
  const evil = tenantHeader({ ...tenant, name: '<img src=x onerror=alert(1)>' }, [], ok, 'prehlad');
  assert.ok(!evil.includes('<img src=x'));
  assert.ok(evil.includes('&lt;img src=x'));
  const list = overviewPage({ tenants: [{ ...tenant, name: '<b>x</b>', series: [1, 2], events24h: 3, avgDay: 2, errors24h: 0,
    destinations: [], health: ok, last_event_at: null }], totals: { events24h: 3, avgDay: 2, delivered: 1, waiting: 0, latency: 1, bots: 0 } });
  assert.ok(!list.includes('<b>x</b>'));
});

test('the tenant form offers the cookie keeper path, prefilled for new tenants', () => {
  assert.match(tenantForm(null), /name="keep_path"[^>]*value="\/wp-content\/plugins\/nowera-capi\/keep\.php"/);
  assert.match(tenantForm({ ...tenant, keep_path: null }), /name="keep_path"[^>]*value=""/, 'a cleared path stays cleared');
});

test('the signing key is never rendered on the settings tab, only its state', () => {
  const page = settingsTab({ ...tenant, ingest_secret: 'CURRENTKEY123', ingest_secret_prev: 'OLDKEY456', legacy_ingest: false });
  assert.ok(!page.includes('CURRENTKEY123') && !page.includes('OLDKEY456'));
  assert.match(page, /Vlastný kľúč je nastavený\. Predchádzajúci kľúč ešte platí\./);
  assert.match(page, /key\/revoke-previous/);
  assert.match(page, /Prijíma sa len vlastný kľúč/);
});

test('an active Meta test mode is announced on every tab with a way to end it', () => {
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  const testing = dest({ id: 7, settings: { dataset_id: '1', access_token: 'x', test_event_code: 'TEST9', test_until: until } });
  const page = tenantHeader(tenant, [testing], ok, 'kvalita');
  assert.match(page, /Testovací režim Meta do/);
  assert.match(page, /\/admin\/destinations\/7\/test-off/);
  const lapsed = tenantHeader(tenant, [dest({ settings: { dataset_id: '1', test_event_code: 'TEST9', test_until: '2026-01-01T00:00:00Z' } })], ok, 'kvalita');
  assert.doesNotMatch(lapsed, /Testovací režim Meta do/);
});

test('the test event button stays off until Meta is in test mode', () => {
  assert.match(tenantHeader(tenant, [dest()], ok, 'prehlad'), /<button class="btn" type="submit" disabled/);
  const until = new Date(Date.now() + 30 * 60_000).toISOString();
  const on = tenantHeader(tenant, [dest({ settings: { dataset_id: '1', test_event_code: 'T', test_until: until } })], ok, 'prehlad');
  assert.doesNotMatch(on, /type="submit" disabled/);
});

test('the quality table shows a dash where there is nothing to compare', () => {
  const html = qualityTab([{ event_name: 'AddToCart', n: 30, em: 0.29, ph: 0.06, ext: 1, fbp: 1, fbc: 0.35, ip: 1, country: 1,
    browser: 0, server: 30, paired: null }], []);
  assert.match(html, /29 %/);
  assert.match(html, /class="q na"/);
});

test('the event detail escapes what the site sent', () => {
  const html = eventDrawer({ id: 1, event_name: 'Lead', event_id: 'x', tenant_name: 'K', status: 'dead', attempts: 1,
    created_at: new Date(), payload: { note: '<script>alert(1)</script>' }, response: '<b>r</b>' }, '/admin/events');
  assert.ok(!html.includes('<script>alert(1)'));
  assert.ok(!html.includes('<b>r</b>'));
  assert.match(html, /\/admin\/events\/1\/retry/, 'a failed delivery can be sent again');
});

test('the alerts page never shows the stored webhook and escapes messages', async () => {
  const { alertsPage } = await import('../src/views/alerts.js');
  const html = alertsPage({
    settings: { webhook_url: 'https://n8n.example.sk/webhook/SECRETPATH', rules: { token: true, failing: false } },
    history: [{ id: 1, tenant_id: 2, tenant_name: 'K', rule: 'token', message: '<b>x</b>', opened_at: new Date(), resolved_at: null }],
  });
  assert.ok(!html.includes('SECRETPATH'));
  assert.ok(!html.includes('<b>x</b>'));
  assert.match(html, /name="rule_token" checked/);
  assert.doesNotMatch(html, /name="rule_failing" checked/);
});

test('inline scripts on the pages are valid JavaScript', async () => {
  const { newTenantPage } = await import('../src/views/pages.js');
  const { backupsPage } = await import('../src/views/backups.js');
  const pages = {
    newTenant: newTenantPage({ serverIp: '31.97.179.201', adminHost: 'signals.nwra.sk' }),
    backups: backupsPage({ settings: { keep_days: 30 }, state: {}, list: [], emptyInstall: true, keySource: 'SESSION_SECRET', isConfigured: false }),
    destinations: destinationsTab(tenant, [], SCHEMAS, 'v26.0'),
  };
  for (const [name, html] of Object.entries(pages)) {
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert.ok(scripts.length, `${name} has a script`);
    for (const js of scripts) assert.doesNotThrow(() => new Function(js), `${name}: script does not parse`);
  }
});

test('the new client form derives the rest from the website address in the browser too', async () => {
  const { newTenantPage } = await import('../src/views/pages.js');
  const html = newTenantPage({ serverIp: '31.97.179.201', adminHost: 'signals.nwra.sk' });
  assert.match(html, /CNAME signals\.nwra\.sk/);
  assert.match(html, /A 31\.97\.179\.201/);
  assert.match(html, /<option value="auto" selected>/);
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const derive = new Function(`${js.replace(/site\.addEventListener[\s\S]*$/, '').replace(/var site = [^;]+;/, '').replace(/^\s*\(function \(\) \{/, '')}; return derive;`)();
  assert.deepEqual(derive('https://www.klient.sk/'), {
    collector_host: 't.klient.sk', allowed_origins: 'https://klient.sk,https://www.klient.sk', cookie_domain: '.klient.sk', slug: 'klient',
  });
});

test('backups never show the stored storage secret, and the key only after a password', async () => {
  const { backupsPage, recoveryKeyPage } = await import('../src/views/backups.js');
  const html = backupsPage({
    settings: { endpoint: 'https://a.r2.cloudflarestorage.com', bucket: 'b', prefix: 'gw/', access_key_id: 'AKID', secret_access_key: 'SUPERSECRET', keep_days: 30 },
    state: { last_ok_at: new Date().toISOString(), last_ok_size: 2_100_000, last_counts: { tenants: 3, events: 5344 } },
    list: [{ key: 'gw/2026-09-28T033000Z.nwrb', size: 2_100_000, modified: new Date() }],
    emptyInstall: false, keySource: 'SESSION_SECRET', totpEnabled: true, isConfigured: true,
  });
  assert.ok(!html.includes('SUPERSECRET'));
  assert.match(html, /uložený — nechajte prázdne/);
  assert.match(html, /name="code"/, 'with 2FA on, the key needs a code too');
  assert.doesNotMatch(html, /restore-form/, 'restore only on an empty installation');
  assert.match(html, /stiahnut\?key=gw%2F2026-09-28T033000Z\.nwrb/);
  assert.match(recoveryKeyPage('nwrk1_abc'), /value="nwrk1_abc"/);
});

test('the completeness card lists days and missing orders, escaped', async () => {
  const { completenessCard } = await import('../src/views/tenant.js');
  const html = completenessCard({
    days: [{ day: '2026-10-06', orders: 4, eligible: 3, consented: 2, received: 1, ok: 1, pending: 0, missing: 1, excluded: 2 }],
    missing: [{ order_id: '12<b>', day: '2026-10-06', status: 'processing', reason: 'neprišiel do signals' }],
  }, null);
  assert.match(html, /Úplnosť nákupov/);
  assert.match(html, /plugin zatiaľ zoznam objednávok neposlal/);
  assert.match(html, /neprišiel do signals/);
  assert.ok(!html.includes('12<b>'), 'escaped');
});

test('WP-Cron: a switch in the new-client setup and in the client settings', async () => {
  const { newTenantPage, tenantForm } = await import('../src/views/pages.js');
  assert.match(newTenantPage({ serverIp: '1.2.3.4', adminHost: 'gw.example.com' }), /name="cron_enabled" checked/);
  const form = tenantForm({ id: 1, name: 'K', allowed_origins: 'https://www.klient.sk', cron_enabled: true, cron_url: '', cron_last_at: '2026-10-07T11:58:00Z', cron_last_status: 'HTTP 200, 300 ms' });
  assert.match(form, /name="cron_enabled" checked/);
  assert.match(form, /placeholder="https:\/\/www\.klient\.sk\/wp-cron\.php"/);
  assert.match(form, /Naposledy: HTTP 200, 300 ms/);
});
