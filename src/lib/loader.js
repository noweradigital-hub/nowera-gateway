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

  // FAZ Cookie Manager calls statistics "analytics".
  var FAZ_CATEGORY = { marketing: 'marketing', statistics: 'analytics' };
  // Categories FAZ last announced as accepted. Its events carry the state itself.
  var fazAnnounced = null;

  // Accepted FAZ categories, or null while nothing is known yet. Only FAZ's own
  // state counts, and only once FAZ has started (window._fazConsentReady): until
  // then its cookie may still hold a decision FAZ is about to discard (an older
  // policy revision, another banner), so it is never read directly.
  function fazAccepted() {
    if (fazAnnounced) return fazAnnounced;
    var ready = w._fazConsentReady;
    if (!ready) return null;
    try {
      if (typeof w.getFazConsent === 'function') {
        var st = w.getFazConsent();
        var cats = st && st.categories;
        if (!st || !st.isUserActionCompleted || !cats) return null;
        return Object.keys(cats).filter(function (k) { return cats[k] === true; });
      }
    } catch (e) {}
    return ready.action !== 'init' && Object.prototype.toString.call(ready.accepted) === '[object Array]'
      ? ready.accepted : null;
  }

  function hasConsent(category) {
    if (!consentActive()) return true;

    if (CONSENT.mode === 'cookiescript') {
      return cookieScriptCategories().indexOf(CS_CATEGORY[category]) !== -1;
    }

    if (CONSENT.mode === 'faz') {
      var accepted = fazAccepted();
      return !!accepted && accepted.indexOf(FAZ_CATEGORY[category]) !== -1;
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
    if (CONSENT.mode === 'faz') {
      var accepted = fazAccepted();
      return !!accepted && accepted.indexOf(FAZ_CATEGORY.marketing) === -1;
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

  // ---- Google tag ----------------------------------------------------------

  // The site's Google tag (gtag config; the plugin publishes its id as
  // window.nwrGtag) loads only after statistics consent, so before that not a
  // single request goes to Google ("basic" consent mode). Its page_view starts
  // the session and writes _ga, which our GA4 events then join.
  var gtagStarted = false;
  var gtagConsentSent = null;

  function gtagCall() {
    if (typeof w.gtag === 'function') return w.gtag.apply(null, arguments);
    (w.dataLayer = w.dataLayer || []).push(arguments);
  }

  function googleConsent(c) {
    var ads = c.marketing ? 'granted' : 'denied';
    return {
      analytics_storage: c.statistics ? 'granted' : 'denied',
      ad_storage: ads, ad_user_data: ads, ad_personalization: ads
    };
  }

  // Consent tools announce one decision with several events; tell Google once.
  function tellGoogleConsent(c) {
    if (!consentActive()) return;
    var state = googleConsent(c);
    var key = JSON.stringify(state);
    if (key === gtagConsentSent) return;
    gtagConsentSent = key;
    gtagCall('consent', 'update', state);
  }

  function startGoogleTag() {
    var id = w.nwrGtag;
    if (typeof id !== 'string' || !/^G-[A-Z0-9]{4,20}$/.test(id)) return;
    var c = consentSnapshot();
    if (gtagStarted) {
      // A later change of mind reaches the running tag too.
      tellGoogleConsent(c);
      return;
    }
    if (!c.statistics) return;
    gtagStarted = true;
    tellGoogleConsent(c);
    gtagCall('js', new Date());
    gtagCall('config', id);
    if (!d.createElement) return;
    var tag = d.createElement('script');
    tag.async = true;
    tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + id;
    (d.head || d.getElementsByTagName('head')[0]).appendChild(tag);
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
    var raw = cookie('_ga_' + GA_STREAM);
    if (!raw) return null;
    // GS2.1.s<session>$o<count>$g…  (current) or GS1.1.<session>.<count>.…  (older)
    var gs2 = /^GS2\\.\\d+\\.(.*)$/.exec(raw);
    if (gs2) {
      var s = /(?:^|\\$)s(\\d+)/.exec(gs2[1]);
      return s ? s[1] : null;
    }
    var parts = raw.split('.');
    return parts.length >= 3 && /^\\d+$/.test(parts[2]) ? parts[2] : null;
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
  // force: something new was just stored and should not wait until tomorrow.
  var kept = false;
  function keepCookies(force) {
    if (!KEEP || !w.fetch || (kept && force !== true)) return;
    kept = true;
    try {
      var today = new Date().toISOString().slice(0, 10);
      if (force !== true && w.localStorage.getItem('nwr_kept') === today) return;
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

  // What the pixel gets: Meta's own fields, the way the gateway's Meta
  // destination sends them. GA4-only values (net revenue, tax, list names)
  // stay out of Meta.
  var GA_ONLY = { value_net: 1, tax: 1, shipping: 1, coupon: 1, payment_type: 1, item_list_name: 1 };
  function pixelProps(props) {
    if (!props || typeof props !== 'object') return props;
    var out = {};
    Object.keys(props).forEach(function (k) {
      if (!GA_ONLY[k]) out[k] = props[k];
    });
    if (Object.prototype.toString.call(out.contents) === '[object Array]') {
      out.contents = out.contents.map(function (c) {
        var m = { id: c.id, quantity: c.quantity === undefined ? 1 : c.quantity };
        if (c.item_price !== undefined) m.item_price = c.item_price;
        if (c.item_name) m.title = c.item_name;
        if (c.item_brand) m.brand = c.item_brand;
        if (c.item_category) m.category = c.item_category;
        return m;
      });
    }
    return out;
  }

  function send(ev) {
    var c = consentSnapshot();
    if (!c.marketing && !c.statistics) {
      pending.push(ev);
      return;
    }

    if (c.marketing && PIXEL_ID) {
      ensurePixel();
      try {
        w.fbq(META_STANDARD[ev.name] ? 'track' : 'trackCustom', ev.name, pixelProps(ev.props), { eventID: ev.id });
      } catch (e) {}
    }

    deliver(ev, c, false);
  }

  // A new visitor's Google tag writes _ga only once it runs, after the same
  // consent that released this event. Sent before that, GA4 would file the event
  // under a stranger, outside the visitor's session and the Ads click. So, when
  // the page has a Google tag (a dataLayer), wait briefly for its cookie. If it
  // never comes on this page, later events stop waiting.
  var GA_WAIT_MS = 2000;
  var GA_WAIT_STEP = 200;
  var gaGaveUp = false;
  var gaQueue = [];
  var gaWaited = 0;

  // Both cookies: _ga names the visitor, _ga_<stream> their current session.
  function gaReady() {
    return !!(gaClientId() && gaSessionId());
  }

  function gaWaitOver() {
    var queued = gaQueue;
    gaQueue = [];
    queued.forEach(function (ev) {
      // The visitor may have changed their mind while the event waited.
      var c = consentSnapshot();
      if (!c.marketing && !c.statistics) pending.push(ev);
      else deliver(ev, c, true);
    });
  }

  function gaPoll() {
    gaWaited += GA_WAIT_STEP;
    if (gaReady() || gaWaited >= GA_WAIT_MS) {
      if (!gaReady()) gaGaveUp = true;
      gaWaitOver();
    } else {
      setTimeout(gaPoll, GA_WAIT_STEP);
    }
  }

  // Leaving the page cancels timers: whatever still waits goes now.
  if (w.addEventListener) {
    w.addEventListener('pagehide', function () {
      gaGaveUp = true;
      gaWaitOver();
    });
  }

  function deliver(ev, c, now) {
    // Later events queue behind waiting ones, so the order stays as it happened.
    if (!now && (gaQueue.length || (c.statistics && GA_STREAM && w.dataLayer && !gaGaveUp && !gaReady()))) {
      gaQueue.push(ev);
      if (gaQueue.length === 1) { gaWaited = 0; setTimeout(gaPoll, GA_WAIT_STEP); }
      return;
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
    startGoogleTag();
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

  if (CONSENT.mode === 'faz') {
    // fazcookie_consent_ready comes on every page ("init" for a visitor who has
    // not decided, "restore" for one who has, "update" after a choice);
    // fazcookie_consent_update with every change. Both carry {accepted, rejected}.
    // FAZ's live state (getFazConsent) is read first; the event's own list is
    // only kept for a FAZ build without that function.
    var fazListen = function (e) {
      var detail = e && e.detail;
      if (typeof w.getFazConsent !== 'function' && detail &&
          Object.prototype.toString.call(detail.accepted) === '[object Array]') {
        // Before a decision FAZ only reports its defaults, which are not a refusal.
        if (detail.action === 'init') fazAnnounced = null;
        else if (detail.action) fazAnnounced = detail.accepted;
      }
      onConsentChange();
    };
    d.addEventListener('fazcookie_consent_ready', fazListen);
    d.addEventListener('fazcookie_consent_update', fazListen);
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

  // ---- identity from the site's own forms ------------------------------------

  // An email typed into a form on the site (newsletter, contact, checkout) is the
  // strongest match key there is. With marketing consent it is hashed here and
  // kept in _nwr_ud, the cookie the site itself writes after a purchase, so every
  // later event from this browser carries it. The address never leaves the page
  // unhashed. Forms or fields marked data-nwr-ignore are skipped.
  var EMAIL = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]{2,}$/;

  function ignored(el) {
    return !!(el && el.getAttribute && el.getAttribute('data-nwr-ignore') !== null);
  }

  function formEmail(form) {
    if (!form || !form.elements || ignored(form)) return null;
    for (var i = 0; i < form.elements.length; i++) {
      var f = form.elements[i];
      var type = String(f.type || '').toLowerCase();
      if (type === 'password' || type === 'hidden' || ignored(f)) continue;
      var hint = (type + ' ' + (f.name || '') + ' ' + (f.id || '') + ' ' +
        ((f.getAttribute && f.getAttribute('autocomplete')) || '')).toLowerCase();
      if (hint.indexOf('email') === -1 && hint.indexOf('e-mail') === -1) continue;
      var value = String(f.value || '').replace(/^\\s+|\\s+$/g, '').toLowerCase();
      if (EMAIL.test(value)) return value;
    }
    return null;
  }

  function rememberEmail(email) {
    if (!consentSnapshot().marketing) return;
    var em = sha256(email);
    var stored = null;
    try { stored = JSON.parse(cookie('_nwr_ud') || 'null'); } catch (e) {}
    if (stored && stored.em === em) return;
    // A different address is a different person: nothing stored for the previous
    // one (phone, name, city) may travel with it.
    writeCookie('_nwr_ud', JSON.stringify({ em: em }), ID_MAX_AGE);
    // Safari keeps a cookie written here for seven days; the site's keeper turns
    // it into a server cookie that lasts the full 90.
    keepCookies(true);
  }

  function onFormSubmit(e) {
    var el = e && e.target;
    var email = formEmail(el && (el.tagName === 'FORM' ? el : el.form));
    if (email) rememberEmail(email);
  }

  // Some forms never fire submit: a script takes the button's click and posts the
  // fields itself. Listening in the capture phase runs before that script.
  function onFormClick(e) {
    var el = e && e.target;
    var button = el && el.closest ? el.closest('button, input[type="submit"], input[type="image"]') : null;
    if (!button || !button.form) return;
    var type = String(button.type || '').toLowerCase();
    if (type === 'submit' || type === 'image') onFormSubmit({ target: button.form });
  }

  d.addEventListener('submit', onFormSubmit, true);
  d.addEventListener('click', onFormClick, true);

  // ---- add to cart in WooCommerce --------------------------------------------

  // An AJAX add to cart answers with cart fragments, and the WordPress plugin puts
  // the AddToCart it has just sent from the server into them (nwr_atc). Reported
  // from here under the same id, Meta counts one. Here rather than in the page, so
  // pages a site cached before the plugin knew it are covered as well.
  var cartHooked = false;
  function hookCart() {
    if (cartHooked || !w.jQuery || !d.body) return;
    cartHooked = true;
    w.jQuery(d.body).on('added_to_cart', function (e, fragments) {
      var raw = fragments && fragments.nwr_atc;
      if (!raw) return;
      try {
        var leg = JSON.parse(raw);
        if (leg && leg.event_id) track('AddToCart', leg.data || {}, { eventID: String(leg.event_id) });
      } catch (err) {}
    });
  }
  hookCart();
  if (!cartHooked) {
    d.addEventListener('DOMContentLoaded', hookCart);
    if (w.addEventListener) w.addEventListener('load', hookCart);
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
  startGoogleTag();
  track('PageView');

  if (PAGE && PAGE.type) {
    var pageEvents = { product: 'ViewContent', category: 'ViewCategory', search: 'Search' };
    if (pageEvents[PAGE.type]) track(pageEvents[PAGE.type], PAGE.data || {});
  }

  queued.forEach(function (args) { w.nwr.apply(null, args); });
})(window, document);
`;
}
