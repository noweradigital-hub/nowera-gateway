import { many, query } from '../db.js';

/**
 * Proof of completeness: the shop's own list of orders, reported by the plugin a
 * few times a day (POST /r), next to what reached the gateway and what the
 * destinations accepted. Each order ends up as delivered, excluded (and why), or
 * missing (and where it got lost).
 *
 * An order is identified by its WooCommerce id, which already travels to Meta
 * and GA4 as the Purchase event id (ord-<id>) and transaction_id; the list holds
 * no contact data.
 */

const MAX_ORDERS = 500;
const ID = /^\d{1,20}$/;
const STATUS = /^[a-z0-9_-]{1,40}$/;
const CONSENT = new Set(['marketing', 'statistics', 'none', '']);

const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);

/** One order line from the plugin, or null when it is not one. */
function cleanOrder(o) {
  if (!o || typeof o !== 'object' || !ID.test(String(o.id ?? ''))) return null;
  const status = String(o.status ?? '');
  const total = Number(o.total);
  const day = String(o.day ?? '');
  return {
    order_id: String(o.id),
    day: /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    created: int(o.created),
    paid: int(o.paid),
    status: STATUS.test(status) ? status : 'unknown',
    total: Number.isFinite(total) ? total : null,
    currency: /^[A-Z]{3}$/.test(String(o.currency ?? '')) ? String(o.currency) : null,
    ready: o.ready === true,
    consent: CONSENT.has(String(o.consent ?? '')) ? String(o.consent ?? '') : '',
    has_ctx: o.ctx === true,
    purchase_sent: o.sent === true,
    thankyou: o.thankyou === true,
    via: /^[a-z0-9_-]{0,40}$/.test(String(o.via ?? '')) ? String(o.via ?? '') : '',
  };
}

/** The snapshot as the plugin sent it, validated; throws on anything else. */
export function parseSnapshot(body) {
  if (!body || typeof body !== 'object') throw new Error('body required');
  const day = String(body.day ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new Error('day must be YYYY-MM-DD');
  if (!Array.isArray(body.orders)) throw new Error('orders must be a list');
  if (body.orders.length > MAX_ORDERS) throw new Error(`at most ${MAX_ORDERS} orders per request`);
  const page = int(body.page) || 1;
  const pages = int(body.pages) || 1;
  if (page > pages) throw new Error('page beyond pages');
  const orders = body.orders.map(cleanOrder).filter(Boolean);
  // The plugin says how many orders the whole run has; older ones did not.
  const total = Number.isInteger(Number(body.total)) && Number(body.total) >= 0 ? Number(body.total) : null;
  // How the site's scheduler is doing, for the install check.
  const c = body.cron && typeof body.cron === 'object' ? body.cron : null;
  const cron = c ? {
    disabled: c.disabled === true,
    due: Number.isInteger(Number(c.due)) && Number(c.due) >= 0 ? Number(c.due) : 0,
    oldest: Number.isInteger(Number(c.oldest)) && Number(c.oldest) >= 0 ? Number(c.oldest) : 0,
  } : null;
  return { day, page, pages, total, cron, orders };
}

const toTime = (s) => (s ? new Date(s * 1000) : null);

const COLUMNS = ['tenant_id', 'order_id', 'day', 'created_at', 'paid_at', 'status', 'total', 'currency',
  'ready', 'consent', 'has_ctx', 'purchase_sent', 'thankyou', 'via'];

/** Stores one page of the list in a single statement; a day counts once its last page arrived. */
export async function saveSnapshot(tenantId, snap) {
  if (snap.orders.length) {
    const params = [];
    const values = snap.orders.map((o, i) => {
      params.push(tenantId, o.order_id, o.day || snap.day, toTime(o.created), toTime(o.paid), o.status, o.total, o.currency,
        o.ready, o.consent, o.has_ctx, o.purchase_sent, o.thankyou, o.via);
      return `(${COLUMNS.map((_, j) => `$${i * COLUMNS.length + j + 1}`).join(', ')}, now())`;
    });
    await query(
      `INSERT INTO order_audit (${COLUMNS.join(', ')}, reported_at) VALUES ${values.join(', ')}
       ON CONFLICT (tenant_id, order_id) DO UPDATE SET
         day = EXCLUDED.day, created_at = EXCLUDED.created_at, paid_at = EXCLUDED.paid_at,
         status = EXCLUDED.status, total = EXCLUDED.total, currency = EXCLUDED.currency,
         ready = EXCLUDED.ready, consent = EXCLUDED.consent, has_ctx = EXCLUDED.has_ctx,
         purchase_sent = EXCLUDED.purchase_sent, thankyou = EXCLUDED.thankyou, via = EXCLUDED.via,
         reported_at = now()`,
      params,
    );
  }
  if (snap.cron) {
    await query(`UPDATE tenants SET cron_report = $2 WHERE id = $1`, [tenantId, JSON.stringify({ ...snap.cron, at: new Date().toISOString() })]);
  }
  if (snap.page === snap.pages) {
    await query(
      `INSERT INTO audit_snapshots (tenant_id, day, orders, completed_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (tenant_id, day) DO UPDATE SET orders = EXCLUDED.orders, completed_at = now()`,
      [tenantId, snap.day, snap.total ?? snap.orders.length],
    );
  }
}

// Time a fresh order gets before its missing Purchase counts as lost: the thank-
// you page, the payment confirmation and the 30-minute fallback all fit in it.
const GRACE_MS = 2 * 3600_000;

/**
 * Where one order stands. `deliveries` hold its Purchase state per destination
 * id ({ 12: 'sent' | 'dead' | 'pending' }), `destinations` the tenant's active
 * ones ({ id, kind, scope }).
 */
export function classifyOrder(o, { received, deliveries = {}, destinations = [], now = Date.now(), since = null }) {
  const at = new Date(o.paid_at || o.created_at || now).getTime();
  const young = now - at < GRACE_MS;
  if (!o.ready) return { state: 'excluded', reason: `nezapočítaná: ${o.status}` };
  // Placed before this shop's measuring began (and shown now only because its
  // status changed): nothing could have reported it. An order the plugin did
  // record is judged as usual.
  const before = since && o.created_at && new Date(o.created_at).getTime() < new Date(since).getTime();
  if (before && !o.has_ctx && !o.consent && !received) return { state: 'excluded', reason: 'pred spustením merania' };
  if (o.consent === 'none') return { state: 'excluded', reason: 'bez súhlasu s cookies' };
  if (!o.consent) {
    if (!o.has_ctx && o.via && o.via !== 'checkout') return { state: 'excluded', reason: `mimo pokladne (${o.via})` };
    if (young) return { state: 'pending', reason: 'čaká na stránku „ďakujeme“ alebo potvrdenie platby' };
    return { state: 'missing', reason: o.has_ctx ? 'plugin Purchase neodoslal' : 'plugin nezaznamenal pokladňu' };
  }
  if (!received) {
    return young ? { state: 'pending', reason: 'na ceste do signals' } : { state: 'missing', reason: 'neprišiel do signals' };
  }

  const per = {};
  let missing = null;
  let pending = false;
  for (const d of destinations) {
    const needs = d.kind === 'meta' ? o.consent === 'marketing' : true;
    if (!needs) { per[d.kind] = 'skip'; continue; }
    // A GA4 fed by GTM takes only purchases no page reported.
    if (d.kind === 'ga4' && d.scope === 'browserless' && o.thankyou) { per[d.kind] = 'gtm'; continue; }
    const status = deliveries[String(d.id)] ?? deliveries[d.kind];
    per[d.kind] = status || 'none';
    if (status === 'sent') continue;
    if (status === 'pending' || status === 'sending') pending = true;
    else missing = missing || `${d.kind === 'meta' ? 'Meta' : 'GA4'}: ${status === 'dead' ? 'nedoručené' : 'nezaradené'}`;
  }
  if (missing) return { state: 'missing', reason: missing, per };
  if (pending) return { state: 'pending', reason: 'doručuje sa', per };
  return { state: 'ok', reason: '', per };
}

/** The orders of the last `days` days with their Purchase evidence. */
export async function auditRows(tenantId, days = 14) {
  return many(
    `SELECT a.*, to_char(a.day, 'YYYY-MM-DD') AS day,
            EXISTS (SELECT 1 FROM received r
                     WHERE r.tenant_id = a.tenant_id AND r.event_name = 'Purchase' AND r.event_id = 'ord-' || a.order_id) AS received,
            -- Per destination: Meta may hold two rows (browser and server leg) for one
            -- purchase; one delivered is enough, otherwise one still on its way.
            (SELECT json_object_agg(x.destination_id, x.status) FROM (
               SELECT e.destination_id,
                      CASE WHEN bool_or(e.status = 'sent') THEN 'sent'
                           WHEN bool_or(e.status IN ('pending', 'sending')) THEN 'pending'
                           ELSE 'dead' END AS status
                 FROM events e
                WHERE e.tenant_id = a.tenant_id AND e.event_name = 'Purchase' AND e.event_id = 'ord-' || a.order_id
                GROUP BY e.destination_id) x) AS deliveries
       FROM order_audit a
      WHERE a.tenant_id = $1 AND a.day >= (now() AT TIME ZONE 'Europe/Bratislava')::date - $2::int
      ORDER BY a.created_at DESC NULLS LAST`,
    [tenantId, days],
  );
}

/** Per day: how many orders, how many counted, delivered, excluded and missing. */
export function summarise(rows, destinations, now = Date.now(), { since = null } = {}) {
  const days = new Map();
  const missing = [];
  for (const row of rows) {
    const verdict = classifyOrder(row, { received: row.received, deliveries: row.deliveries || {}, destinations, now, since });
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    if (!days.has(day)) days.set(day, { day, orders: 0, eligible: 0, consented: 0, received: 0, ok: 0, pending: 0, missing: 0, excluded: 0 });
    const d = days.get(day);
    d.orders++;
    if (row.ready) d.eligible++;
    const counted = row.ready && (row.consent === 'marketing' || row.consent === 'statistics');
    if (counted) d.consented++;
    if (counted && row.received) d.received++;
    d[verdict.state]++;
    if (verdict.state === 'missing') missing.push({ order_id: row.order_id, day, status: row.status, reason: verdict.reason });
  }
  return { days: [...days.values()].sort((a, b) => (a.day < b.day ? 1 : -1)), missing };
}

/** Tenants whose plugin should be reporting (1.2+) but has not completed a day lately. */
export async function overdueSnapshots(hours = 36) {
  return many(
    `SELECT t.id AS tenant_id, max(s.completed_at) AS last
       FROM tenants t LEFT JOIN audit_snapshots s ON s.tenant_id = t.id
      WHERE t.active AND t.plugin_version ~ '^[0-9]+\.[0-9]+'
        AND (split_part(t.plugin_version, '.', 1)::int, split_part(t.plugin_version, '.', 2)::int) >= (1, 2)
        -- A site that only just updated gets the same time to send its first list.
        AND COALESCE(t.plugin_version_since, t.plugin_seen_at) < now() - ($1 || ' hours')::interval
      GROUP BY t.id
     HAVING max(s.completed_at) IS NULL OR max(s.completed_at) < now() - ($1 || ' hours')::interval`,
    [String(hours)],
  );
}
