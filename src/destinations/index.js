import * as meta from './meta.js';
import * as ga4 from './ga4.js';

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
    { key: 'test_event_code', label: 'Test event code (voliteľné)', required: false },
  ],
  ga4: [
    { key: 'measurement_id', label: 'Measurement ID (G-XXXXXXX)', required: true },
    { key: 'api_secret', label: 'API secret', required: true, secret: true },
  ],
};
