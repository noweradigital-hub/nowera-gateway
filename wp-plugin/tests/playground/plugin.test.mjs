// Integration tests for the Nowera CAPI WordPress plugin, run against a live
// WordPress Playground with WooCommerce. Start Playground first (see README in
// this folder), then: node --test wp-plugin/tests/playground/plugin.test.mjs
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.NWR_WP || 'http://127.0.0.1:9410';
const sha = (v) => createHash('sha256').update(v).digest('hex');

async function json(path) {
  const res = await fetch(BASE + path);
  const text = await res.text();
  try { return JSON.parse(text); } catch { throw new Error(`${path} → ${res.status}: ${text.slice(0, 400)}`); }
}
async function html(path, cookie) {
  const res = await fetch(BASE + path, { headers: cookie ? { cookie } : {} });
  return res.text();
}
const setConsent = (mode) => json(`/nwr-test/set.php?consent=${mode}`);
const fire = (event, cookies = '', extra = '') =>
  json(`/nwr-test/fire.php?event=${event}&cookies=${encodeURIComponent(cookies)}${extra}`);
const fireCs = (event, cs, cookies = '') => fire(event, cookies, `&cs=${encodeURIComponent(cs)}`);

function inline(page, name) {
  const m = page.match(new RegExp(`window\\.${name}=(\\{.*?\\});`));
  return m ? JSON.parse(m[1]) : null;
}

let ids;
before(async () => {
  // Playground answers HTTP before its blueprint has finished activating
  // WooCommerce, so wait for the plugins rather than for the port.
  for (let i = 0; ; i++) {
    const d = await json('/nwr-test/diag.php').catch(() => ({}));
    if (d.woo_class && d.capi_loaded) break;
    if (i > 90) throw new Error('WooCommerce never finished activating in Playground');
    await new Promise((r) => setTimeout(r, 2000));
  }
  ids = (await json('/nwr-test/setup.php'));
  await fetch(BASE + '/nwr-test/remember.php', { method: 'POST', body: JSON.stringify(ids) });
  await setConsent('none');
});

// ---------------------------------------------------------------- frontend

test('a simple product page publishes cache-safe product data for ViewContent', async () => {
  const page = await html(`/?post_type=product&p=${ids.simple}`);
  assert.match(page, /<script async src="https:\/\/collector\.test\/px\.js"><\/script>/);
  const p = inline(page, 'nwrPage');
  assert.equal(p.type, 'product');
  assert.deepEqual(p.data.content_ids, [String(ids.simple)]);
  assert.equal(p.data.content_type, 'product');
  assert.equal(p.data.value, 24.9);
  assert.equal(p.data.currency, 'EUR');
  assert.equal(p.data.content_category, 'Osušky');
  assert.deepEqual(p.data.contents, [{ id: String(ids.simple), quantity: 1, item_price: 24.9 }]);
});

test('a variable product is a product group priced from its cheapest variation', async () => {
  const p = inline(await html(`/?post_type=product&p=${ids.variable}`), 'nwrPage');
  assert.equal(p.data.content_type, 'product_group');
  assert.equal(p.data.value, 30);
});

test('a category page lists the products on it', async () => {
  const p = inline(await html(`/?product_cat=osusky`), 'nwrPage');
  assert.equal(p.type, 'category');
  assert.equal(p.data.content_category, 'Osušky');
  assert.ok(p.data.content_ids.includes(String(ids.simple)));
  assert.ok(p.data.content_ids.includes(String(ids.variable)));
  assert.equal(p.data.content_type, 'product_group', 'one variable product makes it a group');
});

test('a product search page carries the search string', async () => {
  // Two matches on purpose: with exactly one, WooCommerce redirects to that
  // product, which then (correctly) fires ViewContent instead.
  const p = inline(await html(`/?s=de&post_type=product`), 'nwrPage');
  assert.equal(p.type, 'search');
  assert.equal(p.data.search_string, 'de');
  assert.equal(p.data.content_ids.length, 2);
});

test('a non-shop page publishes no page context', async () => {
  const page = await html('/');
  assert.equal(inline(page, 'nwrPage'), null);
  assert.match(page, /collector\.test\/px\.js/, 'the loader still loads');
});

test('guests never get identity in the page, even with Woo defaults present', async () => {
  const page = await html(`/?post_type=product&p=${ids.simple}`);
  assert.equal(inline(page, 'nwrUser'), null, 'a guest page may be cached and shown to others');
});

test('signed-in customers get hashed identity in the page', async () => {
  const { name, value } = await json('/nwr-test/login-cookie.php');
  const page = await html(`/?post_type=product&p=${ids.simple}`, `${name}=${encodeURIComponent(value)}`);
  const u = inline(page, 'nwrUser');
  assert.ok(u, 'nwrUser printed for a logged-in customer');
  assert.equal(u.em, sha('zakaznik@example.com'));
  assert.equal(u.fn, sha('ján'));
  assert.equal(u.external_id, sha(String(ids.user)));
  // WooCommerce itself preloads the cart state (with the e-mail) for block
  // themes; what matters is that our own output carries only digests.
  const ours = page.match(/<script>window\.nwr[^<]*<\/script>/)[0];
  assert.doesNotMatch(ours, /zakaznik|example\.com|ján|novák/i, 'our script holds no plaintext');
});

test('without consent handling the page does not announce a consent mode', async () => {
  assert.equal(inline(await html('/'), 'nwrConsent'), null);
});

test('with Complianz the page tells the loader how to read consent', async () => {
  await setConsent('complianz');
  try {
    assert.deepEqual(inline(await html('/'), 'nwrConsent'), { mode: 'complianz', prefix: 'cmplz_' });
  } finally {
    await setConsent('none');
  }
});

// --------------------------------------------------------- server events

test('AddToCart is signed and names the catalog item', async () => {
  const { sent } = await fire('add_to_cart');
  assert.equal(sent.length, 1);
  const [e] = sent;
  assert.equal(e.url, 'https://collector.test/s');
  assert.equal(e.signature_valid, true);
  assert.equal(e.body.event_name, 'AddToCart');
  assert.deepEqual(e.body.custom_data.content_ids, [String(ids.simple)]);
  assert.equal(e.body.custom_data.contents[0].quantity, 3);
  assert.equal(e.body.custom_data.value, 74.7, 'rounded to the store precision');
  assert.equal(e.body.consent, undefined);
});

test('adding a variation reports the variation, which is what the catalog holds', async () => {
  const { sent } = await fire('add_to_cart_variation');
  assert.deepEqual(sent[0].body.custom_data.content_ids, [String(ids.variations[0])]);
  assert.equal(sent[0].body.custom_data.value, 30);
});

test('InitiateCheckout lists what is in the cart', async () => {
  const { sent } = await fire('checkout');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.event_name, 'InitiateCheckout');
  assert.deepEqual(sent[0].body.custom_data.content_ids, [String(ids.simple), String(ids.variations[1])]);
});

test('AddPaymentInfo is sent once per order with full billing identity', async () => {
  const { sent } = await fire('payment_info');
  assert.equal(sent.length, 1, 'a retried checkout must not send it twice');
  const b = sent[0].body;
  assert.equal(b.event_name, 'AddPaymentInfo');
  assert.match(b.event_id, /^pay-\d+$/);
  assert.equal(b.user_data.em, sha('jan.novak@example.com'));
  assert.equal(b.user_data.ph, sha('421903123456'));
  assert.equal(b.user_data.ct, sha('banskábystrica'));
  assert.equal(b.user_data.zp, sha('97401'));
  assert.deepEqual(b.custom_data.content_ids, [String(ids.simple), String(ids.variations[1])]);
  assert.equal(sent[0].signature_valid, true);
});

test('the block checkout also triggers AddPaymentInfo', async () => {
  const { sent } = await fire('payment_info_block');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.event_name, 'AddPaymentInfo');
});

test('Purchase is sent once, with catalog ids, even when the thank-you page is reloaded', async () => {
  const { sent, footer } = await fire('purchase');
  assert.equal(sent.length, 1);
  const b = sent[0].body;
  assert.equal(b.event_name, 'Purchase');
  assert.match(b.event_id, /^ord-\d+$/);
  assert.deepEqual(b.custom_data.content_ids, [String(ids.simple), String(ids.variations[1])]);
  assert.equal(b.custom_data.num_items, 3);

  // The browser leg must carry the same products: Meta may keep the pixel copy.
  const legs = [...footer.matchAll(/window\.nwr\("track","Purchase",(.*?),\{eventID:(".*?")\}\);<\/script>/g)];
  assert.equal(legs.length, 1);
  assert.equal(JSON.parse(legs[0][2]), b.event_id);
  assert.deepEqual(JSON.parse(legs[0][1]), b.custom_data);
});

// ------------------------------------------------------------- consent

test('with Complianz and no decision yet nothing leaves the site', async () => {
  await setConsent('complianz');
  try {
    for (const ev of ['add_to_cart', 'checkout', 'payment_info', 'purchase']) {
      const { sent } = await fire(ev, '_fbp:fb.1.1.2');
      assert.equal(sent.length, 0, `${ev} must not be sent without consent`);
    }
  } finally {
    await setConsent('none');
  }
});

test('statistics-only consent sends the event without contact details or marketing ids', async () => {
  await setConsent('complianz');
  try {
    const { sent } = await fire('purchase', 'cmplz_statistics:allow,_fbp:fb.1.1.2,_fbc:fb.1.1.abc');
    assert.equal(sent.length, 1);
    const b = sent[0].body;
    assert.deepEqual(b.consent, { marketing: false, statistics: true });
    assert.equal(b.fbp, null);
    assert.equal(b.fbc, null);
    assert.deepEqual(Object.keys(b.user_data), ['country'], 'only the country survives');
    assert.equal(sent[0].signature_valid, true);
  } finally {
    await setConsent('none');
  }
});

test('full consent sends everything, marked as consented', async () => {
  await setConsent('complianz');
  try {
    const { sent } = await fire('purchase', 'cmplz_marketing:allow,cmplz_statistics:allow,_fbp:fb.1.1.2');
    const b = sent[0].body;
    assert.deepEqual(b.consent, { marketing: true, statistics: true });
    assert.equal(b.fbp, 'fb.1.1.2');
    assert.equal(b.user_data.em, sha('jan.novak@example.com'));
  } finally {
    await setConsent('none');
  }
});

test('a denied marketing cookie is not mistaken for consent', async () => {
  await setConsent('complianz');
  try {
    const { sent } = await fire('add_to_cart', 'cmplz_marketing:deny,cmplz_statistics:deny');
    assert.equal(sent.length, 0);
  } finally {
    await setConsent('none');
  }
});

test('another consent tool works through its own cookie prefix', async () => {
  await setConsent('custom');
  try {
    const { sent } = await fire('add_to_cart', 'my_marketing:allow');
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0].body.consent, { marketing: true, statistics: false });
    const none = await fire('add_to_cart', 'cmplz_marketing:allow');
    assert.equal(none.sent.length, 0, 'the Complianz cookie means nothing when another prefix is configured');
  } finally {
    await setConsent('none');
  }
});

// --------------------------------------------------------- CookieScript

test('CookieScript: the page tells the loader to read CookieScript', async () => {
  await setConsent('cookiescript');
  try {
    assert.equal(inline(await html('/'), 'nwrConsent').mode, 'cookiescript');
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: no decision and a rejection both send nothing', async () => {
  await setConsent('cookiescript');
  try {
    for (const ev of ['add_to_cart', 'checkout', 'payment_info', 'purchase']) {
      assert.equal((await fire(ev, '_fbp:fb.1.1.2')).sent.length, 0, `${ev} without a decision`);
      assert.equal((await fireCs(ev, 'reject', '_fbp:fb.1.1.2')).sent.length, 0, `${ev} after reject`);
    }
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: targeting + performance sends everything', async () => {
  await setConsent('cookiescript');
  try {
    const { sent } = await fireCs('purchase', 'targeting|performance', '_fbp:fb.1.1.2');
    assert.equal(sent.length, 1);
    const b = sent[0].body;
    assert.deepEqual(b.consent, { marketing: true, statistics: true });
    assert.equal(b.fbp, 'fb.1.1.2');
    assert.equal(b.user_data.em, sha('jan.novak@example.com'));
    assert.equal(sent[0].signature_valid, true);
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: performance only reaches GA4 without contact details', async () => {
  await setConsent('cookiescript');
  try {
    const { sent } = await fireCs('purchase', 'performance', '_fbp:fb.1.1.2');
    const b = sent[0].body;
    assert.deepEqual(b.consent, { marketing: false, statistics: true });
    assert.equal(b.fbp, null);
    assert.deepEqual(Object.keys(b.user_data), ['country']);
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: targeting only still reaches Meta', async () => {
  await setConsent('cookiescript');
  try {
    const { sent } = await fireCs('add_to_cart', 'targeting');
    assert.deepEqual(sent[0].body.consent, { marketing: true, statistics: false });
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: a malformed cookie is treated as no consent, not a crash', async () => {
  await setConsent('cookiescript');
  try {
    for (const raw of ['{not json', '{"categories":"not json"}', '{"categories":42}', '"just a string"']) {
      const { sent } = await fire('add_to_cart', '', `&cs_raw=${encodeURIComponent(raw)}`);
      assert.equal(sent.length, 0, `cookie ${raw}`);
    }
  } finally {
    await setConsent('none');
  }
});

test('CookieScript: a Complianz cookie means nothing in CookieScript mode', async () => {
  await setConsent('cookiescript');
  try {
    const { sent } = await fire('add_to_cart', 'cmplz_marketing:allow,cmplz_statistics:allow');
    assert.equal(sent.length, 0);
  } finally {
    await setConsent('none');
  }
});
