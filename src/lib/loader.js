/**
 * First-party loader served at https://<collector_host>/px.js
 *
 * It bootstraps the Meta pixel (so the browser leg still runs) and mirrors every
 * event to the gateway with the SAME event_id, which is what lets Meta dedupe the
 * two legs into one conversion instead of counting it twice.
 */
export function loaderScript({ endpoint, pixelId, measurementId }) {
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

  function track(name, props, opts) {
    props = props || {};
    opts = opts || {};
    var eventId = opts.eventID || uuid();

    if (w.fbq && PIXEL_ID) {
      try { w.fbq('track', name, props, { eventID: eventId }); } catch (e) {}
    }

    post({
      event_name: name,
      event_id: eventId,
      event_time: Math.floor(Date.now() / 1000),
      event_source_url: w.location.href,
      custom_data: props,
      user_data: merge(DEFAULT_USER, opts.user),
      fbp: cookie('_fbp'),
      fbc: cookie('_fbc'),
      fbclid: new URLSearchParams(w.location.search).get('fbclid'),
      ga_client_id: gaClientId(),
      ga_session_id: gaSessionId()
    });

    return eventId;
  }

  if (PIXEL_ID && !w.fbq) {
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
    w.fbq('init', PIXEL_ID);
  }

  var queued = (w.nwr && w.nwr.q) || [];
  w.nwr = function (cmd) {
    var args = Array.prototype.slice.call(arguments, 1);
    if (cmd === 'track') return track.apply(null, args);
    if (cmd === 'id') return uuid();
  };
  w.nwr.loaded = true;
  queued.forEach(function (args) { w.nwr.apply(null, args); });

  track('PageView');
})(window, document);
`;
}
