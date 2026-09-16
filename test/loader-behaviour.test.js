import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loaderScript } from '../src/lib/loader.js';

/**
 * Runs the real loader against a minimal fake browser and records what it does:
 * every POST to the gateway and every fbq() call. Asserting behaviour rather than
 * source text is what catches a broken dedupe or a consent leak.
 */
function browser({ cookie = '', page, user, consent, hasConsent, fbclid } = {}) {
  const posts = [];
  const fbq = [];
  const listeners = {};
  let counter = 0;

  const document = {
    cookie,
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
  };
  const window = {
    location: { href: 'https://klient.sk/produkt/x/' + (fbclid ? `?fbclid=${fbclid}` : ''), search: fbclid ? `?fbclid=${fbclid}` : '' },
    crypto: { randomUUID: () => `id-${++counter}` },
    fetch: (url, opts) => { posts.push({ url, body: JSON.parse(opts.body) }); return Promise.resolve(); },
    // A pre-existing fbq makes the loader skip injecting fbevents.js, so we can
    // record exactly which pixel calls it makes.
    fbq: (...args) => fbq.push(args),
    nwrPage: page,
    nwrUser: user,
    nwrConsent: consent,
  };
  if (hasConsent) window.cmplz_has_consent = hasConsent;

  const run = () => new Function('window', 'document', 'navigator',
    loaderScript({ endpoint: 'https://t.klient.sk/e', pixelId: 'PIX', measurementId: 'G-ABC' }),
  )(window, document, {});

  const fire = (name) => (listeners[name] || []).forEach((fn) => fn({ detail: {} }));
  return { window, document, posts, fbq, run, fire, listeners };
}

const tracked = (fbq) => fbq.filter((c) => c[0] === 'track' || c[0] === 'trackCustom');

test('without consent handling it fires PageView at once, on both legs, with one event id', () => {
  const b = browser();
  b.run();
  assert.equal(b.posts.length, 1);
  assert.equal(b.posts[0].body.event_name, 'PageView');
  assert.equal(b.posts[0].body.consent, undefined, 'no consent block when the site does not manage consent');

  assert.deepEqual(b.fbq[0], ['init', 'PIX']);
  const [pv] = tracked(b.fbq);
  assert.equal(pv[1], 'PageView');
  assert.equal(pv[3].eventID, b.posts[0].body.event_id, 'shared id is what lets Meta dedupe');
});

test('a product page also fires ViewContent with the published product data', () => {
  const data = { content_ids: ['42'], content_type: 'product', value: 19.9, currency: 'EUR' };
  const b = browser({ page: { type: 'product', data } });
  b.run();
  const vc = b.posts.find((p) => p.body.event_name === 'ViewContent');
  assert.ok(vc, 'ViewContent posted');
  assert.deepEqual(vc.body.custom_data, data);
  const pixel = tracked(b.fbq).find((c) => c[1] === 'ViewContent');
  assert.equal(pixel[0], 'track');
  assert.equal(pixel[3].eventID, vc.body.event_id);
});

test('each visitor gets a fresh event id even though the page came from cache', () => {
  const page = { type: 'product', data: { content_ids: ['42'] } };
  const a = browser({ page }); a.run();
  const b2 = browser({ page }); b2.window.crypto.randomUUID = () => 'other-visitor'; b2.run();
  const idA = a.posts.find((p) => p.body.event_name === 'ViewContent').body.event_id;
  const idB = b2.posts.find((p) => p.body.event_name === 'ViewContent').body.event_id;
  assert.notEqual(idA, idB);
});

test('category and search pages fire ViewCategory as a custom event and Search as a standard one', () => {
  const c = browser({ page: { type: 'category', data: { content_category: 'Osušky' } } });
  c.run();
  const vcat = tracked(c.fbq).find((x) => x[1] === 'ViewCategory');
  assert.equal(vcat[0], 'trackCustom', 'Meta only accepts standard names with track()');

  const s = browser({ page: { type: 'search', data: { search_string: 'osuska' } } });
  s.run();
  const search = tracked(s.fbq).find((x) => x[1] === 'Search');
  assert.equal(search[0], 'track');
  assert.equal(s.posts.find((p) => p.body.event_name === 'Search').body.custom_data.search_string, 'osuska');
});

test('under opt-in nothing is sent and the pixel is not started before the visitor decides', () => {
  const b = browser({ consent: { mode: 'complianz' }, page: { type: 'product', data: {} } });
  b.run();
  assert.equal(b.posts.length, 0, 'no request to the gateway');
  assert.equal(b.fbq.length, 0, 'pixel not even initialised');
  assert.ok(b.listeners.cmplz_fire_categories && b.listeners.cmplz_status_change);
});

test('accepting marketing later releases the waiting events with their original ids', () => {
  const b = browser({ consent: { mode: 'complianz' }, page: { type: 'product', data: {} } });
  b.run();
  b.document.cookie = 'cmplz_marketing=allow; cmplz_statistics=allow';
  b.fire('cmplz_fire_categories');

  assert.deepEqual(b.posts.map((p) => p.body.event_name), ['PageView', 'ViewContent']);
  assert.deepEqual(b.posts[0].body.consent, { marketing: true, statistics: true });
  assert.deepEqual(b.fbq[0], ['init', 'PIX']);
  assert.equal(tracked(b.fbq)[0][3].eventID, b.posts[0].body.event_id);

  b.fire('cmplz_status_change');
  assert.equal(b.posts.length, 2, 'a second consent event does not send them twice');
});

test('statistics-only consent reaches the gateway without any marketing identifier or pixel', () => {
  const b = browser({
    consent: { mode: 'complianz' },
    cookie: 'cmplz_statistics=allow; _fbp=fb.1.1.2; _fbc=fb.1.1.abc',
    fbclid: 'CLICK',
  });
  b.run();
  assert.equal(b.posts.length, 1);
  const body = b.posts[0].body;
  assert.deepEqual(body.consent, { marketing: false, statistics: true });
  assert.equal(body.fbp, undefined);
  assert.equal(body.fbc, undefined);
  assert.equal(body.fbclid, undefined);
  assert.equal(b.fbq.length, 0, 'no pixel without marketing consent');
});

test('Complianz own consent check wins over the cookie', () => {
  const b = browser({
    consent: { mode: 'complianz' },
    cookie: 'cmplz_marketing=allow',
    hasConsent: () => false, // e.g. consent revoked this page view
  });
  b.run();
  assert.equal(b.posts.length, 0);
});

test('a site with a different consent tool can release events with nwr("consent")', () => {
  const b = browser({ consent: { mode: 'custom', prefix: 'my_' } });
  b.run();
  assert.equal(b.posts.length, 0);
  b.document.cookie = 'my_marketing=allow';
  b.window.nwr('consent');
  assert.equal(b.posts.length, 1);
});

test('calls queued before the loader arrived are replayed', () => {
  const b = browser();
  b.window.nwr = Object.assign(() => {}, { q: [['track', 'Purchase', { value: 5 }, { eventID: 'ord-1' }]] });
  b.run();
  const purchase = b.posts.find((p) => p.body.event_name === 'Purchase');
  assert.equal(purchase.body.event_id, 'ord-1');
  assert.equal(tracked(b.fbq).find((c) => c[1] === 'Purchase')[3].eventID, 'ord-1');
});

test('page-published identity is merged into every event', () => {
  const b = browser({ user: { em: 'hash-of-email' } });
  b.run();
  assert.equal(b.posts[0].body.user_data.em, 'hash-of-email');
});
