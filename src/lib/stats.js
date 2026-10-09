import { many, one, query } from '../db.js';
import { testModeActive } from '../destinations/test-mode.js';

/**
 * What the dashboard shows, read from `received` (one row per accepted event),
 * `events` (one row per delivery to a destination) and `daily_counters`.
 * Days are Bratislava days, so "today" means the same thing to everyone here.
 */

const TZ = 'Europe/Bratislava';

/** The last `n` calendar days as YYYY-MM-DD, oldest first. */
export function lastDays(n, now = new Date()) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400_000);
    out.push(d.toLocaleDateString('sv-SE', { timeZone: TZ }));
  }
  return out;
}

/** Slovak noun forms by count: 1 event, 2 eventy, 5 eventov. */
export function plural(n, one, few, many) {
  const x = Math.abs(n);
  return `${n} ${x === 1 ? one : x >= 2 && x <= 4 ? few : many}`;
}

const dayKey = (d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** Delivery figures per destination over the last 24 hours, plus its last error. */
async function destinationStats(tenantId) {
  const rows = await many(
    `SELECT d.id, d.tenant_id, d.kind, d.active, d.settings,
            s.sent, s.dead, s.retrying, s.p50, s.p95, s.last_success,
            le.last_error, le.error_at
       FROM destinations d
       LEFT JOIN LATERAL (
         SELECT count(*) FILTER (WHERE status = 'sent') AS sent,
                count(*) FILTER (WHERE status = 'dead') AS dead,
                count(*) FILTER (WHERE status = 'pending' AND attempts > 0) AS retrying,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at))
                  FILTER (WHERE status = 'sent') AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM sent_at - created_at))
                  FILTER (WHERE status = 'sent') AS p95,
                (SELECT max(e2.sent_at) FROM events e2
                  WHERE e2.destination_id = d.id AND e2.status = 'sent'
                    AND e2.created_at > now() - interval '30 days') AS last_success
           FROM events e
          WHERE e.destination_id = d.id AND e.created_at > now() - interval '24 hours'
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT e3.last_error, e3.created_at AS error_at FROM events e3
          WHERE e3.destination_id = d.id AND e3.last_error IS NOT NULL
            AND e3.created_at > now() - interval '7 days'
          ORDER BY e3.id DESC LIMIT 1
       ) le ON TRUE
      WHERE ($1::int IS NULL OR d.tenant_id = $1)
      ORDER BY d.id`,
    [tenantId ?? null],
  );
  return rows.map((r) => ({
    ...r,
    sent: Number(r.sent || 0),
    dead: Number(r.dead || 0),
    retrying: Number(r.retrying || 0),
    p50: r.p50 === null ? null : Number(r.p50),
    p95: r.p95 === null ? null : Number(r.p95),
    testing: testModeActive(r.settings),
    tokenError: /\b(190|2635)\b/.test(String(r.last_error || '')) &&
      (!r.last_success || new Date(r.last_success) < new Date(r.error_at)),
  }));
}

/**
 * How a tenant is doing, in one word. Bad: a destination refuses the events or
 * gave up on some in the last hour. Warning: retries pending, test mode, or the
 * site went quiet for longer than it usually does.
 */
export function healthOf(tenant, destinations, now = Date.now()) {
  const active = destinations.filter((d) => d.active);
  const reasons = [];
  let level = 'ok';
  const raise = (to, why) => {
    reasons.push(why);
    if (to === 'bad' || (to === 'warn' && level === 'ok')) level = to;
  };
  if (!tenant.active) return { level: 'off', reasons: ['klient je vypnutý'] };
  for (const d of active) {
    const name = d.kind === 'meta' ? 'Meta' : d.kind === 'ga4' ? 'GA4' : d.kind;
    const total = d.sent + d.dead + d.retrying;
    const failing = d.dead + d.retrying;
    // A single refused event is worth a look; a refusing destination is an outage.
    if (d.tokenError) raise('bad', `${name} odmieta prístup (neplatný token alebo verzia API)`);
    else if (failing >= 5 && failing / total > 0.05) raise('bad', `${name}: ${plural(failing, 'event zlyhal', 'eventy zlyhali', 'eventov zlyhalo')} za 24 h`);
    else if (d.dead > 0) raise('warn', `${name}: ${plural(d.dead, 'event sa nepodarilo', 'eventy sa nepodarilo', 'eventov sa nepodarilo')} doručiť`);
    else if (d.retrying > 0) raise('warn', `${name}: ${plural(d.retrying, 'event čaká', 'eventy čakajú', 'eventov čaká')} na opakovanie`);
    if (d.testing) raise('warn', `${name} je v testovacom režime`);
  }
  if (!active.length) raise('warn', 'žiadna aktívna destinácia');
  const quietHours = tenant.last_event_at ? (now - new Date(tenant.last_event_at).getTime()) / 3600_000 : null;
  if (quietHours === null) raise('warn', 'zatiaľ neprišiel žiadny event');
  else if (quietHours > 6) raise('warn', `posledný event pred ${Math.floor(quietHours)} h`);
  return { level, reasons };
}

/** Every tenant with its health, traffic and a 14-day trend: the overview page. */
export async function overview() {
  const tenants = await many(
    `SELECT id, name, collector_host, active, last_event_at, plugin_version, plugin_seen_at,
            legacy_ingest, (ingest_secret IS NOT NULL) AS has_key
       FROM tenants ORDER BY name`);
  const days = lastDays(14);
  const traffic = await many(
    `SELECT tenant_id, (created_at AT TIME ZONE '${TZ}')::date AS day, count(*)::int AS n
       FROM received WHERE created_at > now() - interval '15 days'
      GROUP BY 1, 2`);
  const recent = await many(
    `SELECT tenant_id,
            count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS n24,
            count(*) FILTER (WHERE created_at <= now() - interval '24 hours')::int AS n7
       FROM received WHERE created_at > now() - interval '8 days'
      GROUP BY 1`);
  const dests = await destinationStats(null);
  const bots = await many(
    `SELECT tenant_id, sum(count)::int AS n FROM daily_counters
      WHERE name = 'bot' AND day >= (now() AT TIME ZONE '${TZ}')::date - 1
      GROUP BY 1`);

  const byTenant = (list, id) => list.filter((r) => r.tenant_id === id);
  const rows = tenants.map((t) => {
    const series = days.map((d) => byTenant(traffic, t.id).find((r) => dayKey(r.day) === d)?.n || 0);
    const r = recent.find((x) => x.tenant_id === t.id) || { n24: 0, n7: 0 };
    const destinations = byTenant(dests, t.id);
    return {
      ...t,
      series,
      events24h: r.n24,
      avgDay: r.n7 / 7,
      errors24h: destinations.reduce((s, d) => s + d.dead + d.retrying, 0),
      destinations,
      health: healthOf(t, destinations),
    };
  });

  const sum = (f) => rows.reduce((s, r) => s + f(r), 0);
  const sent = sum((r) => r.destinations.reduce((s, d) => s + d.sent, 0));
  const failed = sum((r) => r.destinations.reduce((s, d) => s + d.dead + d.retrying, 0));
  const p50s = dests.filter((d) => d.p50 !== null).map((d) => d.p50).sort((a, b) => a - b);
  return {
    tenants: rows,
    totals: {
      events24h: sum((r) => r.events24h),
      avgDay: sum((r) => r.avgDay),
      delivered: sent + failed ? sent / (sent + failed) : null,
      waiting: failed,
      latency: p50s.length ? p50s[Math.floor(p50s.length / 2)] : null,
      bots: bots.reduce((s, b) => s + b.n, 0),
    },
  };
}

/** The tenant's own dashboard tab. */
export async function tenantOverview(tenantId) {
  const days = lastDays(14);
  const byDay = await many(
    `SELECT (created_at AT TIME ZONE '${TZ}')::date AS day, event_name, count(*)::int AS n
       FROM received WHERE tenant_id = $1 AND created_at > now() - interval '15 days'
      GROUP BY 1, 2`, [tenantId]);
  const names = [...new Set(byDay.map((r) => r.event_name))];
  const series = names.map((name) => ({
    name,
    values: days.map((d) => byDay.find((r) => r.event_name === name && dayKey(r.day) === d)?.n || 0),
  })).sort((a, b) => b.values.reduce((x, y) => x + y, 0) - a.values.reduce((x, y) => x + y, 0));

  const last24 = await one(
    `SELECT count(*)::int AS n,
            count(*) FILTER (WHERE source = 'browser')::int AS browser,
            count(*) FILTER (WHERE source = 'server')::int AS server,
            count(*) FILTER (WHERE consent = 'marketing')::int AS marketing,
            count(*) FILTER (WHERE consent = 'statistics')::int AS statistics,
            count(*) FILTER (WHERE consent IS NULL)::int AS unmanaged
       FROM received WHERE tenant_id = $1 AND created_at > now() - interval '24 hours'`, [tenantId]);
  const week = await one(
    `SELECT count(*) FILTER (WHERE created_at <= now() - interval '24 hours')::int AS n7
       FROM received WHERE tenant_id = $1 AND created_at > now() - interval '8 days'`, [tenantId]);
  // A purchase arrives from the browser and from the server with one event id;
  // count it once, preferring the server's figures.
  const purchases = await one(
    `SELECT count(*)::int AS n, COALESCE(sum(value), 0)::float AS value, max(currency) AS currency
       FROM (SELECT DISTINCT ON (event_id) event_id, value, currency FROM received
              WHERE tenant_id = $1 AND event_name = 'Purchase' AND created_at > now() - interval '7 days'
              ORDER BY event_id, (source = 'server') DESC) p`, [tenantId]);
  const paired = await one(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE b AND s)::int AS both
       FROM (SELECT event_id, bool_or(source = 'browser') AS b, bool_or(source = 'server') AS s
               FROM received WHERE tenant_id = $1 AND event_name = 'Purchase'
                AND created_at > now() - interval '7 days' GROUP BY event_id) x`, [tenantId]);
  const counters = await many(
    `SELECT name, sum(count)::int AS n FROM daily_counters
      WHERE tenant_id = $1 AND day >= (now() AT TIME ZONE '${TZ}')::date - 1 GROUP BY name`, [tenantId]);
  const destinations = await destinationStats(tenantId);
  const count = (name) => counters.find((c) => c.name === name)?.n || 0;

  return {
    days,
    series,
    last24,
    avgDay: week.n7 / 7,
    purchases,
    purchasePaired: paired.total ? paired.both / paired.total : null,
    dropped: { bot: count('bot'), rateLimited: count('rate_limited'), serverOnly: count('server_only') },
    destinations,
  };
}

export { destinationStats };

/**
 * Share of events carrying each match key, over the last `days` days, as Meta
 * receives them: statistics-only events carry no marketing identifiers by design
 * and never reach Meta, so they are left out of the percentages.
 */
export async function quality(tenantId, days = 7) {
  const rows = await many(
    `SELECT event_name, count(*)::int AS n,
            avg(has_em::int)::float AS em, avg(has_ph::int)::float AS ph, avg(has_ext::int)::float AS ext,
            avg(has_fbp::int)::float AS fbp, avg(has_fbc::int)::float AS fbc, avg(has_ip::int)::float AS ip,
            avg(has_country::int)::float AS country,
            count(*) FILTER (WHERE source = 'browser')::int AS browser,
            count(*) FILTER (WHERE source = 'server')::int AS server
       FROM received
      WHERE tenant_id = $1 AND created_at > now() - ($2 || ' days')::interval
        AND consent IS DISTINCT FROM 'statistics'
      GROUP BY event_name ORDER BY n DESC`, [tenantId, String(days)]);
  const pairs = await many(
    `SELECT event_name, count(*)::int AS total, count(*) FILTER (WHERE b AND s)::int AS both
       FROM (SELECT event_name, event_id, bool_or(source = 'browser') AS b, bool_or(source = 'server') AS s
               FROM received WHERE tenant_id = $1 AND created_at > now() - ($2 || ' days')::interval
              GROUP BY 1, 2) x
      GROUP BY event_name`, [tenantId, String(days)]);
  return rows.map((r) => {
    const p = pairs.find((x) => x.event_name === r.event_name);
    // Both legs only exist where the site's server sends the event and the page
    // fires it too; elsewhere the column would compare nothing.
    const bothKinds = r.browser > 0 && r.server > 0;
    return { ...r, paired: bothKinds && p?.total ? p.both / p.total : null };
  });
}

/** Plain-language notes on the quality table: what to fix, and what is normal. */
export function qualityFindings(rows) {
  const out = [];
  const get = (name) => rows.find((r) => r.event_name === name);
  const pct = (v) => `${Math.round(v * 100)} %`;
  const expectsBrowser = ['AddToCart', 'InitiateCheckout', 'Purchase'];
  for (const name of expectsBrowser) {
    const r = get(name);
    // A handful of checkouts in a week can all come from browsers that block
    // trackers; only a real sample without any browser leg says something.
    if (r && r.server >= 10 && r.browser === 0) {
      out.push({ tone: 'warn', event: name, title: 'Ide len zo servera.',
        text: 'Meta nevie porovnať pixel so serverom. Pomôže prehliadačová vetva s rovnakým event_id.' });
    }
  }
  const purchase = get('Purchase');
  if (purchase && purchase.fbc < 0.5) {
    out.push({ tone: 'info', event: 'Purchase', title: `Click ID pri ${pct(purchase.fbc)} nákupov.`,
      text: 'Majú ho len zákazníci, ktorí prišli z reklamy na Mete. Nie je to chyba.' });
  }
  if (purchase && purchase.ph < 0.9) {
    out.push({ tone: 'warn', event: 'Purchase', title: `Telefón len pri ${pct(purchase.ph)} nákupov.`,
      text: 'Skontrolujte, či je telefón v pokladni povinný.' });
  }
  const pv = get('PageView');
  if (pv && pv.em < 0.2) {
    out.push({ tone: 'info', event: 'PageView', title: `E-mail pri ${pct(pv.em)} eventov.`,
      text: 'Známi sú len zákazníci a tí, čo vyplnili formulár. Pri anonymnej návštevnosti normálne.' });
  }
  for (const r of rows) {
    if (r.n >= 20 && r.fbp < 0.9) {
      out.push({ tone: 'warn', event: r.event_name, title: `Browser ID (fbp) len pri ${pct(r.fbp)}.`,
        text: 'Cookie _fbp sa nedostane k eventu. Skontrolujte cookie doménu klienta.' });
    }
  }
  return out;
}

/** The event browser: deliveries, newest first, with filters. */
export async function eventList(tenantId, { name, status, source, period = '24h', q } = {}) {
  const interval = { '24h': '24 hours', '7d': '7 days', '30d': '30 days' }[period] || '24 hours';
  const search = typeof q === 'string' && q.trim() ? q.trim().slice(0, 100) : null;
  const like = search ? `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%` : null;
  const order = search && /^\d+$/.test(search) ? `ord-${search}` : null;
  return many(
    `SELECT e.id, e.tenant_id, t.name AS tenant_name, e.event_name, e.event_id, e.status, e.attempts,
            e.last_error, e.created_at, e.sent_at, e.source, d.kind
       FROM events e
       JOIN tenants t ON t.id = e.tenant_id
       LEFT JOIN destinations d ON d.id = e.destination_id
      WHERE ($1::int IS NULL OR e.tenant_id = $1)
        AND e.created_at > now() - $2::interval
        AND ($3::text IS NULL OR e.event_name = $3)
        AND ($4::text IS NULL OR e.status = $4)
        AND ($5::text IS NULL OR e.source = $5)
        AND ($6::text IS NULL OR e.event_id ILIKE $6 OR e.event_id = $7)
      ORDER BY e.id DESC LIMIT 200`,
    [tenantId ?? null, interval, name || null, status || null, source || null, like, order],
  );
}

export async function eventNames(tenantId) {
  const rows = await many(
    `SELECT DISTINCT event_name FROM received
      WHERE ($1::int IS NULL OR tenant_id = $1) AND created_at > now() - interval '30 days'
      ORDER BY 1`, [tenantId ?? null]);
  return rows.map((r) => r.event_name);
}

export async function eventDetail(id, tenantId) {
  return one(
    `SELECT e.*, d.kind, t.name AS tenant_name FROM events e
       JOIN tenants t ON t.id = e.tenant_id
       LEFT JOIN destinations d ON d.id = e.destination_id
      WHERE e.id = $1 AND ($2::int IS NULL OR e.tenant_id = $2)`, [id, tenantId ?? null]);
}

/** Put a failed delivery back in the queue, as if it had just arrived. */
export async function retryEvent(id) {
  const { rowCount } = await query(
    `UPDATE events SET status = 'pending', attempts = 0, next_attempt_at = now(), last_error = NULL
      WHERE id = $1 AND status = 'dead'`, [id]);
  return rowCount;
}
