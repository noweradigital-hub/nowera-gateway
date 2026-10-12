import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { many, one, query } from '../db.js';

/**
 * Daily figures for the agency's own reports (an n8n workflow reads them a few
 * times a day): per client and day, the orders and what they were — goods,
 * bookings, gift cards, subscriptions — the money paid, and the bookings from
 * the site's booking plugin. They come from the order list the plugin reports
 * every hour (POST /r), which holds every order whatever the visitor's cookie
 * consent, and no contact data.
 *
 * One key for all clients, made in the administration and kept only as a hash.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS = 400;
const hash = (key) => createHash('sha256').update(String(key)).digest('hex');

/** Makes a new key (the old one stops working) and returns it; it is shown once. */
export async function newReportKey() {
  const key = `nwr_${randomBytes(24).toString('base64url')}`;
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('report', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ key_hash: hash(key), created_at: new Date().toISOString() })],
  );
  return key;
}

/** When the current key was made, or null when there is none. */
export async function reportKeyInfo() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'report'`);
  return row?.value?.key_hash ? { created_at: row.value.created_at || null } : null;
}

/** Whether a key from a request is the current one. */
export async function reportKeyValid(given) {
  if (typeof given !== 'string' || given.length < 20 || given.length > 200) return false;
  const row = await one(`SELECT value FROM app_settings WHERE key = 'report'`);
  const stored = row?.value?.key_hash;
  if (!stored) return false;
  const a = Buffer.from(hash(given), 'hex');
  const b = Buffer.from(String(stored), 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const iso = (date) => date.toISOString().slice(0, 10);
// The shops' days are local days; "today" for a request without dates is theirs.
const today = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** The days asked for: from and to (inclusive), by default the last seven up to today. */
export function parseRange(q = {}, now = new Date()) {
  const to = DAY.test(String(q.to ?? '')) ? String(q.to) : today(now);
  const from = DAY.test(String(q.from ?? '')) ? String(q.from) : iso(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400_000));
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) throw new Error('from and to must be days (YYYY-MM-DD)');
  if (a > b) throw new Error('from must not be after to');
  if ((b - a) / 86400_000 > MAX_DAYS) throw new Error(`at most ${MAX_DAYS} days`);
  return { from, to };
}

const num = (v) => Math.round(Number(v || 0) * 100) / 100;

function emptyDay(day, currency) {
  return {
    day, currency,
    orders: 0, // every order placed that day, whatever became of it
    counted: 0, // paid or to be paid (not failed, cancelled or still unpaid)
    paid: 0, // money the counted orders cost their buyers
    goods: 0, // what they were worth before gift cards were taken off
    tender: 0, // the part settled with gift cards
    refunded: 0,
    free_orders: 0, // counted orders that cost nothing
    leads: 0, // counted orders that hold a booking
    renewals: { orders: 0, paid: 0 },
    by_kind: {},
    bookings: { web: 0, staff: 0, canceled: 0, value: 0, by_type: {} },
  };
}

/** Puts the three query results together: tenants → days → figures, plus totals per tenant. */
export function shapeReport({ tenants, orders, kinds, bookings }, range) {
  const out = new Map(tenants.map((t) => [t.id, {
    id: t.id, slug: t.slug, name: t.name, plugin_version: t.plugin_version || null,
    ledger_at: t.ledger_at ? new Date(t.ledger_at).toISOString() : null,
    days: new Map(),
  }]));
  const dayOf = (tenantId, day, currency) => {
    const t = out.get(tenantId);
    if (!t) return null;
    // One line per day; a shop selling in two currencies gets one per currency.
    const same = [...t.days.values()].find((d) => d.day === day && (!currency || !d.currency || d.currency === currency));
    if (same) { if (!same.currency && currency) same.currency = currency; return same; }
    const entry = emptyDay(day, currency || null);
    t.days.set(`${day}|${currency || ''}`, entry);
    return entry;
  };
  for (const r of orders) {
    const d = dayOf(r.tenant_id, r.day, r.currency);
    if (!d) continue;
    d.orders += Number(r.orders); d.counted += Number(r.counted); d.free_orders += Number(r.free_orders); d.leads += Number(r.leads);
    d.paid = num(d.paid + Number(r.paid)); d.goods = num(d.goods + Number(r.goods)); d.tender = num(d.tender + Number(r.tender));
    d.refunded = num(d.refunded + Number(r.refunded));
    d.renewals.orders += Number(r.renewals); d.renewals.paid = num(d.renewals.paid + Number(r.renewals_paid));
  }
  for (const r of kinds) {
    const d = dayOf(r.tenant_id, r.day, r.currency);
    if (!d) continue;
    const k = d.by_kind[r.kind] || (d.by_kind[r.kind] = { orders: 0, paid: 0 });
    k.orders += Number(r.orders); k.paid = num(k.paid + Number(r.paid));
  }
  for (const r of bookings) {
    const d = dayOf(r.tenant_id, r.day, r.currency);
    if (!d) continue;
    const n = Number(r.n);
    if (r.status === 'canceled' || r.status === 'rejected') { d.bookings.canceled += n; continue; }
    d.bookings[r.source === 'staff' ? 'staff' : 'web'] += n;
    d.bookings.value = num(d.bookings.value + Number(r.value));
    d.bookings.by_type[r.type] = (d.bookings.by_type[r.type] || 0) + n;
  }
  return {
    from: range.from, to: range.to, generated_at: new Date().toISOString(),
    tenants: [...out.values()].map((t) => {
      const days = [...t.days.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
      const totals = emptyDay(null, null);
      delete totals.day; delete totals.currency;
      for (const d of days) {
        for (const key of ['orders', 'counted', 'free_orders', 'leads']) totals[key] += d[key];
        for (const key of ['paid', 'goods', 'tender', 'refunded']) totals[key] = num(totals[key] + d[key]);
        totals.renewals.orders += d.renewals.orders; totals.renewals.paid = num(totals.renewals.paid + d.renewals.paid);
        for (const [kind, v] of Object.entries(d.by_kind)) {
          const k = totals.by_kind[kind] || (totals.by_kind[kind] = { orders: 0, paid: 0 });
          k.orders += v.orders; k.paid = num(k.paid + v.paid);
        }
        for (const key of ['web', 'staff', 'canceled']) totals.bookings[key] += d.bookings[key];
        totals.bookings.value = num(totals.bookings.value + d.bookings.value);
        for (const [type, n] of Object.entries(d.bookings.by_type)) totals.bookings.by_type[type] = (totals.bookings.by_type[type] || 0) + n;
      }
      // Sums over days only mean something in one currency.
      const currencies = [...new Set(days.map((d) => d.currency).filter(Boolean))];
      return { ...t, currency: currencies.length === 1 ? currencies[0] : null, totals: currencies.length > 1 ? null : totals, days };
    }),
  };
}

/** The report for a range of days, for every active client or one (by slug). */
export async function dailyReport(range, { tenant = null } = {}) {
  const args = [range.from, range.to];
  let only = '';
  if (tenant) { args.push(String(tenant)); only = ` AND t.slug = $${args.length}`; }
  const tenants = await many(
    `SELECT t.id, t.slug, t.name, t.plugin_version,
            (SELECT max(a.reported_at) FROM order_audit a WHERE a.tenant_id = t.id) AS ledger_at
       FROM tenants t WHERE t.active${tenant ? ' AND t.slug = $1' : ''} ORDER BY t.name`,
    tenant ? [String(tenant)] : [],
  );
  const scope = `a.day BETWEEN $1::date AND $2::date AND t.active${only}`;
  const [orders, kinds, bookings] = await Promise.all([
    many(
      `SELECT a.tenant_id, to_char(a.day, 'YYYY-MM-DD') AS day, a.currency,
              count(*) AS orders,
              count(*) FILTER (WHERE a.ready) AS counted,
              count(*) FILTER (WHERE a.ready AND a.total = 0) AS free_orders,
              count(*) FILTER (WHERE a.ready AND a.expect ? 'Lead') AS leads,
              coalesce(sum(a.total) FILTER (WHERE a.ready), 0) AS paid,
              coalesce(sum(coalesce(a.goods, a.total)) FILTER (WHERE a.ready), 0) AS goods,
              coalesce(sum(a.tender) FILTER (WHERE a.ready), 0) AS tender,
              coalesce(sum(a.refunded), 0) AS refunded,
              count(*) FILTER (WHERE a.ready AND a.kind = 'renewal') AS renewals,
              coalesce(sum(a.total) FILTER (WHERE a.ready AND a.kind = 'renewal'), 0) AS renewals_paid
         FROM order_audit a JOIN tenants t ON t.id = a.tenant_id
        WHERE ${scope}
        GROUP BY 1, 2, 3`,
      args,
    ),
    // Money per kind of line; an order from a plugin that does not say is goods.
    many(
      `SELECT a.tenant_id, to_char(a.day, 'YYYY-MM-DD') AS day, a.currency, p.key AS kind,
              count(*) AS orders, coalesce(sum(p.value::numeric), 0) AS paid
         FROM order_audit a JOIN tenants t ON t.id = a.tenant_id
        CROSS JOIN LATERAL jsonb_each_text(coalesce(a.parts, jsonb_build_object(coalesce(a.kind, 'product'), coalesce(a.total, 0)))) p
        WHERE a.ready AND ${scope}
        GROUP BY 1, 2, 3, 4`,
      args,
    ),
    many(
      `SELECT a.tenant_id, to_char(a.day, 'YYYY-MM-DD') AS day, a.currency, a.source, a.type, a.status,
              count(*) AS n, coalesce(sum(a.price), 0) AS value
         FROM booking_ledger a JOIN tenants t ON t.id = a.tenant_id
        WHERE ${scope}
        GROUP BY 1, 2, 3, 4, 5, 6`,
      args,
    ),
  ]);
  return shapeReport({ tenants, orders, kinds, bookings }, range);
}
