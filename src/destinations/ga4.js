/**
 * GA4 Measurement Protocol.
 *
 * Google Ads conversions are imported *from* GA4 rather than pushed to the Ads API,
 * so a working GA4 destination is also the Google Ads destination. See README.
 */

const EVENT_NAMES = {
  PageView: 'page_view',
  ViewContent: 'view_item',
  AddToCart: 'add_to_cart',
  InitiateCheckout: 'begin_checkout',
  AddPaymentInfo: 'add_payment_info',
  Purchase: 'purchase',
  Lead: 'generate_lead',
  Search: 'search',
  CompleteRegistration: 'sign_up',
  Subscribe: 'subscribe',
};

/** Meta-shaped `contents` -> GA4 `items`. */
function buildItems(props = {}) {
  if (Array.isArray(props.items)) return props.items;
  if (!Array.isArray(props.contents)) return null;
  return props.contents.map((c) => ({
    item_id: c.id ?? c.item_id,
    item_name: c.item_name ?? c.name,
    quantity: c.quantity ?? 1,
    price: c.item_price ?? c.price,
  }));
}

export function buildPayload(event, settings) {
  const props = event.properties || {};
  const params = {
    // GA4 requires micros-since-epoch and rejects events older than 72 hours.
    engagement_time_msec: 1,
  };
  if (props.value !== undefined) params.value = Number(props.value);
  if (props.currency) params.currency = props.currency;
  if (props.order_id) params.transaction_id = String(props.order_id);
  if (props.search_string) params.search_term = props.search_string;
  if (event.event_source_url) params.page_location = event.event_source_url;

  const items = buildItems(props);
  if (items?.length) params.items = items;

  const body = {
    client_id: event.context?.gaClientId || event.context?.fbp || `${Date.now()}.${event.event_id}`,
    timestamp_micros: event.event_time * 1_000_000,
    non_personalized_ads: false,
    events: [{
      name: EVENT_NAMES[event.event_name] || toSnake(event.event_name),
      params,
    }],
  };
  if (event.context?.gaSessionId) body.events[0].params.session_id = event.context.gaSessionId;
  if (event.user?.external_id) body.user_id = String(event.user.external_id);
  if (settings.debug) body.debug = true;
  return body;
}

const toSnake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export async function send(event, settings) {
  const { measurement_id: measurementId, api_secret: apiSecret } = settings;
  if (!measurementId || !apiSecret) {
    return { ok: false, retryable: false, error: 'ga4: measurement_id or api_secret missing' };
  }

  // The debug endpoint validates and reports problems; the live one answers 204 to everything.
  const path = settings.debug ? '/debug/mp/collect' : '/mp/collect';
  const url = `https://www.google-analytics.com${path}?measurement_id=${encodeURIComponent(measurementId)}&api_secret=${encodeURIComponent(apiSecret)}`;

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(buildPayload(event, settings)),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: `ga4: ${err.message}` };
  }

  const text = await res.text();

  if (settings.debug) {
    let messages = [];
    try { messages = JSON.parse(text)?.validationMessages ?? []; } catch { /* not json */ }
    if (messages.length) {
      return { ok: false, retryable: false, error: `ga4 validation: ${JSON.stringify(messages).slice(0, 400)}` };
    }
  }

  if (res.ok) return { ok: true, response: text.slice(0, 500) || String(res.status) };
  return {
    ok: false,
    retryable: res.status >= 500 || res.status === 429,
    error: `ga4 ${res.status}: ${text.slice(0, 400)}`,
  };
}
