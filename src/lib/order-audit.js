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
const MAX_BOOKINGS = 500;
const ID = /^\d{1,20}$/;
const STATUS = /^[a-z0-9_-]{1,40}$/;
const KIND = /^[a-z][a-z0-9_]{0,29}$/;
const CONSENT = new Set(['marketing', 'statistics', 'none', '']);
// The events an order can stand for; each is looked up under its own id.
export const ORDER_EVENTS = { Purchase: 'ord-', Lead: 'book-', Subscribe: 'sub-' };

const int = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const money = (v) => (v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Math.round(Number(v) * 100) / 100 : null);

/** Money paid per kind of line ({ booking: 75, product: 20 }), or null. */
function cleanParts(parts) {
  if (!parts || typeof parts !== 'object' || Array.isArray(parts)) return null;
  const out = {};
  for (const [kind, amount] of Object.entries(parts).slice(0, 12)) {
    if (KIND.test(kind) && money(amount) !== null) out[kind] = money(amount);
  }
  return out;
}

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
    // From plugin 1.3: what the order is and which events stand for it. A plugin
    // that says nothing (expect null) reports every order as a Purchase.
    kind: KIND.test(String(o.kind ?? '')) ? String(o.kind) : null,
    expect: Array.isArray(o.expect) ? o.expect.map(String).filter((e) => e in ORDER_EVENTS).slice(0, 3) : null,
    goods: money(o.goods),
    tender: money(o.tender),
    refunded: money(o.refunded),
    parts: cleanParts(o.parts),
    bookings: Number.isInteger(Number(o.bookings)) && Number(o.bookings) >= 0 ? Number(o.bookings) : null,
  };
}

/** One booking from the site's booking plugin, or null when it is not one. No contact data. */
function cleanBooking(b) {
  if (!b || typeof b !== 'object' || !/^[a-z0-9_-]{1,40}$/.test(String(b.id ?? ''))) return null;
  const text = (v, max) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
  return {
    booking_id: String(b.id),
    source: b.source === 'staff' ? 'staff' : 'web',
    type: KIND.test(String(b.type ?? '')) ? String(b.type) : 'appointment',
    item: /^[a-z0-9_-]{1,60}$/.test(String(b.item ?? '')) ? String(b.item) : null,
    name: text(b.name, 120),
    status: STATUS.test(String(b.status ?? '')) ? String(b.status) : 'unknown',
    created: int(b.created),
    starts: int(b.starts),
    price: money(b.price),
    currency: /^[A-Z]{3}$/.test(String(b.currency ?? '')) ? String(b.currency) : null,
    order_id: ID.test(String(b.order_id ?? '')) ? String(b.order_id) : null,
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
  if (Array.isArray(body.bookings) && body.bookings.length > MAX_BOOKINGS) throw new Error(`at most ${MAX_BOOKINGS} bookings per request`);
  const bookings = Array.isArray(body.bookings) ? body.bookings.map(cleanBooking).filter(Boolean) : null;
  // The shop's time zone names the day a booking was made on.
  const timezone = /^[A-Za-z0-9_+\-/]{1,64}$/.test(String(body.timezone ?? '')) ? String(body.timezone) : null;
  // More bookings than one request holds come on their own, marked: not a list of orders.
  return { day, page, pages, total, cron, orders, bookings, timezone, partial: body.partial === true };
}

const toTime = (s) => (s ? new Date(s * 1000) : null);

const COLUMNS = ['tenant_id', 'order_id', 'day', 'created_at', 'paid_at', 'status', 'total', 'currency',
  'ready', 'consent', 'has_ctx', 'purchase_sent', 'thankyou', 'via',
  'kind', 'expect', 'goods', 'tender', 'refunded', 'parts', 'bookings'];
const BOOKING_COLUMNS = ['tenant_id', 'booking_id', 'source', 'type', 'item', 'name', 'status', 'created_at', 'starts_at',
  'price', 'currency', 'order_id', 'day'];

/** The calendar day of a moment in a time zone (YYYY-MM-DD); UTC when the zone is unknown. */
export function dayIn(seconds, timezone) {
  if (!seconds) return null;
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timezone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(seconds * 1000));
  } catch {
    return new Date(seconds * 1000).toISOString().slice(0, 10);
  }
}

/** Stores one page of the list in a single statement; a day counts once its last page arrived. */
export async function saveSnapshot(tenantId, snap) {
  if (snap.orders.length) {
    const params = [];
    const values = snap.orders.map((o, i) => {
      params.push(tenantId, o.order_id, o.day || snap.day, toTime(o.created), toTime(o.paid), o.status, o.total, o.currency,
        o.ready, o.consent, o.has_ctx, o.purchase_sent, o.thankyou, o.via,
        o.kind, o.expect ? JSON.stringify(o.expect) : null, o.goods, o.tender, o.refunded,
        o.parts ? JSON.stringify(o.parts) : null, o.bookings);
      return `(${COLUMNS.map((_, j) => `$${i * COLUMNS.length + j + 1}`).join(', ')}, now())`;
    });
    await query(
      `INSERT INTO order_audit (${COLUMNS.join(', ')}, reported_at) VALUES ${values.join(', ')}
       ON CONFLICT (tenant_id, order_id) DO UPDATE SET
         day = EXCLUDED.day, created_at = EXCLUDED.created_at, paid_at = EXCLUDED.paid_at,
         status = EXCLUDED.status, total = EXCLUDED.total, currency = EXCLUDED.currency,
         ready = EXCLUDED.ready, consent = EXCLUDED.consent, has_ctx = EXCLUDED.has_ctx,
         purchase_sent = EXCLUDED.purchase_sent, thankyou = EXCLUDED.thankyou, via = EXCLUDED.via,
         kind = EXCLUDED.kind, expect = EXCLUDED.expect, goods = EXCLUDED.goods, tender = EXCLUDED.tender,
         refunded = EXCLUDED.refunded, parts = EXCLUDED.parts, bookings = EXCLUDED.bookings,
         reported_at = now()`,
      params,
    );
  }
  if (snap.bookings?.length) {
    const params = [];
    const values = snap.bookings.map((b, i) => {
      params.push(tenantId, b.booking_id, b.source, b.type, b.item, b.name, b.status, toTime(b.created), toTime(b.starts),
        b.price, b.currency, b.order_id, dayIn(b.created, snap.timezone) || snap.day);
      return `(${BOOKING_COLUMNS.map((_, j) => `$${i * BOOKING_COLUMNS.length + j + 1}`).join(', ')}, now())`;
    });
    await query(
      `INSERT INTO booking_ledger (${BOOKING_COLUMNS.join(', ')}, reported_at) VALUES ${values.join(', ')}
       ON CONFLICT (tenant_id, booking_id) DO UPDATE SET
         source = EXCLUDED.source, type = EXCLUDED.type, item = EXCLUDED.item, name = EXCLUDED.name,
         status = EXCLUDED.status, created_at = EXCLUDED.created_at, starts_at = EXCLUDED.starts_at,
         price = EXCLUDED.price, currency = EXCLUDED.currency, order_id = EXCLUDED.order_id, day = EXCLUDED.day,
         reported_at = now()`,
      params,
    );
  }
  if (snap.cron) {
    await query(`UPDATE tenants SET cron_report = $2 WHERE id = $1`, [tenantId, JSON.stringify({ ...snap.cron, at: new Date().toISOString() })]);
  }
  if (snap.page === snap.pages && !snap.partial) {
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

/** The events of an order the check looks for (a Subscribe rides with its Purchase). */
function auditedEvents(o) {
  const expect = Array.isArray(o.expect) ? o.expect : ['Purchase'];
  return expect.filter((name) => name === 'Purchase' || name === 'Lead');
}

/** What is known of each of an order's events: { Purchase: { received, deliveries }, Lead: … }. */
function evidenceOf(o, { received, deliveries, evidence }) {
  return evidence || o.evidence || { Purchase: { received: Boolean(received), deliveries: deliveries || {} } };
}

/**
 * Where one order stands. `evidence` holds, per event the order stands for,
 * whether it reached the gateway and its state per destination id
 * ({ Purchase: { received: true, deliveries: { 12: 'sent' | 'dead' | 'pending' } } });
 * `received` and `deliveries` say the same for a Purchase alone. `destinations`
 * are the tenant's active ones ({ id, kind, scope }).
 */
export function classifyOrder(o, { received, deliveries = {}, evidence = null, destinations = [], now = Date.now(), since = null }) {
  const at = new Date(o.paid_at || o.created_at || now).getTime();
  const young = now - at < GRACE_MS;
  if (!o.ready) return { state: 'excluded', reason: `nezapočítaná: ${o.status}` };
  // Plugin 1.3 says what the order stands for. Nothing: it cost nothing, or it
  // renews a subscription, and is kept in the order list only.
  if (Array.isArray(o.expect) && !o.expect.length) {
    return { state: 'excluded', reason: o.kind === 'renewal' ? 'obnovenie predplatného (len evidencia)' : 'nulová suma (len evidencia)' };
  }
  const names = auditedEvents(o);
  const known = evidenceOf(o, { received, deliveries, evidence });
  const arrived = names.filter((name) => known[name]?.received);
  // Placed before this shop's measuring began (and shown now only because its
  // status changed): nothing could have reported it. An order the plugin did
  // record is judged as usual.
  const before = since && o.created_at && new Date(o.created_at).getTime() < new Date(since).getTime();
  if (before && !o.has_ctx && !o.consent && !arrived.length) return { state: 'excluded', reason: 'pred spustením merania' };
  if (o.consent === 'none') return { state: 'excluded', reason: 'bez súhlasu s cookies' };
  const what = names.join(' + ') || 'Purchase';
  if (!o.consent) {
    if (!o.has_ctx && o.via && o.via !== 'checkout') return { state: 'excluded', reason: `mimo pokladne (${o.via})` };
    if (young) return { state: 'pending', reason: 'čaká na stránku „ďakujeme“ alebo potvrdenie platby' };
    return { state: 'missing', reason: o.has_ctx ? `plugin ${what} neodoslal` : 'plugin nezaznamenal pokladňu' };
  }
  if (arrived.length < names.length) {
    const lost = names.filter((name) => !known[name]?.received);
    const label = names.length === 1 && lost[0] === 'Purchase' ? '' : `${lost.join(' + ')} `;
    return young ? { state: 'pending', reason: 'na ceste do signals' } : { state: 'missing', reason: `${label}neprišiel do signals` };
  }

  const per = {};
  let missing = null;
  let pending = false;
  for (const name of names) {
    const sent = known[name]?.deliveries || {};
    for (const d of destinations) {
      const key = names.length === 1 ? d.kind : `${name}:${d.kind}`;
      const needs = d.kind === 'meta' ? o.consent === 'marketing' : true;
      if (!needs) { per[key] = 'skip'; continue; }
      // A GA4 fed by GTM takes only what no page reported.
      if (d.kind === 'ga4' && d.scope === 'browserless' && o.thankyou) { per[key] = 'gtm'; continue; }
      const status = sent[String(d.id)] ?? sent[d.kind];
      per[key] = status || 'none';
      if (status === 'sent') continue;
      if (status === 'pending' || status === 'sending') pending = true;
      else missing = missing || `${names.length === 1 && name === 'Purchase' ? '' : `${name} → `}${d.kind === 'meta' ? 'Meta' : 'GA4'}: ${status === 'dead' ? 'nedoručené' : 'nezaradené'}`;
    }
  }
  if (missing) return { state: 'missing', reason: missing, per };
  if (pending) return { state: 'pending', reason: 'doručuje sa', per };
  return { state: 'ok', reason: '', per };
}

/** The orders of the last `days` days with the evidence for their events. */
export async function auditRows(tenantId, days = 14) {
  const rows = await many(
    `SELECT a.*, to_char(a.day, 'YYYY-MM-DD') AS day,
            (SELECT json_agg(DISTINCT r.event_name) FROM received r
              WHERE r.tenant_id = a.tenant_id
                AND (r.event_name, r.event_id) IN (('Purchase', 'ord-' || a.order_id), ('Lead', 'book-' || a.order_id))) AS arrived,
            -- Per event and destination: Meta may hold two rows (browser and server
            -- leg) for one event; one delivered is enough, otherwise one still on its way.
            (SELECT json_object_agg(y.event_name, y.dests) FROM (
               SELECT x.event_name, json_object_agg(x.destination_id, x.status) AS dests FROM (
                 SELECT e.event_name, e.destination_id,
                        CASE WHEN bool_or(e.status = 'sent') THEN 'sent'
                             WHEN bool_or(e.status IN ('pending', 'sending')) THEN 'pending'
                             ELSE 'dead' END AS status
                   FROM events e
                  WHERE e.tenant_id = a.tenant_id
                    AND (e.event_name, e.event_id) IN (('Purchase', 'ord-' || a.order_id), ('Lead', 'book-' || a.order_id))
                  GROUP BY e.event_name, e.destination_id) x
               GROUP BY x.event_name) y) AS delivered
       FROM order_audit a
      WHERE a.tenant_id = $1 AND a.day >= (now() AT TIME ZONE 'Europe/Bratislava')::date - $2::int
      ORDER BY a.created_at DESC NULLS LAST`,
    [tenantId, days],
  );
  return rows.map(({ arrived, delivered, ...row }) => {
    const evidence = {};
    for (const name of ['Purchase', 'Lead']) {
      evidence[name] = { received: (arrived || []).includes(name), deliveries: delivered?.[name] || {} };
    }
    return { ...row, evidence, received: evidence.Purchase.received, deliveries: evidence.Purchase.deliveries };
  });
}

/** Per day: how many orders, how many counted, delivered, excluded and missing. */
export function summarise(rows, destinations, now = Date.now(), { since = null } = {}) {
  const days = new Map();
  const missing = [];
  for (const row of rows) {
    const verdict = classifyOrder(row, { received: row.received, deliveries: row.deliveries || {}, evidence: row.evidence, destinations, now, since });
    const day = row.day instanceof Date ? row.day.toISOString().slice(0, 10) : String(row.day).slice(0, 10);
    if (!days.has(day)) days.set(day, { day, orders: 0, eligible: 0, consented: 0, received: 0, ok: 0, pending: 0, missing: 0, excluded: 0 });
    const d = days.get(day);
    d.orders++;
    // Counted: an order that stands for an event (one kept in the list only does not).
    const stands = row.ready && !(Array.isArray(row.expect) && !row.expect.length);
    if (stands) d.eligible++;
    const counted = stands && (row.consent === 'marketing' || row.consent === 'statistics');
    if (counted) d.consented++;
    const known = evidenceOf(row, { received: row.received, deliveries: row.deliveries });
    if (counted && auditedEvents(row).every((name) => known[name]?.received)) d.received++;
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
