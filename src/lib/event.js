import { newEventId } from './ids.js';

const MAX_AGE_SECONDS = 7 * 86400; // Meta rejects events older than 7 days

const PII_KEYS = ['em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country', 'ge', 'db', 'external_id'];

/** Long-form aliases so the WordPress plugin can send readable keys. */
const PII_ALIASES = {
  email: 'em', phone: 'ph', first_name: 'fn', last_name: 'ln',
  city: 'ct', state: 'st', zip: 'zp', gender: 'ge', date_of_birth: 'db',
};

function pickUser(raw = {}) {
  const user = {};
  for (const [alias, key] of Object.entries(PII_ALIASES)) {
    if (raw[alias] !== undefined) user[key] = raw[alias];
  }
  for (const key of PII_KEYS) {
    if (raw[key] !== undefined) user[key] = raw[key];
  }
  return user;
}

/**
 * Turn whatever arrived on the wire into the canonical shape every destination
 * driver consumes. Throws on input we refuse to guess about.
 */
export function normalizeEvent(input, context) {
  const name = String(input.event_name || input.event || '').trim();
  if (!name) throw new Error('event_name is required');
  if (!/^[A-Za-z0-9_ ]{1,64}$/.test(name)) throw new Error('event_name has invalid characters');

  const nowSeconds = Math.floor(Date.now() / 1000);
  let eventTime = Number(input.event_time) || nowSeconds;
  // Clocks on client machines drift; clamp rather than let the destination reject it.
  if (eventTime > nowSeconds + 60) eventTime = nowSeconds;
  if (eventTime < nowSeconds - MAX_AGE_SECONDS) eventTime = nowSeconds - MAX_AGE_SECONDS;

  return {
    event_name: name,
    event_id: String(input.event_id || newEventId()),
    event_time: eventTime,
    event_source_url: input.event_source_url || input.url || context.referer || null,
    action_source: input.action_source || context.actionSource || 'website',
    user: pickUser(input.user_data || input.user || {}),
    properties: input.custom_data || input.properties || {},
    context: {
      ip: context.ip,
      userAgent: context.userAgent,
      fbp: context.fbp || null,
      fbc: context.fbc || null,
      gaClientId: input.ga_client_id || context.gaClientId || null,
      gaSessionId: input.ga_session_id || context.gaSessionId || null,
    },
  };
}
