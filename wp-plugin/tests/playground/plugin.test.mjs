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
const fireCs = (event, cs, cookies = '', extra = '') => fire(event, cookies, `&cs=${encodeURIComponent(cs)}${extra}`);

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
  assert.deepEqual(p.data.contents, [{ id: String(ids.simple), item_name: 'Detská osuška', quantity: 1, item_price: 24.9, price_net: 24.9, item_category: 'Osušky' }]);
  assert.equal(p.data.value_net, 24.9);
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
  assert.match(e.plugin, /^\d+\.\d+\.\d+$/, 'the gateway can tell which plugin version sent it');
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

test('an ad click without the loader still leaves the click id behind', async () => {
  const cookieFor = async (path, headers = {}) =>
    (await fetch(`${BASE}${path}`, { headers, redirect: 'manual' })).headers.getSetCookie()
      .find((c) => c.startsWith('_fbc='));

  const set = await cookieFor('/?fbclid=CLICK-abc_123');
  assert.match(set, /^_fbc=fb\.1\.\d{13}\.CLICK-abc_123/);
  assert.match(set, /Max-Age=7776000/i);
  assert.doesNotMatch(set, /HttpOnly/i, 'the Meta pixel reads it too');

  assert.equal(await cookieFor('/?fbclid=CLICK2', { cookie: '_fbc=fb.1.1.EARLIER' }), undefined,
    'an existing click id is never overwritten');
  assert.equal(await cookieFor('/'), undefined);
  assert.equal(await cookieFor('/?fbclid=%3Cscript%3E'), undefined, 'only a plausible click id');

  await setConsent('cookiescript');
  try {
    assert.equal(await cookieFor('/?fbclid=CLICK3', { cookie: csCookie(['strict', 'performance']) }), undefined,
      'no marketing consent, no click id');
    assert.ok(await cookieFor('/?fbclid=CLICK4', { cookie: csCookie(['strict', 'targeting']) }));
  } finally {
    await setConsent('none');
  }
});

test('the click id in the landing url travels with server events too', async () => {
  const { sent } = await fire('checkout', '', '&fbclid=CLICK-in-url');
  assert.equal(sent[0].body.fbclid, 'CLICK-in-url');
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

test('InitiateCheckout is sent from the browser as well, with one shared id', async () => {
  const { sent, footer } = await fire('checkout');
  const b = sent[0].body;
  assert.equal(b.event_name, 'InitiateCheckout');

  const legs = [...footer.matchAll(/window\.nwr\("track","InitiateCheckout",(.*?),\{eventID:(".*?")\}\);<\/script>/g)];
  assert.equal(legs.length, 1);
  assert.equal(JSON.parse(legs[0][2]), b.event_id, 'one id, so Meta counts one checkout');
  assert.deepEqual(JSON.parse(legs[0][1]), b.custom_data);
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

test('Purchase items carry name, category and variant; the order its tax and shipping', async () => {
  const { sent } = await fire('purchase');
  const d = sent[0].body.custom_data;
  assert.deepEqual(d.contents[0], { id: String(ids.simple), item_name: 'Detská osuška', quantity: 2, item_price: 24.9, price_net: 24.9, item_category: 'Osušky' });
  assert.equal(d.contents[1].id, String(ids.variations[1]));
  assert.equal(d.contents[1].item_name, 'Deka', 'the product, not "Deka - M"');
  assert.equal(d.contents[1].item_variant, 'M');
  assert.equal(d.contents[1].item_price, 38);
  assert.equal(d.value, 87.8);
  assert.equal(d.value_net, 87.8, 'no VAT set up in this shop');
  assert.equal(d.tax, 0);
  assert.equal(d.shipping, 0);
});

test('Google gets e-mail and phone hashed its own way, only with marketing consent', async () => {
  const { sent } = await fire('purchase');
  assert.deepEqual(sent[0].body.google_user, {
    sha256_email_address: [sha('jan.novak@example.com')],
    sha256_phone_number: [sha('+421903123456')],
  });
  const gmail = await fire('purchase', '', '&email=Jan.Novak@Gmail.com');
  assert.deepEqual(gmail.sent[0].body.google_user.sha256_email_address, [sha('jannovak@gmail.com')], 'Gmail ignores dots');
  await setConsent('cookiescript');
  try {
    const statsOnly = await fireCs('purchase', 'performance');
    assert.equal(statsOnly.sent[0].body.google_user, null);
  } finally {
    await setConsent('none');
  }
});

test('GA4 user_id: the customer account, never a guest', async () => {
  const guest = await fire('purchase');
  assert.equal(guest.sent[0].body.account_id, null);
  const customer = await fire('purchase', '', '&as_user=1');
  assert.equal(customer.sent[0].body.account_id, sha(`nwr-account|${BASE}/|${ids.user}`));
  assert.notEqual(customer.sent[0].body.user_data.external_id, customer.sent[0].body.account_id);
});

test('checkout and payment carry the cart as items, payment its method', async () => {
  const checkout = await fire('checkout');
  const items = checkout.sent[0].body.custom_data.contents;
  assert.deepEqual(items.map((i) => i.item_name), ['Detská osuška', 'Deka']);
  const pay = await fire('payment_info');
  assert.equal(pay.sent[0].body.custom_data.contents.length, 2);
  assert.ok('payment_type' in pay.sent[0].body.custom_data);
});

test('Purchase tells Meta whether the buyer is new or returning', async () => {
  const email = `Novy.${Date.now()}@Example.com`;
  const segment = async (extra) => (await fire('purchase', '', extra)).sent[0].body.custom_data.customer_segmentation;

  assert.equal(await segment(`&email=${encodeURIComponent(email)}`), 'new_customer_to_business');
  assert.equal(await segment(`&email=${encodeURIComponent('x' + email)}&prior=failed`), 'new_customer_to_business',
    'a failed earlier order is not a purchase');
  assert.equal(await segment(`&email=${encodeURIComponent('y' + email)}&prior=completed`), 'existing_customer_to_business',
    'found even though the earlier order stored the email in lower case');
  assert.equal(await segment(`&email=${encodeURIComponent('z' + email)}&prior=on-hold`), 'existing_customer_to_business');
});

test('server events on a full page load carry the referrer, without its query', async () => {
  const ref = encodeURIComponent('https://shop.test/kosik/?coupon=ZLAVA#top');
  const page = await fire('checkout', '', `&ref=${ref}`);
  assert.equal(page.sent[0].body.referrer_url, 'https://shop.test/kosik/');

  const ajax = await fire('checkout', '', `&ajax=1&ref=${ref}`);
  assert.equal(ajax.sent[0].body.referrer_url, null, 'an AJAX call only knows the page itself');

  const direct = await fire('checkout');
  assert.equal(direct.sent[0].body.referrer_url, null);
});

test('every order records whether its Purchase was reported, and why not', async () => {
  const withConsent = await fire('purchase');
  assert.equal(withConsent.purchase.consent, 'marketing');
  assert.equal(withConsent.purchase.sent, true);
  assert.match(withConsent.purchase.notes.join(' '), /Nowera CAPI: Purchase odoslaný do Mety/);

  await setConsent('cookiescript');
  try {
    const statsOnly = await fireCs('purchase', 'performance');
    assert.equal(statsOnly.purchase.consent, 'statistics');
    assert.equal(statsOnly.sent.length, 1, 'GA4 may still have it');
    assert.match(statsOnly.purchase.notes.join(' '), /bez marketingového súhlasu/);

    // No decision at all: nothing leaves the site and the order stays open, so
    // accepting the banner on the thank-you page still reports the purchase.
    const undecided = await fire('purchase');
    assert.equal(undecided.purchase.consent, 'none');
    assert.equal(undecided.purchase.sent, false);
    assert.equal(undecided.sent.length, 0);
    assert.match(undecided.purchase.notes.join(' '), /nedal súhlas/);

    const recovered = await fireCs('purchase', 'targeting', '', `&reuse=${undecided.purchase.order}`);
    assert.equal(recovered.purchase.order, undecided.purchase.order);
    assert.equal(recovered.purchase.consent, 'marketing');
    assert.equal(recovered.sent.length, 1, 'the same order is reported once it may be');
  } finally {
    await setConsent('none');
  }
});

test('a buyer who pays but never returns to the site is still reported, from checkout data', async () => {
  const { sent, purchase } = await fire('paid_no_return', '_fbp:fb.1.1700000000000.1234567890,_nwr_id:visitor-abcdef12');
  assert.equal(purchase.scheduled, true, 'queued for half an hour later');
  assert.equal(sent.length, 1);
  const b = sent[0].body;
  assert.equal(b.event_name, 'Purchase');
  assert.equal(b.event_id, `ord-${purchase.order}`, 'same id the thank-you page would have used');
  assert.equal(b.fbp, 'fb.1.1700000000000.1234567890', 'browser id remembered from checkout');
  assert.equal(b.client_ip_address, '203.0.113.9');
  assert.match(b.client_user_agent, /TestSafari/);
  assert.equal(b.user_data.external_id, sha('visitor-abcdef12'));
  assert.equal(b.user_data.em, sha('jan.novak@example.com'));
  assert.ok(b.custom_data.value > 0);
  assert.ok(Math.abs(b.event_time - Date.now() / 1000) < 120, 'timed at the payment');
  assert.equal(purchase.sent, true);
  assert.match(purchase.notes.join(' '), /Po potvrdení platby/);
});

test('when the thank-you page did load, the payment confirmation adds nothing', async () => {
  const { sent, purchase } = await fire('paid_with_return', '_fbp:fb.1.1700000000000.1234567890');
  assert.equal(purchase.scheduled, false);
  assert.equal(sent.length, 0, 'reported once, by the thank-you page');
  assert.equal(purchase.consent, 'marketing');
});

test('back on the thank-you page before the payment was confirmed: reported a minute after it is', async () => {
  const { sent, purchase } = await fire('unpaid_return_then_paid', '_fbp:fb.1.1700000000000.1234567890');
  assert.equal(purchase.scheduled, true);
  assert.ok(purchase.delay <= 60 && purchase.delay > 0, `not half an hour (${purchase.delay} s)`);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.event_name, 'Purchase');
  assert.equal(sent[0].body.browserless, true, 'the page loaded unpaid and reported nothing');
});

test('a failed or unpaid order is not a purchase, however often its thank-you page loads', async () => {
  for (const status of ['failed', 'pending', 'cancelled']) {
    const { sent, purchase } = await fire('purchase', '', `&status=${status}`);
    assert.equal(sent.length, 0, status);
    assert.equal(purchase.sent, false, status);
    assert.equal(purchase.consent, '', `${status}: nothing decided, a later payment still counts`);
  }
});

test('cash on delivery and bank transfer count when placed', async () => {
  const { sent } = await fire('purchase', '', '&status=on-hold');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.event_name, 'Purchase');
});

test('a counted order cancelled later is taken back in GA4, once', async () => {
  const { sent, purchase } = await fire('cancel_after_purchase');
  assert.equal(sent.length, 1);
  const b = sent[0].body;
  assert.equal(b.event_name, 'Refund');
  assert.equal(b.event_id, `cancel-${purchase.order}`);
  assert.equal(b.custom_data.order_id, purchase.order);
  assert.ok(b.custom_data.value > 0);
  assert.equal(b.custom_data.contents, undefined, 'the whole order');
  assert.equal(b.browserless, true);
  const unpaid = await fire('cancel_unpaid');
  assert.equal(unpaid.sent.length, 0, 'never counted, nothing to take back');
  const both = await fire('cancel_after_purchase', '', '&refund_after=1');
  assert.deepEqual(both.sent.map((c) => c.body.event_id), [`cancel-${both.purchase.order}`], 'a refund after the cancellation takes nothing back twice');
});

test('a buyer without consent at checkout is not reported after payment either', async () => {
  await setConsent('cookiescript');
  try {
    const { sent, purchase } = await fire('paid_no_return', '_fbp:fb.1.1700000000000.1234567890');
    assert.equal(sent.length, 0);
    assert.equal(purchase.consent, 'none');
    assert.equal(purchase.sent, false);
    assert.match(purchase.notes.join(' '), /Po potvrdení platby.*nedal súhlas/);
  } finally {
    await setConsent('none');
  }
});

// ---------------------------------------------------------- FAZ Cookie Manager

test('FAZ: the page tells the loader to read FAZ', async () => {
  await setConsent('faz');
  try {
    assert.deepEqual(inline(await html('/'), 'nwrConsent'), { mode: 'faz', prefix: 'cmplz_' });
  } finally {
    await setConsent('none');
  }
});

test('FAZ: marketing goes to Meta, analytics alone only to GA4, no decision nowhere', async () => {
  await setConsent('faz');
  try {
    const both = await fire('purchase', '', '&faz=marketing|analytics');
    assert.equal(both.purchase.consent, 'marketing');
    assert.deepEqual(both.sent[0].body.consent, { marketing: true, statistics: true });

    const statsOnly = await fire('purchase', '', '&faz=analytics');
    assert.equal(statsOnly.purchase.consent, 'statistics');
    assert.deepEqual(statsOnly.sent[0].body.consent, { marketing: false, statistics: true });

    // "performance" is a different FAZ category; it is not GA4's.
    const perf = await fire('purchase', '', '&faz=performance');
    assert.equal(perf.sent.length, 0);

    const undecided = await fire('purchase', '', '&faz=marketing|analytics&faz_undecided=1');
    assert.equal(undecided.purchase.consent, 'none', 'a cookie without a decision does not count');
    assert.equal(undecided.sent.length, 0);

    const none = await fire('purchase');
    assert.equal(none.sent.length, 0);
  } finally {
    await setConsent('none');
  }
});

test('FAZ: a decision under an older policy revision no longer counts', async () => {
  await json('/nwr-test/set.php?consent=faz&rev=2');
  try {
    const old = await fire('purchase', '', '&faz=marketing|analytics');
    assert.equal(old.purchase.consent, 'none');
    assert.equal(old.sent.length, 0);
  } finally {
    await setConsent('none');
  }
});

test('FAZ: without FAZ itself nobody counts as consenting', async () => {
  await json('/nwr-test/set.php?consent=faz&stub=0');
  try {
    const r = await fire('purchase', '', '&faz=marketing|analytics');
    assert.equal(r.purchase.consent, 'none');
    assert.equal(r.sent.length, 0);
  } finally {
    await setConsent('none');
  }
});

// ------------------------------------------------------------- Google tag

test('the Google tag: the page only names it, before px.js, under a denied default', async () => {
  assert.doesNotMatch(await html('/'), /googletagmanager\.com\/gtag|nwrGtag/);
  await json('/nwr-test/set.php?consent=faz&ga4=G-TEST1234');
  try {
    const page = await html('/');
    assert.doesNotMatch(page, /googletagmanager\.com\/gtag/, 'nothing loads from Google before consent');
    const config = page.match(/<script>(window\.nwrConsent=[^<]*)<\/script>/)[1];
    assert.match(config, /window\.nwrGtag="G-TEST1234"/);
    assert.match(config, /gtag\('consent','default',\{[^}]*analytics_storage:'denied'/);
    assert.doesNotMatch(config, /gtag\('config'/, 'config comes from px.js, after consent');
    assert.ok(page.indexOf('nwrGtag') < page.indexOf('/px.js'), 'there before px.js can run');
    assert.doesNotMatch(page, /gtag\('event'/, 'events come from the gateway');

    // The safety default only applies when the consent tool has not set one.
    const stub = config.slice(config.indexOf('window.dataLayer='));
    const run = new Function('window', 'dataLayer', `${stub.replace('window.dataLayer=window.dataLayer||[];', '')} return dataLayer;`);
    const after = run({}, [['consent', 'default', { analytics_storage: 'denied' }]]);
    assert.equal(after.filter((a) => a[0] === 'consent').length, 1, 'the tool\'s own default is kept, not duplicated');
  } finally {
    await setConsent('none');
  }
});

test('the Google tag without px.js: only on a site that does not ask for consent', async () => {
  await json('/nwr-test/set.php?consent=faz&ga4=G-TEST1234&loader=0');
  try {
    assert.doesNotMatch(await html('/'), /googletagmanager\.com\/gtag/, 'nothing could wait for consent');
  } finally {
    await setConsent('none');
  }
  await json('/nwr-test/set.php?consent=none&ga4=G-TEST1234&loader=0');
  try {
    const page = await html('/');
    assert.match(page, /<script async src="https:\/\/www\.googletagmanager\.com\/gtag\/js\?id=G-TEST1234"><\/script>/);
    assert.match(page, /gtag\('config',"G-TEST1234"\)/);
  } finally {
    await setConsent('none');
  }
});

test('refunds give GA4 back item revenue only: shipping alone is none', async () => {
  const { sent } = await fire('refund_shipping');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].body.custom_data.value, 3.9);
  assert.equal(sent[0].body.custom_data.value_net, 0);
});

test('a cancellation after a partial refund takes back only the rest of the item revenue', async () => {
  const { sent, purchase } = await fire('refund_then_cancel');
  const [refund, cancel] = sent.map((c) => c.body.custom_data);
  assert.equal(sent.length, 2);
  assert.equal(refund.value_net, 24.9);
  assert.equal(cancel.value_net, 87.8 - 24.9, 'together exactly the purchase\'s item revenue');
  assert.equal(Math.round((refund.value + cancel.value) * 100) / 100, purchase.total);
});

// ------------------------------------------------------------ cookie keeper

test('pages publish where px.js can refresh the identifiers', async () => {
  assert.match(await html('/'), /window\.nwrKeep="[^"]*nowera-capi\\?\/keep\.php"/);
});

test('the cookie keeper writes the visitor\u2019s own identifiers back for 90 days', async () => {
  const ud = encodeURIComponent(JSON.stringify({ em: 'a'.repeat(64) }));
  const res = await fetch(`${BASE}/wp-content/plugins/nowera-capi/keep.php`, {
    headers: { cookie: `_fbp=fb.1.1700000000000.1234567890; _fbc=fb.1.1700000000000.IwAR-abc_1; _nwr_id=visitor-abcdef12; _nwr_ud=${ud}; other=1` },
  });
  assert.equal(res.status, 204);
  assert.match(res.headers.get('cache-control') || '', /no-store/);
  const set = res.headers.getSetCookie();
  assert.deepEqual(set.map((c) => c.split('=')[0]).sort(), ['_fbc', '_fbp', '_nwr_id', '_nwr_ud'], 'nothing else is touched');
  for (const c of set) {
    assert.match(c, /Max-Age=7776000/i);
    assert.doesNotMatch(c, /HttpOnly/i, 'the pixel and px.js must still read them');
    assert.doesNotMatch(c, /Domain=/i, 'an IP host gets host-only cookies');
  }
  assert.ok(set.find((c) => c.startsWith('_fbp=fb.1.1700000000000.1234567890;')), 'value unchanged');
});

test('the cookie keeper ignores anything that is not an identifier', async () => {
  const res = await fetch(`${BASE}/wp-content/plugins/nowera-capi/keep.php`, {
    headers: { cookie: '_fbp=%3Cscript%3E; _nwr_id=x; _fbc=fb.1.1.nope nope' },
  });
  assert.equal(res.status, 204);
  assert.deepEqual(res.headers.getSetCookie(), []);
});

// ------------------------------------------------ returning customers

const csCookie = (categories, action = 'accept') =>
  'CookieScriptConsent=' + encodeURIComponent(JSON.stringify({ action, categories: JSON.stringify(categories), key: 'k' }));
const storedCookie = (res) => (res.headers.getSetCookie() || []).find((c) => c.startsWith('_nwr_ud='));
const storedFrom = (res) => {
  const c = storedCookie(res);
  return c ? JSON.parse(decodeURIComponent(c.split(';')[0].slice('_nwr_ud='.length))) : null;
};

test('the thank-you page of a fresh order stores the buyer, hashed, for later visits', async () => {
  const { received_url: url } = await fire('order_url');
  const res = await fetch(url, { redirect: 'manual' });
  const ud = storedFrom(res);
  assert.ok(ud, `cookie set on ${url}`);
  assert.equal(ud.em, sha('jan.novak@example.com'));
  assert.equal(ud.ph, sha('421903123456'));
  assert.equal(ud.ct, sha('banskábystrica'));
  assert.equal(ud.external_id, undefined, 'the visitor id stays the only external_id');
  assert.ok(Object.values(ud).every((v) => /^[a-f0-9]{64}$/.test(v)), 'nothing in plaintext');
  const raw = storedCookie(res);
  assert.match(raw, /Max-Age=7776000/i, '90 days');
  assert.doesNotMatch(raw, /HttpOnly/i, 'px.js has to read it');
  assert.match(res.headers.get('cache-control') || '', /no-cache|no-store/, 'never page-cached');
});

test('a wrong order key or an old order stores nothing', async () => {
  const { received_url: url } = await fire('order_url');
  const forged = await fetch(url.replace(/key=[^&]+/, 'key=wc_order_forged'), { redirect: 'manual' });
  assert.equal(storedCookie(forged), undefined);

  const { received_url: old } = await fire('order_url_old');
  assert.equal(storedCookie(await fetch(old, { redirect: 'manual' })), undefined);
});

test('without marketing consent the thank-you page stores nothing', async () => {
  const { received_url: url } = await fire('order_url');
  await setConsent('cookiescript');
  try {
    const stats = await fetch(url, { redirect: 'manual', headers: { cookie: csCookie(['strict', 'performance']) } });
    assert.equal(storedCookie(stats), undefined);
    const undecided = await fetch(url, { redirect: 'manual' });
    assert.equal(storedCookie(undecided), undefined);
    const yes = await fetch(url, { redirect: 'manual', headers: { cookie: csCookie(['strict', 'targeting']) } });
    assert.ok(storedCookie(yes), 'stored once targeting is accepted');
  } finally {
    await setConsent('none');
  }
});

test('a login stores the account billing identity', async () => {
  const res = await fetch(`${BASE}/nwr-test/fire.php?event=login`);
  const ud = storedFrom(res);
  assert.ok(ud, 'cookie set on login');
  assert.equal(ud.em, sha('fakturacia@example.com'), 'billing email wins over the account email');
  assert.equal(ud.ph, sha('421903123456'), 'national number, shop country SK');
  assert.equal(ud.fn, sha('ján'));
});

test('phone numbers get the country code Meta matches them by', async () => {
  const cases = [
    ['0905 123 456', 'SK', '421905123456'],
    ['905123456', 'SK', '421905123456'],
    ['421905123456', 'SK', '421905123456'],
    ['+421 0905 123 456', 'SK', '421905123456'],
    ['00420 603 123 456', 'SK', '420603123456'],
    ['603 123 456', 'CZ', '420603123456'],
    ['06 30 123 4567', 'HU', '36301234567'],
    ['0905 123 456', null, '421905123456'],
  ];
  const got = await json(`/nwr-test/phones.php?cases=${encodeURIComponent(JSON.stringify(cases))}`);
  assert.deepEqual(got, cases.map((c) => c[2]), 'no country: the shop country (SK) is assumed');
});

test('a signed-in customer: server events add the billing phone and address', async () => {
  const { sent } = await fire('add_to_cart', '', '&as_user=1');
  const u = sent[0].body.user_data;
  assert.equal(u.em, sha('zakaznik@example.com'), 'the account e-mail wins');
  assert.equal(u.ph, sha('421903123456'));
  assert.equal(u.ct, sha('žilina'));
  assert.equal(u.zp, sha('01001'));
  assert.equal(u.external_id, sha(String(ids.user)));
});

test('a returning guest: server events carry the stored identity, only with marketing consent', async () => {
  const ud = JSON.stringify({ em: sha('stored@example.com'), ph: sha('421900000000'), junk: sha('x'), fn: 'plain' });
  const { sent } = await fire('add_to_cart', '', `&ud=${encodeURIComponent(ud)}`);
  const u = sent[0].body.user_data;
  assert.equal(u.em, sha('stored@example.com'));
  assert.equal(u.ph, sha('421900000000'));
  assert.equal(u.junk, undefined);
  assert.equal(u.fn, undefined, 'a non-hash value in the cookie is ignored');

  await setConsent('cookiescript');
  try {
    const { sent: stats } = await fire('add_to_cart', '', `&cs=performance&ud=${encodeURIComponent(ud)}`);
    assert.equal(stats[0].body.user_data.em, undefined);
  } finally {
    await setConsent('none');
  }
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

// ------------------------------------------------------------- plugin 1.0

test('events leave only after the page, not while it is being built', async () => {
  const { sent, purchase } = await fire('queued');
  assert.equal(purchase.before_flush, 0);
  assert.equal(sent.length, 1, 'delivered at the end of the request');
});

test('InitiateCheckout once per cart: reloading the checkout sends nothing new', async () => {
  const { sent, footer } = await fire('checkout_twice');
  assert.equal(sent.length, 1);
  assert.equal([...footer.matchAll(/"InitiateCheckout"/g)].length, 1);
});

test('an AJAX add to cart hands its id to the browser in the cart fragments', async () => {
  const { sent, purchase } = await fire('atc_ajax');
  assert.equal(sent.length, 1);
  assert.equal(typeof purchase.fragment, 'string', 'themes expect every fragment to be a string');
  const leg = JSON.parse(purchase.fragment);
  assert.equal(leg.event_id, sent[0].body.event_id, 'one id, so Meta counts one add to cart');
  assert.deepEqual(leg.data, sent[0].body.custom_data);
  assert.equal(purchase.pending, null, 'nothing left waiting for a next page');
});

test('a plain add-to-cart post shows the browser leg on the next page, which is not cached', async () => {
  const { sent, footer, purchase } = await fire('atc_form');
  const legs = [...footer.matchAll(/window\.nwr\("track","AddToCart",(.*?),\{eventID:(".*?")\}\);<\/script>/g)];
  assert.equal(legs.length, 1);
  assert.equal(JSON.parse(legs[0][2]), sent[0].body.event_id);
  assert.equal(purchase.nocache, true);
  assert.equal(purchase.left, null, 'shown once');
});

test('a gateway outage pauses sending, and the purchase is retried from the order', async () => {
  const { sent, purchase } = await fire('purchase_gateway_down');
  assert.equal(purchase.attempts, 1, 'after the first timeout the next event is not even tried');
  assert.equal(purchase.paused, true);
  assert.equal(purchase.sent, false, 'the order no longer claims it was sent');
  assert.equal(purchase.retry, 1);
  assert.equal(purchase.scheduled, true);
  assert.equal(purchase.status.failing, true);
  assert.match(purchase.status.error, /timed out/);
  assert.match(purchase.notes.join(' '), /skúsi sa znova o 2 min/);
  assert.equal(purchase.queued, 1, 'the AddToCart that met the outage waits in Action Scheduler');
  assert.deepEqual(sent.map((c) => c.body.event_name).sort(), ['AddToCart', 'Purchase'], 'the retries delivered both');
  assert.equal(sent.find((c) => c.body.event_name === 'Purchase').body.event_id, `ord-${purchase.order}`);
  assert.ok(sent.every((c) => c.signature_valid), 'signed afresh, so the gateway takes them');
  assert.equal(purchase.sent_after, true);
});

test('the settings page never prints the key, and takes a pairing code', async () => {
  const s = await json('/nwr-test/settings-page.php');
  assert.equal(s.key_in_page, false);
  assert.equal(s.has_pairing_input, true);
  assert.equal(s.has_test_button, true);
  assert.deepEqual(s.paired, { host: 't.novy-klient.sk', key: true });
  assert.equal(s.bad_pairing.key_kept, true);
  assert.match(s.bad_pairing.error, /Párovací kód/);
  assert.equal(s.blank_key_kept, true, 'an empty key field keeps the stored key');
  assert.equal(s.host_cleaned, 'collector.test');
  assert.equal(s.has_faz, true);
  assert.equal(s.faz_mode, 'faz');
  assert.equal(s.has_ga4_input, true);
  assert.equal(s.ga4_ok, 'G-ABC1234');
  assert.equal(s.ga4_bad, '', 'anything but a measurement id is dropped');
});

test('the visitor address comes from Cloudflare or a local proxy only', async () => {
  const r = await json('/nwr-test/misc.php');
  assert.equal(r.via_cloudflare, '2a02:ab88:1:2::3');
  assert.equal(r.forged_direct, '198.51.100.7', 'a header typed by the sender is ignored');
  assert.equal(r.local_proxy, '203.0.113.5');
  assert.equal(r.already_resolved, '203.0.113.8');
});

test('WooCommerce sees the plugin as compatible with HPOS and the block checkout', async () => {
  const r = await json('/nwr-test/misc.php');
  assert.deepEqual(r.compat, { custom_order_tables: true, cart_checkout_blocks: true });
});

test('an update installs only with a valid signature from the release key', async (t) => {
  const { readFileSync, existsSync } = await import('node:fs');
  const dir = new URL('../../releases/', import.meta.url);
  if (!existsSync(new URL('latest.json', dir))) return t.skip('no release built yet (scripts/release-plugin.mjs)');
  const latest = JSON.parse(readFileSync(new URL('latest.json', dir), 'utf8'));
  const zip = readFileSync(new URL(latest.file, dir));
  const res = await fetch(`${BASE}/nwr-test/release.php`, {
    method: 'POST',
    body: JSON.stringify({ zip: zip.toString('base64'), signature: latest.signature, sha256: latest.sha256, version: '9.9.9' }),
  });
  const r = JSON.parse(await res.text());
  assert.equal(r.valid, true);
  assert.equal(r.tampered, false);
  assert.equal(r.wrong_sha, false);
  assert.equal(r.garbage_sig, false);
  assert.equal(r.update.version, '9.9.9');
  assert.equal(r.update.package, 'https://collector.test/wp/nowera-capi/nowera-capi-9.9.9.zip');
  assert.equal(r.foreign, null, 'a package on another host is ignored');
  assert.equal(r.auto_off, false);
  assert.equal(r.auto_on, true);
  assert.equal(r.update_uri, 'https://signals.nwra.sk/wp/nowera-capi');
});

// ------------------------------------------------------------- plugin 1.0.1

test('a partial refund goes from the server with the refunded items, marked as never seen by a browser', async () => {
  const { sent, purchase } = await fire('refund_partial');
  const refunds = sent.filter((e) => e.body.event_name === 'Refund');
  assert.equal(refunds.length, 1);
  const b = refunds[0].body;
  assert.equal(b.browserless, true);
  assert.match(b.event_id, /^refund-\d+$/);
  assert.equal(b.custom_data.order_id, purchase.order, 'GA4 matches it to the purchase by this id');
  assert.equal(b.custom_data.contents.length, 1);
  assert.equal(b.custom_data.contents[0].quantity, 1);
  assert.ok(b.custom_data.value > 0 && b.custom_data.value < purchase.total);
  assert.equal(Object.keys(b.user_data).length, 0, 'no contact details: GA4 needs none');
  assert.equal(refunds[0].signature_valid, true);
});

test('a full refund reports the whole order', async () => {
  const { sent, purchase } = await fire('refund_full');
  const refunds = sent.filter((e) => e.body.event_name === 'Refund');
  assert.equal(refunds.length, 1);
  assert.equal(refunds[0].body.custom_data.value, purchase.total);
});

test('no refund for a buyer who allowed no statistics: GA4 never counted the purchase', async () => {
  await setConsent('cookiescript');
  try {
    const { sent } = await fireCs('refund_partial', 'targeting');
    assert.equal(sent.filter((e) => e.body.event_name === 'Refund').length, 0);
  } finally {
    await setConsent('none');
  }
});

test('only a purchase whose thank-you page never loaded is marked as browserless', async () => {
  const noReturn = await fire('paid_no_return', '_fbp:fb.1.1700000000000.1234567890');
  assert.equal(noReturn.sent[0].body.browserless, true, 'nothing in the browser reported it');
  const thankYou = await fire('purchase');
  assert.equal(thankYou.sent[0].body.browserless, undefined, 'the page loaded, its own tags reported it');
  const retried = await fire('purchase_gateway_down');
  assert.equal(retried.sent[0].body.browserless, undefined, 'a retry after the page loaded is not the only copy');
});

test('the GA4 session id is read from the current GS2 cookie as well', async () => {
  const gs2 = await fire('checkout', '_ga:GA1.1.123456789.1700000000,_ga_XYZ:GS2.1.s1759740000$o12$g1$t1759740300$j60$l0$h0');
  assert.equal(gs2.sent[0].body.ga_client_id, '123456789.1700000000');
  assert.equal(gs2.sent[0].body.ga_session_id, '1759740000');
  const gs1 = await fire('checkout', '_ga_XYZ:GS1.1.1700000500.4.1.1700000600.0.0.0');
  assert.equal(gs1.sent[0].body.ga_session_id, '1700000500');
});
