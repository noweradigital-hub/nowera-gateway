/**
 * First-party loader served at https://<collector_host>/px.js
 *
 * It bootstraps the Meta pixel (so the browser leg still runs) and mirrors every
 * event to the gateway with the SAME event_id, which is what lets Meta dedupe the
 * two legs into one conversion instead of counting it twice.
 *
 * Page-level events (ViewContent, ViewCategory, Search) are fired from here
 * rather than by the site's PHP, because shop pages are served from a full-page
 * cache: PHP either would not run at all or would bake one event_id into the
 * cached HTML and collapse every visitor's view into a single event.
 */
export function loaderScript({ endpoint, pixelId, measurementId, consent, cookieDomain, keepPath }) {
  return `(function (w, d) {
  'use strict';
  if (w.nwr && w.nwr.loaded) return;

  var ENDPOINT = ${JSON.stringify(endpoint)};
  var PIXEL_ID = ${JSON.stringify(pixelId)};
  // Where the gateway writes its own cookies, so both sides share one visitor id.
  var COOKIE_DOMAIN = ${JSON.stringify(cookieDomain || null)};
  var ID_MAX_AGE = 90 * 86400;
  // Stream id half of the GA4 measurement id, which names the session cookie.
  var GA_STREAM = ${JSON.stringify(measurementId ? String(measurementId).replace(/^G-/, '') : null)};
  // A page can publish already-hashed identifiers for a signed-in visitor, which
  // lifts Meta's Event Match Quality on the browser leg from four weak signals to
  // a real match. Plaintext never has to leave the site.
  var DEFAULT_USER = w.nwrUser || {};
  // Cache-safe description of what this page is (product, category, search).
  var PAGE = w.nwrPage || null;
  // The site's own endpoint that re-sets our identifiers from its server —
  // Safari keeps those 90 days, but only 7 when JavaScript or a tracking
  // subdomain on another server wrote them. Published by the nowera-capi plugin.
  // The gateway's copy covers pages cached before the site began publishing it
  // (some sites keep a page cached for a year).
  var TENANT_KEEP = ${JSON.stringify(keepPath || null)};
  var KEEP = typeof w.nwrKeep === 'string' ? w.nwrKeep
    : (TENANT_KEEP && w.location.origin ? w.location.origin + TENANT_KEEP : null);
  // How the site asks for consent. The gateway's own setting for this tenant
  // wins, because it arrives with this script and so also covers pages the site
  // served from its page cache, which carry whatever was true when cached. The
  // page's value is only used when the gateway has none configured.
  var TENANT_CONSENT = ${JSON.stringify(consent || { mode: 'none' })};
  var CONSENT = (TENANT_CONSENT && TENANT_CONSENT.mode && TENANT_CONSENT.mode !== 'none')
    ? TENANT_CONSENT
    : (w.nwrConsent || { mode: 'none' });

  var META_STANDARD = {
    AddPaymentInfo: 1, AddToCart: 1, AddToWishlist: 1, CompleteRegistration: 1,
    Contact: 1, CustomizeProduct: 1, Donate: 1, FindLocation: 1, InitiateCheckout: 1,
    Lead: 1, PageView: 1, Purchase: 1, Schedule: 1, Search: 1, StartTrial: 1,
    SubmitApplication: 1, Subscribe: 1, ViewContent: 1
  };

  function uuid() {
    if (w.crypto && w.crypto.randomUUID) return w.crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
      var r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function cookie(name) {
    var m = d.cookie.match('(^|;)\\\\s*' + name + '\\\\s*=\\\\s*([^;]+)');
    return m ? decodeURIComponent(m.pop()) : null;
  }

  // The configured domain only applies when this page is actually under it;
  // otherwise the browser would silently drop the cookie.
  function cookieDomain() {
    if (!COOKIE_DOMAIN) return null;
    var bare = String(COOKIE_DOMAIN).replace(/^\\./, '');
    var host = String(w.location.hostname || '');
    return host === bare || host.slice(-bare.length - 1) === '.' + bare ? COOKIE_DOMAIN : null;
  }

  function writeCookie(name, value, maxAge, domain) {
    var c = name + '=' + encodeURIComponent(value) + '; path=/; max-age=' + maxAge + '; samesite=lax';
    if (domain) c += '; domain=' + domain;
    if (w.location.protocol === 'https:') c += '; secure';
    d.cookie = c;
  }

  function dropCookie(name) {
    writeCookie(name, '', 0);
    var domain = cookieDomain();
    if (domain) writeCookie(name, '', 0, domain);
  }

  // Synchronous SHA-256. The pixel needs the hashed visitor id before its first
  // event, and crypto.subtle only offers an async digest.
  var SHA_K = [];
  var SHA_H = [];
  (function () {
    var frac = function (x) { return ((x - Math.floor(x)) * 4294967296) >>> 0; };
    for (var n = 2, found = 0; found < 64; n++) {
      var prime = true;
      for (var f = 2; f * f <= n; f++) if (n % f === 0) { prime = false; break; }
      if (!prime) continue;
      if (found < 8) SHA_H[found] = frac(Math.sqrt(n));
      SHA_K[found] = frac(Math.cbrt ? Math.cbrt(n) : Math.pow(n, 1 / 3));
      found++;
    }
  })();

  function sha256(text) {
    var bytes = unescape(encodeURIComponent(String(text)));
    var bitLength = bytes.length * 8;
    bytes += '\\x80';
    while (bytes.length % 64 !== 56) bytes += '\\x00';
    var words = [];
    var i;
    for (i = 0; i < bytes.length; i++) words[i >> 2] |= bytes.charCodeAt(i) << (24 - (i % 4) * 8);
    words.push(Math.floor(bitLength / 4294967296) | 0, bitLength | 0);

    var H = SHA_H.slice();
    var W = [];
    for (var off = 0; off < words.length; off += 16) {
      var A = H[0], B = H[1], C = H[2], D = H[3], E = H[4], F = H[5], G = H[6], X = H[7];
      for (i = 0; i < 64; i++) {
        if (i < 16) {
          W[i] = words[off + i] | 0;
        } else {
          var p = W[i - 15];
          var q = W[i - 2];
          W[i] = (W[i - 16]
            + (((p >>> 7) | (p << 25)) ^ ((p >>> 18) | (p << 14)) ^ (p >>> 3))
            + W[i - 7]
            + (((q >>> 17) | (q << 15)) ^ ((q >>> 19) | (q << 13)) ^ (q >>> 10))) | 0;
        }
        var t1 = (X
          + (((E >>> 6) | (E << 26)) ^ ((E >>> 11) | (E << 21)) ^ ((E >>> 25) | (E << 7)))
          + ((E & F) ^ (~E & G))
          + SHA_K[i] + W[i]) | 0;
        var t2 = ((((A >>> 2) | (A << 30)) ^ ((A >>> 13) | (A << 19)) ^ ((A >>> 22) | (A << 10)))
          + ((A & B) ^ (A & C) ^ (B & C))) | 0;
        X = G; G = F; F = E; E = (D + t1) | 0; D = C; C = B; B = A; A = (t1 + t2) | 0;
      }
      H[0] = (H[0] + A) | 0; H[1] = (H[1] + B) | 0; H[2] = (H[2] + C) | 0; H[3] = (H[3] + D) | 0;
      H[4] = (H[4] + E) | 0; H[5] = (H[5] + F) | 0; H[6] = (H[6] + G) | 0; H[7] = (H[7] + X) | 0;
    }
    var hex = '';
    for (i = 0; i < 8; i++) hex += ('00000000' + (H[i] >>> 0).toString(16)).slice(-8);
    return hex;
  }

  // ---- consent -----------------------------------------------------------

  function consentActive() {
    return CONSENT && CONSENT.mode && CONSENT.mode !== 'none';
  }

  // CookieScript names its categories differently.
  var CS_CATEGORY = { marketing: 'targeting', statistics: 'performance' };
  var CS_ALL = ['strict', 'targeting', 'performance', 'functionality', 'unclassified'];
  // Latest state CookieScript announced. Its events carry the decision itself,
  // which is safer than re-reading a cookie that may not be written yet.
  var csAnnounced = null;

  function cookieScriptCategories() {
    if (csAnnounced) return csAnnounced;
    try {
      var cs = w.CookieScript && w.CookieScript.instance;
      if (cs && typeof cs.currentState === 'function') {
        var st = cs.currentState();
        if (st && st.categories && st.categories.length) return st.categories;
      }
    } catch (e) {}
    // It may load after us; on a returning visit its cookie already says.
    // The cookie is JSON whose "categories" field is itself a JSON string.
    var raw = cookie('CookieScriptConsent');
    if (!raw) return [];
    try {
      var data = JSON.parse(raw);
      var cats = typeof data.categories === 'string' ? JSON.parse(data.categories) : data.categories;
      return Object.prototype.toString.call(cats) === '[object Array]' ? cats : [];
    } catch (e) {
      return [];
    }
  }

  function hasConsent(category) {
    if (!consentActive()) return true;

    if (CONSENT.mode === 'cookiescript') {
      return cookieScriptCategories().indexOf(CS_CATEGORY[category]) !== -1;
    }

    if (CONSENT.mode === 'complianz') {
      // Complianz's own check knows about opt-out regions, Do Not Track and bots.
      if (typeof w.cmplz_has_consent === 'function') {
        try { return !!w.cmplz_has_consent(category); } catch (e) {}
      }
    }
    // Complianz may load after us, and any other tool is read by its cookie prefix.
    return cookie((CONSENT.prefix || 'cmplz_') + category) === 'allow';
  }

  function consentSnapshot() {
    return { marketing: hasConsent('marketing'), statistics: hasConsent('statistics') };
  }

  // An explicit "no" to marketing, as opposed to no decision yet.
  function marketingRefused() {
    if (!consentActive()) return false;
    if (CONSENT.mode === 'cookiescript') {
      var cats = cookieScriptCategories();
      return cats.length > 0 && cats.indexOf(CS_CATEGORY.marketing) === -1;
    }
    return cookie((CONSENT.prefix || 'cmplz_') + 'marketing') === 'deny';
  }

  // Withdrawn consent also removes the identifiers we stored for advertising.
  function forgetIfRefused() {
    if (!marketingRefused()) return;
    visitor = null;
    if (cookie('_nwr_ud') !== null) dropCookie('_nwr_ud');
    if (cookie('_nwr_id') !== null) dropCookie('_nwr_id');
  }

  // ---- identity ----------------------------------------------------------

  // GA4 attributes a Measurement Protocol hit to a Google Ads click only when it
  // lands in the browser's existing session, so both ids have to travel with it.
  function gaClientId() {
    var raw = cookie('_ga');            // GA1.1.<client>.<timestamp>
    if (!raw) return null;
    var parts = raw.split('.');
    return parts.length >= 4 ? parts.slice(-2).join('.') : null;
  }

  function gaSessionId() {
    if (!GA_STREAM) return null;
    var raw = cookie('_ga_' + GA_STREAM); // GS1.1.<session>.<count>....
    if (!raw) return null;
    var parts = raw.split('.');
    return parts.length >= 3 ? parts[2] : null;
  }

  function merge(base, extra) {
    var out = {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in extra) if (Object.prototype.hasOwnProperty.call(extra, k)) out[k] = extra[k];
    return out;
  }

  // One id per browser, shared by the pixel, the gateway and the site's own
  // server events. Created here when missing, so even the very first page view
  // carries the same external_id on both legs.
  var VALID_ID = /^[A-Za-z0-9_-]{8,64}$/;
  var visitor = null;
  function visitorId() {
    if (visitor) return visitor;
    var existing = cookie('_nwr_id');
    visitor = existing && VALID_ID.test(existing) ? existing : uuid();
    if (visitor !== existing) writeCookie('_nwr_id', visitor, ID_MAX_AGE, cookieDomain());
    return visitor;
  }

  var MATCH_KEYS = ['em', 'ph', 'fn', 'ln', 'ge', 'db', 'ct', 'st', 'zp', 'country', 'external_id'];
  var HASHED = /^[a-f0-9]{64}$/i;

  function hashedOnly(data, skip) {
    var out = {};
    for (var i = 0; i < MATCH_KEYS.length; i++) {
      var k = MATCH_KEYS[i];
      if (k !== skip && typeof data[k] === 'string' && HASHED.test(data[k])) out[k] = data[k].toLowerCase();
    }
    return out;
  }

  // Hashed contact details the site stored after a purchase or a login, so a
  // returning customer is recognised on every later page, cached ones included.
  function storedUser() {
    var raw = cookie('_nwr_ud');
    if (!raw) return {};
    try {
      var data = JSON.parse(raw);
      return data && typeof data === 'object' ? hashedOnly(data, 'external_id') : {};
    } catch (e) {
      return {};
    }
  }

  // What the page says about a signed-in visitor beats what was stored earlier.
  function identity(extra) {
    return merge(merge(storedUser(), DEFAULT_USER), extra || {});
  }

  function pixelMatching() {
    var m = hashedOnly(identity());
    // Same normalisation as the gateway applies to external_id: trim, then hash.
    if (!m.external_id) m.external_id = sha256(String(visitorId()).replace(/^\\s+|\\s+$/g, ''));
    return m;
  }

  // ---- transport ---------------------------------------------------------

  function post(body, then) {
    var payload = JSON.stringify(body);
    // keepalive lets a Purchase survive the navigation away from the checkout page.
    if (w.fetch) {
      w.fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        credentials: 'include',
        keepalive: true,
        mode: 'cors'
      }).then(function () { if (then) then(); }).catch(function () {});
    } else if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    }
  }

  // Once a day, after the gateway answered (it may have just created _fbp or
  // _fbc), ask the site to write the identifiers again from its own server.
  var kept = false;
  function keepCookies() {
    if (!KEEP || kept || !w.fetch) return;
    kept = true;
    try {
      var today = new Date().toISOString().slice(0, 10);
      if (w.localStorage.getItem('nwr_kept') === today) return;
      w.localStorage.setItem('nwr_kept', today);
    } catch (e) { /* no storage: once per page view is still cheap */ }
    try {
      w.fetch(KEEP, { credentials: 'same-origin', cache: 'no-store', keepalive: true }).catch(function () {});
    } catch (e) {}
  }

  var pixelReady = false;
  function ensurePixel() {
    if (pixelReady || !PIXEL_ID) return;
    pixelReady = true;
    if (!w.fbq) {
      // Standard Meta pixel bootstrap, kept verbatim so future pixel updates stay drop-in.
      !function (f, b, e, v, n, t, s) {
        if (f.fbq) return; n = f.fbq = function () {
          n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments);
        };
        if (!f._fbq) f._fbq = n;
        n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = [];
        t = b.createElement(e); t.async = !0; t.src = v;
        s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
      }(w, d, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
    }
    // Advanced matching: only hashed values, identical to what the server leg sends.
    w.fbq('init', PIXEL_ID, pixelMatching());
  }

  // ---- tracking ----------------------------------------------------------

  // Events wait here while the visitor has not decided. Under opt-in nothing is
  // sent and nothing is stored until they do.
  var pending = [];

  function send(ev) {
    var c = consentSnapshot();
    if (!c.marketing && !c.statistics) {
      pending.push(ev);
      return;
    }

    if (c.marketing && PIXEL_ID) {
      ensurePixel();
      try {
        w.fbq(META_STANDARD[ev.name] ? 'track' : 'trackCustom', ev.name, ev.props, { eventID: ev.id });
      } catch (e) {}
    }

    var body = {
      event_name: ev.name,
      event_id: ev.id,
      event_time: ev.time,
      // Lets the gateway put this event on its own clock, whatever this device thinks the time is.
      sent_at: Math.floor(Date.now() / 1000),
      event_source_url: ev.url,
      // The page's own referrer; the gateway keeps only its origin and path.
      referrer_url: d.referrer || undefined,
      custom_data: ev.props,
      // Contact details are for advertising; without that consent only the
      // country may travel, as on the site's own server events.
      user_data: c.marketing ? identity(ev.user) : countryOnly(identity(ev.user)),
      ga_client_id: gaClientId(),
      ga_session_id: gaSessionId()
    };
    // Marketing identifiers only travel when marketing is allowed.
    if (c.marketing) {
      body.visitor_id = visitorId();
      body.fbp = cookie('_fbp');
      body.fbc = cookie('_fbc');
      body.fbclid = new URLSearchParams(w.location.search).get('fbclid');
    }
    if (consentActive()) body.consent = c;
    // Refreshing identifiers is a marketing use, like the identifiers themselves.
    post(body, c.marketing ? keepCookies : null);
  }

  function countryOnly(user) {
    return user.country ? { country: user.country } : {};
  }

  function onConsentChange() {
    forgetIfRefused();
    flush();
  }

  function flush() {
    if (!pending.length) return;
    var c = consentSnapshot();
    if (!c.marketing && !c.statistics) return;
    var waiting = pending;
    pending = [];
    waiting.forEach(send);
  }

  function track(name, props, opts) {
    opts = opts || {};
    var ev = {
      name: name,
      id: opts.eventID || uuid(),
      time: Math.floor(Date.now() / 1000),
      url: w.location.href,
      props: props || {},
      user: opts.user || {}
    };
    send(ev);
    return ev.id;
  }

  if (CONSENT.mode === 'complianz') {
    // Complianz announces both the initial state and every later change.
    d.addEventListener('cmplz_fire_categories', onConsentChange);
    d.addEventListener('cmplz_status_change', onConsentChange);
  }

  if (CONSENT.mode === 'cookiescript') {
    var remember = function (cats) {
      return function (e) {
        var announced = typeof cats === 'function' ? cats(e) : cats;
        if (announced) csAnnounced = announced;
        onConsentChange();
      };
    };
    var detailCategories = function (e) {
      var c = e && e.detail && e.detail.categories;
      return Object.prototype.toString.call(c) === '[object Array]' ? c : null;
    };
    d.addEventListener('CookieScriptAccept', remember(detailCategories));
    d.addEventListener('CookieScriptAcceptAll', remember(CS_ALL));
    d.addEventListener('CookieScriptReject', remember(['strict']));
    d.addEventListener('CookieScriptCurrentState', remember(detailCategories));
    d.addEventListener('CookieScriptLoaded', remember(null));
  }

  var queued = (w.nwr && w.nwr.q) || [];
  w.nwr = function (cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (cmd === 'track') return track.apply(null, args);
    if (cmd === 'id') return uuid();
    // Any other consent tool can call nwr('consent') after the visitor decides.
    if (cmd === 'consent') return onConsentChange();
  };
  w.nwr.loaded = true;

  forgetIfRefused();
  track('PageView');

  if (PAGE && PAGE.type) {
    var pageEvents = { product: 'ViewContent', category: 'ViewCategory', search: 'Search' };
    if (pageEvents[PAGE.type]) track(pageEvents[PAGE.type], PAGE.data || {});
  }

  queued.forEach(function (args) { w.nwr.apply(null, args); });
})(window, document);
`;
}
