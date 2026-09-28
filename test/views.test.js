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
