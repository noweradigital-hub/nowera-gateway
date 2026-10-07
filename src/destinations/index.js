import * as meta from './meta.js';
import * as ga4 from './ga4.js';
import { open, seal } from '../lib/secrets.js';
import { NOT_FOR_META } from '../lib/event-policy.js';

export const drivers = { meta, ga4 };

/**
 * Per-destination delivery rules.
 *
 * `dedupe` says the destination must receive each logical event only once.
 * Meta is the exception: it *wants* both the browser and the server hit and
 * collapses them itself using the shared event_id — that is the whole point of
 * the pixel/CAPI pairing. GA4 has no such mechanism, so a second hit is simply a
 * second purchase by a second user.
 */
export const DELIVERY = {
  // Meta Ads is advertising, so it needs marketing consent.
  meta: { dedupe: false, consent: 'marketing' },
  // GA4 is analytics. Google Ads use of those hits is signalled separately in the
  // payload (ad_user_data / ad_personalization), driven by marketing consent.
  ga4: { dedupe: true, consent: 'statistics' },
};

/**
 * Events a kind of destination has no use for: Meta has no refund event, and the
 * GA4 funnel steps it has no standard event for would only clutter its dataset
 * (see event-policy.js, which px.js follows too).
 */
const SKIP = { meta: NOT_FOR_META };

/** What a destination may be set to receive (settings.scope). */
export const SCOPES = {
  no_page_view: 'Všetky okrem page_view (web má Google tag, ten meria page_view)',
  all: 'Všetky udalosti',
  browserless: 'Len udalosti bez prehliadača (nákupy bez návratu na web, refundácie)',
};

/**
 * Whether this destination takes this event at all, before consent is asked.
 * "browserless" is for a GA4 property the site already measures in the browser
 * (GTM, gtag): it gets only what no browser could have sent, so nothing doubles.
 */
export function wants(dest, event) {
  if (SKIP[dest.kind]?.has(event.event_name)) return false;
  if (dest.settings?.scope === 'browserless' && event.browserless !== true) return false;
  // The Google tag on the page already counts page views and starts the session
  // our events join; a second page_view from here would double them.
  if (dest.settings?.scope === 'no_page_view' && event.event_name === 'PageView') return false;
  return true;
}

/**
 * Whether an event may be delivered to this kind of destination. An event that
 * carries no consent information predates consent handling (or comes from a site
 * that does not use it), and is delivered as before.
 */
export function consentAllows(kind, event) {
  const required = DELIVERY[kind]?.consent;
  if (!required || !event.consent) return true;
  return event.consent[required] === true;
}

/** Key that collapses the two legs of one event, or null when both should go. */
export function dedupeKeyFor(kind, event) {
  if (!DELIVERY[kind]?.dedupe) return null;
  if (!event.event_id) return null;
  return `${event.event_name}:${event.event_id}`;
}

export { TEST_MODE_MINUTES, testModeActive } from './test-mode.js';

export function driverFor(kind) {
  const driver = drivers[kind];
  if (!driver) throw new Error(`Unknown destination kind: ${kind}`);
  return driver;
}

/** Fields the admin UI renders for each destination kind. */
export const SCHEMAS = {
  meta: [
    { key: 'dataset_id', label: 'Dataset / Pixel ID', required: true },
    { key: 'access_token', label: 'Conversions API access token', required: true, secret: true },
    { key: 'test_event_code', label: 'Test event code (voliteľné, platí 60 minút)', required: false },
  ],
  ga4: [
    { key: 'measurement_id', label: 'Measurement ID (G-XXXXXXX)', required: true },
    { key: 'api_secret', label: 'API secret', required: true, secret: true },
    { key: 'scope', label: 'Čo posielať', options: SCOPES, default: 'no_page_view', unset: 'all',
      hint: 'Štandard: web má len Google tag (config) a e-commerce posiela signals → „Všetky okrem page_view“. Ak e-commerce do GA4 posiela aj GTM alebo plugin, zvoľte „Len udalosti bez prehliadača“.' },
  ],
};

/** Names of the settings fields that hold secrets for this kind of destination. */
export const secretKeys = (kind) => (SCHEMAS[kind] || []).filter((f) => f.secret).map((f) => f.key);

/** Settings as stored: the secret fields sealed. */
export function sealSettings(kind, settings = {}) {
  const out = { ...settings };
  for (const key of secretKeys(kind)) if (out[key]) out[key] = seal(out[key]);
  return out;
}

/** Settings as a driver needs them: the secret fields opened. */
export function openSettings(kind, settings = {}) {
  const out = { ...settings };
  for (const key of secretKeys(kind)) if (out[key]) out[key] = open(out[key]);
  return out;
}
