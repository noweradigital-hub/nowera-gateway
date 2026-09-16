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
export function loaderScript({ endpoint, pixelId, measurementId, consent }) {
  return `(function (w, d) {
  'use strict';
  if (w.nwr && w.nwr.loaded) return;

  var ENDPOINT = ${JSON.stringify(endpoint)};
  var PIXEL_ID = ${JSON.stringify(pixelId)};
  // Stream id half of the GA4 measurement id, which names the session cookie.
  var GA_STREAM = ${JSON.stringify(measurementId ? String(measurementId).replace(/^G-/, '') : null)};
  // A page can publish already-hashed identifiers for a signed-in visitor, which
  // lifts Meta's Event Match Quality on the browser leg from four weak signals to
  // a real match. Plaintext never has to leave the site.
  var DEFAULT_USER = w.nwrUser || {};
  // Cache-safe description of what this page is (product, category, search).
  var PAGE = w.nwrPage || null;
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

  // ---- transport ---------------------------------------------------------

  function post(body) {
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
      }).catch(function () {});
    } else if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    }
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
    w.fbq('init', PIXEL_ID);
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
      event_source_url: ev.url,
      custom_data: ev.props,
      user_data: merge(DEFAULT_USER, ev.user),
      ga_client_id: gaClientId(),
      ga_session_id: gaSessionId()
    };
    // Marketing identifiers only travel when marketing is allowed.
    if (c.marketing) {
      body.fbp = cookie('_fbp');
      body.fbc = cookie('_fbc');
      body.fbclid = new URLSearchParams(w.location.search).get('fbclid');
    }
    if (consentActive()) body.consent = c;
    post(body);
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
    d.addEventListener('cmplz_fire_categories', flush);
    d.addEventListener('cmplz_status_change', flush);
  }

  if (CONSENT.mode === 'cookiescript') {
    var remember = function (cats) {
      return function (e) {
        var announced = typeof cats === 'function' ? cats(e) : cats;
        if (announced) csAnnounced = announced;
        flush();
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
    if (cmd === 'consent') return flush();
  };
  w.nwr.loaded = true;

  track('PageView');

  if (PAGE && PAGE.type) {
    var pageEvents = { product: 'ViewContent', category: 'ViewCategory', search: 'Search' };
    if (pageEvents[PAGE.type]) track(pageEvents[PAGE.type], PAGE.data || {});
  }

  queued.forEach(function (args) { w.nwr.apply(null, args); });
})(window, document);
`;
}
