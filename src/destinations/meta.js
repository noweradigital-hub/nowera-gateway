import { config } from '../config.js';
import { buildUserData } from '../lib/hash.js';
import { testModeActive } from './test-mode.js';

/**
 * Meta error codes that will never succeed on retry — a bad token or a malformed
 * parameter stays bad. Everything else (5xx, throttling, network) is retried.
 */
const PERMANENT_CODES = new Set([100, 190, 200, 803]);

// Meta's accepted values for custom_data.customer_segmentation.
const CUSTOMER_SEGMENTS = new Set([
  'new_customer_to_business', 'new_customer_to_business_line',
  'new_customer_to_product_area', 'new_customer_to_medium',
  'existing_customer_to_business', 'existing_customer_to_business_line',
  'existing_customer_to_product_area', 'existing_customer_to_medium',
  'customer_in_loyalty_program',
]);

/**
 * One `contents` entry as Meta defines it. The site sends richer, GA4-shaped
 * items; Meta gets their names under its own keys and nothing it does not know.
 */
function metaContent(c = {}) {
  const out = { id: c.id ?? c.item_id, quantity: c.quantity ?? 1 };
  const price = c.item_price ?? c.price;
  if (price !== undefined && price !== null) out.item_price = Number(price);
  const title = c.title ?? c.item_name;
  if (title) out.title = String(title);
  const brand = c.brand ?? c.item_brand;
  if (brand) out.brand = String(brand);
  const category = c.category ?? c.item_category;
  if (category) out.category = String(category);
  if (c.delivery_category) out.delivery_category = c.delivery_category;
  return out;
}

function buildCustomData(props = {}) {
  const out = {};
  const copy = [
    'value', 'currency', 'content_name', 'content_category', 'content_ids',
    'content_type', 'contents', 'num_items', 'order_id', 'search_string',
    'status', 'predicted_ltv', 'customer_segmentation',
  ];
  for (const key of copy) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== '') {
      out[key] = props[key];
    }
  }
  if (out.value !== undefined) out.value = Number(out.value);
  if (Array.isArray(out.contents)) out.contents = out.contents.map(metaContent);
  // An unknown value would make Meta reject the whole event.
  if (out.customer_segmentation !== undefined && !CUSTOMER_SEGMENTS.has(out.customer_segmentation)) {
    delete out.customer_segmentation;
  }
  return out;
}

export function buildPayload(event, settings) {
  const data = {
    event_name: event.event_name,
    event_time: event.event_time,
    action_source: event.action_source || 'website',
    user_data: buildUserData(event.user, event.context),
  };
  // event_id is what lets Meta collapse the browser pixel hit and this server hit
  // into one conversion. Without it every event is counted twice.
  if (event.event_id) data.event_id = event.event_id;
  if (event.event_source_url) data.event_source_url = event.event_source_url;
  if (event.referrer_url) data.referrer_url = event.referrer_url;

  const custom = buildCustomData(event.properties);
  if (Object.keys(custom).length) data.custom_data = custom;

  const body = { data: [data] };
  // A forgotten test code once kept a client's events out of their campaigns for
  // a week; it now lapses on its own an hour after it was saved.
  if (testModeActive(settings)) body.test_event_code = settings.test_event_code;
  return body;
}

export async function send(event, settings) {
  const { dataset_id: datasetId, access_token: accessToken } = settings;
  if (!datasetId || !accessToken) {
    return { ok: false, retryable: false, error: 'meta: dataset_id or access_token missing' };
  }

  const url = `https://graph.facebook.com/${config.metaApiVersion}/${datasetId}/events`;
  const body = buildPayload(event, settings);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    return { ok: false, retryable: true, error: `meta: ${err.message}` };
  }

  const text = await res.text();
  if (res.ok) return { ok: true, response: text.slice(0, 500) };

  let code = null;
  try { code = JSON.parse(text)?.error?.code ?? null; } catch { /* not json */ }
  const retryable = res.status >= 500 || (code !== null && !PERMANENT_CODES.has(code));
  return { ok: false, retryable, error: `meta ${res.status}: ${text.slice(0, 400)}` };
}
