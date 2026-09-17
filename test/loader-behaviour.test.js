import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loaderScript } from '../src/lib/loader.js';

const sha = (v) => createHash('sha256').update(v).digest('hex');

/**
 * document.cookie with browser semantics: each write sets one cookie, attributes
 * are not cookies, max-age=0 deletes. Several name=value pairs in one write are
 * accepted as a test shortcut.
 */
const ATTRIBUTES = new Set(['path', 'domain', 'max-age', 'expires', 'secure', 'samesite', 'httponly']);
function cookieJar(initial) {
  const jar = new Map();
  const writes = [];
  const parse = (text, record) => {
    const parts = String(text).split(';').map((x) => x.trim()).filter(Boolean);
    const attrs = {};
    const pairs = [];
    for (const part of parts) {
      const eq = part.indexOf('=');
      const name = (eq === -1 ? part : part.slice(0, eq)).trim();
      const value = eq === -1 ? '' : part.slice(eq + 1);
      if (ATTRIBUTES.has(name.toLowerCase())) attrs[name.toLowerCase()] = value;
      else pairs.push([name, value]);
    }
    for (const [name, value] of pairs) {
      if (record) writes.push({ name, value: decodeURIComponent(value), ...attrs });
      if (attrs['max-age'] === '0') jar.delete(name);
      else jar.set(name, value);
    }
  };
  if (initial) parse(initial, false);
  return {
    writes,
    get: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
    set: (text) => parse(text, true),
    value: (name) => (jar.has(name) ? decodeURIComponent(jar.get(name)) : undefined),
  };
}

/**
 * Runs the real loader against a minimal fake browser and records what it does:
 * every POST to the gateway and every fbq() call. Asserting behaviour rather than
 * source text is what catches a broken dedupe or a consent leak.
 */
function browser({ cookie = '', page, user, consent, hasConsent, fbclid, tenantConsent, cookieDomain, hostname = 'klient.sk' } = {}) {
  const posts = [];
  const fbq = [];
  const listeners = {};
  let counter = 0;
  const jar = cookieJar(cookie);

  const document = {
    get cookie() { return jar.get(); },
    set cookie(text) { jar.set(text); },
    addEventListener: (name, fn) => { (listeners[name] ||= []).push(fn); },
  };
  const window = {
    location: {
      href: `https://${hostname}/produkt/x/` + (fbclid ? `?fbclid=${fbclid}` : ''),
      search: fbclid ? `?fbclid=${fbclid}` : '',
      hostname,
      protocol: 'https:',
    },
    crypto: { randomUUID: () => `rnd-${String(++counter).padStart(6, '0')}` },
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
    loaderScript({ endpoint: 'https://t.klient.sk/e', pixelId: 'PIX', measurementId: 'G-ABC', consent: tenantConsent, cookieDomain }),
  )(window, document, {});

  const fire = (name, detail = {}) => (listeners[name] || []).forEach((fn) => fn({ detail }));
  return { window, document, posts, fbq, run, fire, listeners, jar };
}

const isInit = (call) => call[0] === 'init' && call[1] === 'PIX';

const tracked = (fbq) => fbq.filter((c) => c[0] === 'track' || c[0] === 'trackCustom');

test('without consent handling it fires PageView at once, on both legs, with one event id', () => {
  const b = browser();
  b.run();
  assert.equal(b.posts.length, 1);
  assert.equal(b.posts[0].body.event_name, 'PageView');
  assert.equal(b.posts[0].body.consent, undefined, 'no consent block when the site does not manage consent');

  assert.ok(isInit(b.fbq[0]), 'pixel initialised before its first event');
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
  assert.ok(isInit(b.fbq[0]));
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

// ------------------------------------------------------------ CookieScript

// Exactly how CookieScript stores its decision: JSON, with categories as a
// JSON string inside it, URL-encoded by js-cookie.
const csCookie = (categories, action = 'accept') =>
  'CookieScriptConsent=' + encodeURIComponent(JSON.stringify({
    action, categories: JSON.stringify(categories), key: 'k',
  }));

test('CookieScript: nothing is sent before the visitor decides', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, page: { type: 'product', data: {} } });
  b.run();
  assert.equal(b.posts.length, 0);
  assert.equal(b.fbq.length, 0);
  for (const e of ['CookieScriptAccept', 'CookieScriptAcceptAll', 'CookieScriptReject', 'CookieScriptCurrentState']) {
    assert.ok(b.listeners[e], `listens for ${e}`);
  }
});

test('CookieScript: a visitor who rejected earlier is never tracked', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: csCookie(['strict'], 'reject') });
  b.run();
  b.fire('CookieScriptLoaded');
  b.fire('CookieScriptCurrentState', { action: 'reject', categories: ['strict'] });
  assert.equal(b.posts.length, 0);
  assert.equal(b.fbq.length, 0, 'no pixel for a rejected visitor');
});

test('CookieScript: a returning visitor who accepted is tracked from the cookie alone', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: csCookie(['strict', 'targeting', 'performance']) });
  b.run();
  assert.equal(b.posts.length, 1);
  assert.deepEqual(b.posts[0].body.consent, { marketing: true, statistics: true });
  assert.ok(isInit(b.fbq[0]));
});

test('CookieScript: its live state wins over a stale cookie', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: csCookie(['strict', 'targeting']) });
  b.window.CookieScript = { instance: { currentState: () => ({ action: 'reject', categories: ['strict'] }) } };
  b.run();
  assert.equal(b.posts.length, 0);
});

test('CookieScript: accepting in the banner releases waiting events at once', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, page: { type: 'product', data: {} } });
  b.run();
  assert.equal(b.posts.length, 0);
  // The event carries the choice even if the cookie has not been written yet.
  b.fire('CookieScriptAccept', { categories: ['strict', 'targeting'] });
  assert.deepEqual(b.posts.map((p) => p.body.event_name), ['PageView', 'ViewContent']);
  assert.deepEqual(b.posts[0].body.consent, { marketing: true, statistics: false });
  assert.equal(tracked(b.fbq)[0][3].eventID, b.posts[0].body.event_id);
});

test('CookieScript: accept-all releases events for every destination', () => {
  const b = browser({ consent: { mode: 'cookiescript' } });
  b.run();
  b.fire('CookieScriptAcceptAll');
  assert.equal(b.posts.length, 1);
  assert.deepEqual(b.posts[0].body.consent, { marketing: true, statistics: true });
});

test('CookieScript: statistics only sends no pixel and no marketing identifiers', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: '_fbp=fb.1.1.2' });
  b.run();
  b.fire('CookieScriptAccept', { categories: ['strict', 'performance'] });
  assert.equal(b.posts.length, 1);
  assert.deepEqual(b.posts[0].body.consent, { marketing: false, statistics: true });
  assert.equal(b.posts[0].body.fbp, undefined);
  assert.equal(b.fbq.length, 0);
});

test('CookieScript: rejecting in the banner drops the waiting events', () => {
  const b = browser({ consent: { mode: 'cookiescript' } });
  b.run();
  b.fire('CookieScriptReject');
  b.fire('CookieScriptCurrentState', { action: 'reject', categories: ['strict'] });
  assert.equal(b.posts.length, 0);
});

test('CookieScript: a garbled cookie counts as no consent, not as an error', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: 'CookieScriptConsent=%7Bnot-json' });
  assert.doesNotThrow(() => b.run());
  assert.equal(b.posts.length, 0);
});

// --------------------------------------------- consent set on the gateway

test('a page served from cache is still gated when the gateway knows the consent tool', () => {
  // The cached HTML predates the consent setting, so it carries no nwrConsent.
  const b = browser({
    tenantConsent: { mode: 'cookiescript', prefix: 'cmplz_' },
    cookie: 'CookieScriptConsent=' + encodeURIComponent(JSON.stringify({ action: 'reject', categories: '["strict"]' })),
    page: { type: 'product', data: {} },
  });
  b.run();
  assert.equal(b.posts.length, 0, 'a rejected visitor on a cached page is not tracked');
  assert.equal(b.fbq.length, 0);
});

test('the gateway setting wins over whatever an old cached page says', () => {
  const b = browser({
    tenantConsent: { mode: 'cookiescript', prefix: 'cmplz_' },
    consent: { mode: 'custom', prefix: 'stale_' },
    cookie: 'stale_marketing=allow',
  });
  b.run();
  assert.equal(b.posts.length, 0, 'the stale page mode must not unlock tracking');
});

test('without a gateway setting the page value is used as before', () => {
  const b = browser({ tenantConsent: { mode: 'none' }, consent: { mode: 'complianz' } });
  b.run();
  assert.equal(b.posts.length, 0, 'page asked for Complianz, nobody consented');
});

test('with neither setting nothing is gated', () => {
  const b = browser({ tenantConsent: { mode: 'none' } });
  b.run();
  assert.equal(b.posts.length, 1);
});

// ------------------------------------------- external_id and stored identity

const HASH = (c) => c.repeat(64);

test('a first visit creates the visitor id and both legs carry the same one', () => {
  const b = browser({ page: { type: 'product', data: {} }, cookieDomain: '.klient.sk' });
  b.run();
  const vid = b.jar.value('_nwr_id');
  assert.match(vid, /^rnd-/);
  const write = b.jar.writes.find((w) => w.name === '_nwr_id');
  assert.equal(write.domain, '.klient.sk', 'written where the gateway and the site both read it');
  assert.equal(write['max-age'], String(90 * 86400));

  assert.deepEqual(b.fbq[0][2], { external_id: sha(vid) }, 'pixel gets the hashed id the gateway will hash too');
  assert.deepEqual(b.posts.map((p) => p.body.visitor_id), [vid, vid]);
  assert.equal(b.jar.writes.filter((w) => w.name === '_nwr_id').length, 1, 'created once per page');
});

test('an existing visitor id is reused, not rewritten', () => {
  const b = browser({ cookie: '_nwr_id=9b1b2f0e-4c1d-4a57-9d0e-0b5a3c1f8e21' });
  b.run();
  assert.equal(b.posts[0].body.visitor_id, '9b1b2f0e-4c1d-4a57-9d0e-0b5a3c1f8e21');
  assert.equal(b.fbq[0][2].external_id, sha('9b1b2f0e-4c1d-4a57-9d0e-0b5a3c1f8e21'));
  assert.equal(b.jar.writes.length, 0);
});

test('a malformed visitor id is replaced', () => {
  const b = browser({ cookie: '_nwr_id=%3Cscript%3E' });
  b.run();
  assert.match(b.posts[0].body.visitor_id, /^rnd-/);
});

test('the cookie domain is only used on pages under it', () => {
  const b = browser({ cookieDomain: '.klient.sk', hostname: 'klient-staging.example' });
  b.run();
  const write = b.jar.writes.find((w) => w.name === '_nwr_id');
  assert.equal(write.domain, undefined, 'a foreign domain would make the browser drop the cookie');
});

test('stored hashed contact details reach the pixel and the gateway', () => {
  const stored = encodeURIComponent(JSON.stringify({
    em: HASH('a'), ph: HASH('b'), country: HASH('c'),
    fn: 'plaintext-is-ignored', external_id: HASH('d'), junk: HASH('e'),
  }));
  const b = browser({ cookie: `_nwr_id=visitor-0001; _nwr_ud=${stored}` });
  b.run();
  assert.deepEqual(b.fbq[0][2], {
    em: HASH('a'), ph: HASH('b'), country: HASH('c'), external_id: sha('visitor-0001'),
  });
  assert.deepEqual(b.posts[0].body.user_data, { em: HASH('a'), ph: HASH('b'), country: HASH('c') });
});

test('a garbled stored identity is ignored', () => {
  const b = browser({ cookie: '_nwr_ud=%7Bnope' });
  assert.doesNotThrow(() => b.run());
  assert.deepEqual(Object.keys(b.fbq[0][2]), ['external_id']);
});

test('a signed-in visitor: the page identity wins over the stored one', () => {
  const stored = encodeURIComponent(JSON.stringify({ em: HASH('a'), ph: HASH('b') }));
  const b = browser({ cookie: `_nwr_ud=${stored}`, user: { em: HASH('f'), external_id: HASH('1') } });
  b.run();
  assert.deepEqual(b.fbq[0][2], { em: HASH('f'), ph: HASH('b'), external_id: HASH('1') });
  assert.equal(b.posts[0].body.user_data.em, HASH('f'));
  assert.equal(b.posts[0].body.user_data.external_id, HASH('1'));
});

test('statistics-only consent sends no visitor id and no contact details', () => {
  const stored = encodeURIComponent(JSON.stringify({ em: HASH('a'), country: HASH('c') }));
  const b = browser({
    consent: { mode: 'complianz' },
    cookie: `cmplz_statistics=allow; _nwr_ud=${stored}`,
    user: { em: HASH('f'), external_id: HASH('1') },
  });
  b.run();
  assert.equal(b.posts.length, 1);
  assert.equal(b.posts[0].body.visitor_id, undefined);
  assert.deepEqual(b.posts[0].body.user_data, { country: HASH('c') });
  assert.equal(b.jar.writes.length, 0, 'no identifier is created without marketing consent');
});

test('CookieScript: refusing marketing removes the stored identifiers', () => {
  const stored = encodeURIComponent(JSON.stringify({ em: HASH('a') }));
  const b = browser({
    consent: { mode: 'cookiescript' },
    cookieDomain: '.klient.sk',
    cookie: `${csCookie(['strict', 'targeting'])}; _nwr_id=visitor-0001; _nwr_ud=${stored}`,
  });
  b.run();
  assert.ok(b.jar.value('_nwr_ud'), 'kept while marketing is allowed');
  assert.ok(b.jar.value('_nwr_id'), 'kept while marketing is allowed');

  b.fire('CookieScriptAccept', { categories: ['strict', 'performance'] });
  assert.equal(b.jar.value('_nwr_ud'), undefined);
  assert.equal(b.jar.value('_nwr_id'), undefined);
  const drops = b.jar.writes.filter((w) => w['max-age'] === '0').map((w) => `${w.name}@${w.domain || 'host'}`);
  assert.deepEqual(drops.sort(), ['_nwr_id@.klient.sk', '_nwr_id@host', '_nwr_ud@.klient.sk', '_nwr_ud@host']);
});

test('CookieScript: a returning visitor who refused earlier loses leftovers on the next page', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: `${csCookie(['strict'], 'reject')}; _nwr_ud=x; _nwr_id=visitor-0001` });
  b.run();
  assert.equal(b.jar.value('_nwr_ud'), undefined);
  assert.equal(b.jar.value('_nwr_id'), undefined);
  assert.equal(b.posts.length, 0);
});

test('no decision yet is not a refusal', () => {
  const b = browser({ consent: { mode: 'cookiescript' }, cookie: '_nwr_ud=x; _nwr_id=visitor-0001' });
  b.run();
  assert.equal(b.jar.value('_nwr_ud'), 'x');
  assert.equal(b.jar.value('_nwr_id'), 'visitor-0001');
});

test('Complianz: a deny cookie removes the stored identifiers', () => {
  const b = browser({ consent: { mode: 'complianz' }, cookie: 'cmplz_marketing=deny; _nwr_ud=x' });
  b.run();
  assert.equal(b.jar.value('_nwr_ud'), undefined);
});
