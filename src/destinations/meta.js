import { config } from '../config.js';
import { buildUserData } from '../lib/hash.js';

/**
 * Meta error codes that will never succeed on retry — a bad token or a malformed
 * parameter stays bad. Everything else (5xx, throttling, network) is retried.
 */
const PERMANENT_CODES = new Set([100, 190, 200, 803]);

function buildCustomData(props = {}) {
  const out = {};
  const copy = [
    'value', 'currency', 'content_name', 'content_category', 'content_ids',
    'content_type', 'contents', 'num_items', 'order_id', 'search_string',
    'status', 'predicted_ltv',
  ];
  for (const key of copy) {
    if (props[key] !== undefined && props[key] !== null && props[key] !== '') {
      out[key] = props[key];
    }
  }
  if (out.value !== undefined) out.value = Number(out.value);
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

  const custom = buildCustomData(event.properties);
  if (Object.keys(custom).length) data.custom_data = custom;

  const body = { data: [data] };
  if (settings.test_event_code) body.test_event_code = settings.test_event_code;
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
