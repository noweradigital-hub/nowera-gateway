import { query } from '../db.js';

/**
 * What the dashboard counts, written in batches so a busy collector does one
 * insert every few seconds instead of one per request:
 * - `received`: one row of flags per accepted event, no personal data;
 * - `daily_counters`: requests that never became events (bots, floods, ...);
 * - when a tenant last sent anything, and which plugin version signs its events.
 */

const has = (v) => v !== undefined && v !== null && v !== '';

let rows = [];
let counters = new Map(); // "tenant|day|name" -> n
let touched = new Map(); // tenant id -> { at, plugin, pluginAt }

const today = () => new Date().toISOString().slice(0, 10);

/** Remember an accepted event. `source` is 'browser' (/e) or 'server' (/s). */
export function recordReceived(tenantId, event, source) {
  const user = event.user || {};
  const ctx = event.context || {};
  const props = event.properties || {};
  const value = Number(props.value);
  const consent = event.consent
    ? (event.consent.marketing === true ? 'marketing' : event.consent.statistics === true ? 'statistics' : null)
    : null;
  rows.push([
    tenantId, event.event_name, event.event_id, source, consent,
    has(user.em), has(user.ph), has(user.external_id), has(ctx.fbp), has(ctx.fbc), has(ctx.ip), has(user.country),
    Number.isFinite(value) && has(props.value) ? value : null,
    typeof props.currency === 'string' ? props.currency.slice(0, 3).toUpperCase() : null,
  ]);
  touch(tenantId);
}

/** Count something that did not become an event: 'bot', 'rate_limited', 'server_only'. */
export function countDropped(tenantId, name) {
  const key = `${tenantId}|${today()}|${name}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

/** A signed request from the tenant's plugin, with the version it reported. */
export function notePlugin(tenantId, version) {
  const t = touch(tenantId);
  if (typeof version === 'string' && /^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(version)) {
    t.plugin = version;
    t.pluginAt = new Date();
  }
}

function touch(tenantId) {
  const t = touched.get(tenantId) || {};
  t.at = new Date();
  touched.set(tenantId, t);
  return t;
}

const COLUMNS = 14;

export async function flushStats() {
  const batch = rows;
  const counts = counters;
  const touches = touched;
  rows = [];
  counters = new Map();
  touched = new Map();

  if (batch.length) {
    const params = [];
    const values = batch.map((row, i) => {
      params.push(...row);
      return `(${row.map((_, j) => `$${i * COLUMNS + j + 1}`).join(', ')})`;
    });
    await query(
      `INSERT INTO received (tenant_id, event_name, event_id, source, consent,
         has_em, has_ph, has_ext, has_fbp, has_fbc, has_ip, has_country, value, currency)
       VALUES ${values.join(', ')}`,
      params,
    );
  }

  for (const [key, n] of counts) {
    const [tenantId, day, name] = key.split('|');
    await query(
      `INSERT INTO daily_counters (tenant_id, day, name, count) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, day, name) DO UPDATE SET count = daily_counters.count + EXCLUDED.count`,
      [Number(tenantId), day, name, n],
    );
  }

  for (const [tenantId, t] of touches) {
    await query(
      `UPDATE tenants SET last_event_at = GREATEST(COALESCE(last_event_at, $2), $2),
              first_event_at = COALESCE(first_event_at, $2),
              plugin_version_since = CASE WHEN $3::text IS NOT NULL AND plugin_version IS DISTINCT FROM $3::text
                                          THEN COALESCE($4, $2) ELSE plugin_version_since END,
              plugin_version = COALESCE($3, plugin_version),
              plugin_seen_at = COALESCE($4, plugin_seen_at)
        WHERE id = $1`,
      [tenantId, t.at, t.plugin || null, t.pluginAt || null],
    );
  }
  return batch.length;
}

/** Flush every few seconds; returns a stop function that flushes once more. */
export function startStatsWriter(log, intervalMs = 5000) {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await flushStats();
    } catch (err) {
      log.error({ err }, 'stats flush failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(run, intervalMs);
  const retention = setInterval(() => {
    query(`DELETE FROM received WHERE created_at < now() - interval '90 days'`)
      .catch((err) => log.error({ err }, 'received retention failed'));
    // The completeness view looks two weeks back; a month is plenty to keep.
    query(`DELETE FROM order_audit WHERE day < now() - interval '35 days'`)
      .then(() => query(`DELETE FROM audit_snapshots WHERE day < now() - interval '35 days'`))
      .catch((err) => log.error({ err }, 'order audit retention failed'));
  }, 3600_000);
  return async () => {
    clearInterval(timer);
    clearInterval(retention);
    await run();
  };
}
