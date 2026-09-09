import { test } from 'node:test';
import assert from 'node:assert/strict';

const { tenantDetail } = await import('../src/views/pages.js');
const { SCHEMAS } = await import('../src/destinations/index.js');

const tenant = {
  id: 1, name: 'Klient', collector_host: 't.klient.sk',
  allowed_origins: 'https://klient.sk', cookie_domain: '.klient.sk', active: true,
};
const html = tenantDetail(tenant, [], [], SCHEMAS);

test('every destination kind gets its own field group', () => {
  for (const kind of Object.keys(SCHEMAS)) {
    assert.ok(html.includes(`data-kind="${kind}"`), `missing group for ${kind}`);
  }
});

test('hidden destination fields are disabled, not merely hidden', () => {
  // A required input inside a hidden group blocks form submission and cannot be
  // focused, which makes the submit button appear dead. The toggle must disable.
  assert.match(html, /input\.disabled = !active/);
  assert.match(html, /select\.addEventListener\('change', sync\)/);
  assert.match(html, /sync\(\);/);
});

test('secrets are masked in the destination list', () => {
  const withSecret = tenantDetail(
    tenant,
    [{ id: 5, kind: 'meta', active: true, settings: { dataset_id: '123', access_token: 'EAAsecret' } }],
    [], SCHEMAS,
  );
  assert.ok(withSecret.includes('dataset_id=123'));
  assert.ok(!withSecret.includes('EAAsecret'), 'access token must never be rendered');
});

test('tenant-supplied text is escaped', () => {
  const evil = tenantDetail({ ...tenant, name: '<img src=x onerror=alert(1)>' }, [], [], SCHEMAS);
  assert.ok(!evil.includes('<img src=x'));
  assert.ok(evil.includes('&lt;img src=x'));
});
