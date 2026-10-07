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
  ViewCategory: 'view_item_list',
  CompleteRegistration: 'sign_up',
  Subscribe: 'subscribe',
  ViewCart: 'view_cart',
  RemoveFromCart: 'remove_from_cart',
  AddShippingInfo: 'add_shipping_info',
  SelectItem: 'select_item',
  AddToWishlist: 'add_to_wishlist',
  Login: 'login',
  Refund: 'refund',
};

// GA4 item fields the site may send alongside Meta's id/quantity/item_price.
const ITEM_FIELDS = [
  'item_name', 'item_brand', 'item_variant', 'item_category', 'item_category2', 'item_category3',
  'item_category4', 'item_category5', 'item_list_name', 'item_list_id', 'index', 'discount', 'coupon', 'affiliation',
];

/** Meta-shaped `contents` -> GA4 `items`. */
function buildItems(props = {}) {
  if (Array.isArray(props.items)) return props.items;
  if (!Array.isArray(props.contents)) return null;
  return props.contents.map((c) => {
    const item = {
      item_id: c.id ?? c.item_id,
      item_name: c.item_name ?? c.name,
      quantity: c.quantity ?? 1,
      // Revenue without VAT, as GA4 defines it, when the site sends it.
      price: c.price_net ?? c.item_price ?? c.price,
    };
    for (const key of ITEM_FIELDS) {
      if (item[key] === undefined && c[key] !== undefined && c[key] !== null && c[key] !== '') item[key] = c[key];
    }
    return item;
  });
}

// GA4 drops events timestamped more than 72 hours back without saying so.
export const GA4_MAX_AGE_SECONDS = 72 * 3600;

/**
 * A client_id for a visitor without the Google tag's _ga cookie (blocked tag,
 * server-only purchase). Derived from the site's own visitor id, so all of this
 * visitor's events at least form one GA4 user rather than one user each.
 */
function fallbackClientId(event) {
  const seed = event.user?.external_id;
  if (typeof seed === 'string' && /^[a-f0-9]{16,}$/i.test(seed)) {
    return `${parseInt(seed.slice(0, 8), 16)}.${parseInt(seed.slice(8, 16), 16)}`;
  }
  return `${Date.now()}.${event.event_id}`;
}

export function buildPayload(event, settings) {
  const props = event.properties || {};
  const params = {
    // GA4 requires micros-since-epoch and rejects events older than 72 hours.
    engagement_time_msec: 1,
  };
  // GA4's value is the items without tax and shipping; the site sends that as
  // value_net next to the full total (which Meta gets).
  const value = props.value_net ?? props.value;
  if (value !== undefined && value !== null) params.value = Number(value);
  if (props.currency) params.currency = props.currency;
  if (props.order_id) params.transaction_id = String(props.order_id);
  if (props.search_string) params.search_term = props.search_string;
  if (props.tax !== undefined && props.tax !== null) params.tax = Number(props.tax);
  if (props.shipping !== undefined && props.shipping !== null) params.shipping = Number(props.shipping);
  if (props.coupon) params.coupon = String(props.coupon);
  if (props.item_list_name) params.item_list_name = String(props.item_list_name);
  if (props.payment_type) params.payment_type = String(props.payment_type);
  if (props.shipping_tier) params.shipping_tier = String(props.shipping_tier);
  if (props.item_list_id) params.item_list_id = String(props.item_list_id);
  if (props.method) params.method = String(props.method);
  if (event.event_source_url) params.page_location = event.event_source_url;
  if (event.referrer_url) params.page_referrer = event.referrer_url;

  const items = buildItems(props);
  if (items?.length) params.items = items;

  const body = {
    client_id: event.context?.gaClientId || fallbackClientId(event),
    timestamp_micros: event.event_time * 1_000_000,
    non_personalized_ads: false,
    events: [{
      name: EVENT_NAMES[event.event_name] || toSnake(event.event_name),
      params,
    }],
  };
  if (event.context?.gaSessionId) body.events[0].params.session_id = event.context.gaSessionId;
  // user_id is for a customer account the site knows, the same person on every
  // device. An anonymous visitor id is not one.
  if (event.account_id) body.user_id = event.account_id;
  // Tells Google whether this hit may be used for ads. Without it Google falls
  // back to whatever the browser tag last said, and there is no browser tag here.
  if (typeof event.consent?.marketing === 'boolean') {
    const state = event.consent.marketing ? 'GRANTED' : 'DENIED';
    body.consent = { ad_user_data: state, ad_personalization: state };
  }
  // Hashed contact data (user-provided data / enhanced conversions) is for ads,
  // so only with marketing consent, or on a site that does not ask.
  if (event.google_user && event.consent?.marketing !== false) body.user_data = event.google_user;
  if (settings.debug || event.test) body.debug = true;
  return body;
}

const toSnake = (s) => String(s).replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

export async function send(event, settings) {
  const { measurement_id: measurementId, api_secret: apiSecret } = settings;
  if (!measurementId || !apiSecret) {
    return { ok: false, retryable: false, error: 'ga4: measurement_id or api_secret missing' };
  }
  // Google would answer 204 and silently drop it; say so instead.
  if (event.event_time < Math.floor(Date.now() / 1000) - GA4_MAX_AGE_SECONDS) {
    return { ok: false, retryable: false, error: 'ga4: udalosť je staršia ako 72 h, GA4 by ju zahodil' };
  }

  // The debug endpoint validates and reports problems; the live one answers 204 to everything.
  // A test from the dashboard is only validated, never recorded.
  const debug = Boolean(settings.debug || event.test);
  const path = debug ? '/debug/mp/collect' : '/mp/collect';
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

  if (debug) {
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
