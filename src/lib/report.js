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
 * Two kinds of key, both made in the administration and kept only as a hash:
 * one for all clients (Upozornenia → Reporty), and one per client (its
 * Nastavenia), which opens that client's figures alone.
 */

const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A day that exists (not 2026-02-30, which Date would quietly turn into March). */
const realDay = (s) => {
  const at = DAY.test(String(s ?? '')) ? Date.parse(`${s}T00:00:00Z`) : NaN;
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === String(s);
};
// How far back the plugin's first list reaches (its NOWERA_CAPI_BACKFILL_DAYS).
const BACKFILL_DAYS = 90;
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

/** Makes a client's own key (its old one stops working) and returns it; it is shown once. */
export async function newTenantReportKey(tenantId) {
  const key = `nwrt_${randomBytes(24).toString('base64url')}`;
  const row = await one(`UPDATE tenants SET report_key_hash = $2, report_key_at = now() WHERE id = $1 RETURNING id`, [tenantId, hash(key)]);
  return row ? key : null;
}

/** Takes a client's own key away. */
export async function dropTenantReportKey(tenantId) {
  await query(`UPDATE tenants SET report_key_hash = NULL, report_key_at = NULL WHERE id = $1`, [tenantId]);
}

/**
 * Whose figures a key opens: { all: true } for the key of all clients,
 * { tenant } for a client's own, null for anything else.
 */
export async function reportAccess(given) {
  if (typeof given !== 'string' || given.length < 20 || given.length > 200) return null;
  if (await reportKeyValid(given)) return { all: true };
  // Looked up by its hash: the key is long and random, so the hash says nothing about it.
  const tenant = await one(
    `SELECT id, slug, name, allowed_origins, plugin_version FROM tenants WHERE report_key_hash = $1 AND active`,
    [hash(given)],
  );
  return tenant ? { tenant } : null;
}

const iso = (date) => date.toISOString().slice(0, 10);
// The shops' days are local days; "today" for a request without dates is theirs.
const today = (now) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);

/** The days asked for: from and to (inclusive), by default the last seven up to today. */
export function parseRange(q = {}, now = new Date()) {
  for (const name of ['from', 'to']) {
    if (q[name] !== undefined && q[name] !== '' && !realDay(q[name])) throw new Error(`${name} must be a day (YYYY-MM-DD)`);
  }
  const to = q.to ? String(q.to) : today(now);
  const from = q.from ? String(q.from) : iso(new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86400_000));
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
              count(*) FILTER (WHERE a.ready AND a.bookings > 0 AND coalesce(a.kind, '') <> 'renewal') AS leads,
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

// ------------------------------------------------------------------ leads

const LEADS_DEFAULT_DAYS = 14;

/** The days of a leads request: since and until (inclusive); by default today and the fourteen days before it, as the plugin does. */
export function parseLeadRange(q = {}, now = new Date()) {
  for (const name of ['since', 'until']) {
    if (q[name] !== undefined && q[name] !== '' && !realDay(q[name])) {
      throw new Error(`${name} must be YYYY-MM-DD`);
    }
  }
  const until = q.until ? String(q.until) : today(now);
  const since = q.since ? String(q.since) : iso(new Date(Date.parse(`${until}T00:00:00Z`) - LEADS_DEFAULT_DAYS * 86400_000));
  const a = Date.parse(`${since}T00:00:00Z`);
  const b = Date.parse(`${until}T00:00:00Z`);
  if (b < a) throw new Error('until is before since');
  if ((b - a) / 86400_000 > MAX_DAYS) throw new Error(`range is limited to ${MAX_DAYS} days`);
  const group = ['day', 'week', 'month'].includes(String(q.group ?? 'day')) ? String(q.group ?? 'day') : null;
  if (!group) throw new Error('group must be day, week or month');
  const only = new Set(String(q.forms ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  return { since, until, group, only };
}

/** ISO week of a day, as "2026-W41". */
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const weekday = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - weekday); // the week's Thursday names its year
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((d.getTime() - yearStart) / 86400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** "service-5" of a booking plugin's own id "amelia-1083" → source "amelia", form id "5". */
function leadKey(bookingId, item) {
  const source = /^([a-z0-9]+)-/.exec(String(bookingId || ''))?.[1] || 'booking';
  const id = String(item || '').replace(/^service-/, '') || 'unknown';
  return { source, form_id: id, key: `${source}:${id}` };
}

/**
 * A client's leads per day in the shape of the nwr-lead-stats plugin's
 * /counts answer (total, days, forms[] with key, title, total, days,
 * complete_since), so the same report node reads either. A lead here is what
 * the site reported as one: a counted order that holds a booking — one per
 * order, under the service (or event) first booked on it, on the day the order
 * was placed. Bookings entered by staff have no order and are not leads.
 */
export function shapeLeads(rows, { tenant, range, first = null, now = new Date() }) {
  const days = {};
  for (let t = Date.parse(`${range.since}T00:00:00Z`); t <= Date.parse(`${range.until}T00:00:00Z`); t += 86400_000) days[iso(new Date(t))] = 0;
  const forms = new Map();
  let total = 0;
  for (const r of rows) {
    const { source, form_id: formId, key } = leadKey(r.booking_id, r.item);
    if (range.only.size && !range.only.has(key)) continue;
    if (!(r.day in days)) continue;
    const c = Number(r.c);
    days[r.day] += c;
    total += c;
    const f = forms.get(key) || { key, source, form_id: formId, title: '', total: 0, days: {}, complete_since: first };
    if (r.name && !f.title) f.title = r.name;
    f.total += c;
    f.days[r.day] = (f.days[r.day] || 0) + c;
    forms.set(key, f);
  }
  const bucket = (day) => (range.group === 'month' ? day.slice(0, 7) : isoWeek(day));
  const regroup = (map) => {
    if (range.group === 'day') return Object.fromEntries(Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1)));
    const out = {};
    for (const [day, c] of Object.entries(map).sort(([a], [b]) => (a < b ? -1 : 1))) out[bucket(day)] = (out[bucket(day)] || 0) + c;
    return out;
  };
  const origin = String(tenant.allowed_origins || '').split(/[\s,]+/).filter(Boolean)[0] || '';
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Bratislava', dateStyle: 'short', timeStyle: 'medium' }).format(now);
  return {
    site: origin ? `${origin.replace(/\/+$/, '')}/` : '',
    plugin: tenant.plugin_version || null,
    source: 'signals',
    timezone: 'Europe/Bratislava',
    since: range.since,
    until: range.until,
    group: range.group,
    live_since: first,
    generated_at: stamp,
    total,
    days: regroup(days),
    forms: [...forms.values()].map((f) => ({ ...f, days: regroup(f.days) })).sort((a, b) => b.total - a.total),
  };
}

/** The leads of one client for a range (see shapeLeads). */
export async function leadCounts(tenant, range) {
  const rows = await many(
    `SELECT to_char(a.day, 'YYYY-MM-DD') AS day, b.booking_id, b.item, b.name, count(*) AS c
       FROM order_audit a
       LEFT JOIN LATERAL (
         SELECT l.booking_id, l.item, l.name FROM booking_ledger l
          WHERE l.tenant_id = a.tenant_id AND l.order_id = a.order_id
          -- The first booked; ids are "<plugin>-<number>", so the shorter is the lower.
          ORDER BY l.created_at NULLS LAST, length(l.booking_id), l.booking_id LIMIT 1) b ON true
      WHERE a.tenant_id = $1 AND a.day BETWEEN $2::date AND $3::date
        AND a.ready AND a.bookings > 0 AND coalesce(a.kind, '') <> 'renewal'
      GROUP BY 1, 2, 3, 4`,
    [tenant.id, range.since, range.until],
  );
  // Counts are complete from where the plugin's first full list began: the days
  // before the first list that says what an order is. An older order in the
  // table (changed lately, so listed) does not make its year complete.
  const first = await one(
    `SELECT to_char(greatest(min(day), (min(reported_at) AT TIME ZONE 'Europe/Bratislava')::date - $2::int), 'YYYY-MM-DD') AS day
       FROM order_audit WHERE tenant_id = $1 AND kind IS NOT NULL`,
    [tenant.id, BACKFILL_DAYS],
  );
  return shapeLeads(rows, { tenant, range, first: first?.day || null });
}
