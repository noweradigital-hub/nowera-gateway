import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { destinationStats } from './stats.js';
import { runChecks } from './checks.js';
import { open, seal } from './secrets.js';
import { backupCondition } from './backup.js';

/**
 * Problems worth a message: the gateway checks every few minutes and sends each
 * one to a webhook (an n8n workflow, which passes it on to e-mail or Slack) once
 * when it starts and once when it clears.
 */

export const RULES = {
  token: { title: 'Destinácia odmieta prístup', hint: 'Meta vráti chybu 190 alebo 2635 (neplatný token, zastaraná verzia API). Hlási sa hneď.' },
  failing: { title: 'Destinácia odmieta eventy', hint: 'Viac ako 5 % eventov za 30 minút zlyhalo (aspoň 5).' },
  no_events: { title: 'Žiadne eventy', hint: 'Klient nič nepošle 2 hodiny medzi 7:00 a 23:00.' },
  plugin_silent: { title: 'Plugin mlčí', hint: '24 hodín bez podpísaného eventu zo servera webu.' },
  site_down: { title: 'Collector nedostupný', hint: 'px.js sa nenačíta pri kontrole inštalácie (každých 15 minút).' },
  backup: { title: 'Záloha zlyhala', hint: '36 hodín bez úspešnej zálohy databázy (len keď sú zálohy nastavené).' },
};

const DEFAULTS = { webhook_url: '', rules: Object.fromEntries(Object.keys(RULES).map((k) => [k, true])) };

export async function alertSettings() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'alerts'`);
  const value = row?.value || {};
  // The webhook path is as good as a password to whoever can post to n8n.
  return { ...DEFAULTS, ...value, webhook_url: open(value.webhook_url || ''), rules: { ...DEFAULTS.rules, ...(value.rules || {}) } };
}

export async function saveAlertSettings(value) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('alerts', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [JSON.stringify({ ...value, webhook_url: seal(value.webhook_url || '') })],
  );
}

/** Only https URLs; the admin types this, but it is still where we POST. */
export function validWebhook(url) {
  try {
    const u = new URL(String(url || '').trim());
    return u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

const bratislavaHour = (now) => Number(new Date(now).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: 'Europe/Bratislava' }));
const KIND = { meta: 'Meta', ga4: 'GA4' };

/** Everything that is wrong right now, as { tenant_id, rule, subject, message }. */
export async function currentConditions({ now = Date.now(), siteChecks = true } = {}) {
  const tenants = await many(`SELECT * FROM tenants WHERE active`);
  const dests = await destinationStats(null);
  const recent = await many(
    `SELECT destination_id,
            count(*)::int AS total,
            count(*) FILTER (WHERE status = 'dead' OR (status = 'pending' AND attempts > 0))::int AS failing
       FROM events WHERE created_at > now() - interval '30 minutes' GROUP BY destination_id`);
  const out = [];
  const hour = bratislavaHour(now);

  for (const t of tenants) {
    for (const d of dests.filter((x) => x.tenant_id === t.id && x.active)) {
      const name = KIND[d.kind] || d.kind;
      if (d.tokenError) {
        const code = /\b2635\b/.test(String(d.last_error)) ? '2635 (zastaraná verzia API)' : '190 (neplatný token)';
        out.push({ tenant_id: t.id, rule: 'token', subject: String(d.id), message: `${name} odmieta prístup, chyba ${code}.` });
        continue;
      }
      const r = recent.find((x) => x.destination_id === d.id);
      if (r && r.failing >= 5 && r.failing / r.total > 0.05) {
        out.push({ tenant_id: t.id, rule: 'failing', subject: String(d.id),
          message: `${name}: ${r.failing} z ${r.total} eventov za 30 minút zlyhalo. Posledná chyba: ${String(d.last_error || '').slice(0, 160)}` });
      }
    }

    const quietMs = t.last_event_at ? now - new Date(t.last_event_at).getTime() : null;
    if (t.first_event_at && quietMs !== null && quietMs > 2 * 3600_000 && hour >= 7 && hour < 23) {
      out.push({ tenant_id: t.id, rule: 'no_events', subject: '',
        message: `Žiadny event ${Math.floor(quietMs / 3600_000)} h (posledný ${new Date(t.last_event_at).toLocaleString('sk-SK', { timeZone: 'Europe/Bratislava' })}).` });
    }

    if (t.plugin_version && t.plugin_seen_at && now - new Date(t.plugin_seen_at).getTime() > 24 * 3600_000) {
      out.push({ tenant_id: t.id, rule: 'plugin_silent', subject: '',
        message: `Plugin ${t.plugin_version} neposlal podpísaný event 24 hodín. Nevypol ho niekto, alebo nezmenil kľúč?` });
    }

    if (siteChecks) {
      const checks = await runChecks(t, dests.filter((x) => x.tenant_id === t.id)).catch(() => null);
      const https = checks?.items.find((i) => i.title === 'HTTPS');
      if (https && https.state === 'bad') {
        out.push({ tenant_id: t.id, rule: 'site_down', subject: '', message: `${t.collector_host}: ${https.text}` });
      }
    }
  }
  const backup = await backupCondition(now).catch(() => null);
  if (backup) out.push(backup);
  return out;
}

function payload(event, alert, tenant) {
  const base = `https://${config.adminHost}`;
  const tab = ['token', 'failing'].includes(alert.rule) ? 'destinacie' : alert.rule === 'site_down' ? 'instalacia' : '';
  const url = tenant ? `${base}/admin/tenants/${tenant.id}${tab ? `/${tab}` : ''}`
    : `${base}/admin/${alert.rule === 'backup' ? 'zalohy' : 'upozornenia'}`;
  const title = RULES[alert.rule]?.title || alert.rule;
  const mark = event === 'alert.resolved' ? 'Vyriešené' : event === 'alert.test' ? 'Skúška' : 'Problém';
  return {
    event,
    tenant: tenant ? { id: tenant.id, name: tenant.name, host: tenant.collector_host } : null,
    rule: alert.rule,
    title,
    message: alert.message,
    opened_at: alert.opened_at || null,
    resolved_at: alert.resolved_at || null,
    url,
    text: `${mark}${tenant ? ` · ${tenant.name}` : ''}: ${title}. ${alert.message} ${url}`,
  };
}

export async function sendWebhook(url, body, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

/**
 * Open alerts for new conditions, resolve the ones that cleared, and tell the
 * webhook about both. A failed webhook call is retried on the next round.
 */
export async function syncAlerts({ conditions, settings, fetchImpl = fetch, log } = {}) {
  const cfg = settings || await alertSettings();
  const wanted = (conditions || await currentConditions()).filter((c) => cfg.rules[c.rule] !== false);
  const open = await many(`SELECT * FROM alerts WHERE resolved_at IS NULL`);
  const key = (a) => `${a.tenant_id}|${a.rule}|${a.subject}`;
  const wantedKeys = new Set(wanted.map(key));

  for (const c of wanted) {
    if (open.some((a) => key(a) === key(c))) continue;
    await query(
      `INSERT INTO alerts (tenant_id, rule, subject, message) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, rule, subject) WHERE resolved_at IS NULL DO NOTHING`,
      [c.tenant_id, c.rule, c.subject, c.message],
    );
  }
  for (const a of open) {
    if (!wantedKeys.has(key(a))) await query(`UPDATE alerts SET resolved_at = now() WHERE id = $1`, [a.id]);
  }

  if (!cfg.webhook_url) return;
  const pending = await many(
    `SELECT a.*, t.name, t.collector_host FROM alerts a LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE (a.notified_at IS NULL AND a.resolved_at IS NULL)
         OR (a.resolved_at IS NOT NULL AND a.notified_at IS NOT NULL AND a.resolved_notified_at IS NULL)
      ORDER BY a.id LIMIT 20`);
  for (const a of pending) {
    const tenant = a.tenant_id ? { id: a.tenant_id, name: a.name, collector_host: a.collector_host } : null;
    const resolved = Boolean(a.resolved_at);
    try {
      await sendWebhook(cfg.webhook_url, payload(resolved ? 'alert.resolved' : 'alert.opened', a, tenant), fetchImpl);
      await query(resolved ? 'UPDATE alerts SET resolved_notified_at = now() WHERE id = $1'
        : 'UPDATE alerts SET notified_at = now() WHERE id = $1', [a.id]);
    } catch (err) {
      log?.warn({ err: err.message, alert: a.id }, 'alert webhook failed');
      break; // the endpoint is down; try again next round
    }
  }
}

export async function testWebhook(url, fetchImpl = fetch) {
  await sendWebhook(url, payload('alert.test', {
    rule: 'test', message: 'Upozornenia z Nowera Gateway fungujú.', opened_at: new Date().toISOString(),
  }, null), fetchImpl);
}

export async function openAlertCount() {
  const row = await one(`SELECT count(*)::int AS n FROM alerts WHERE resolved_at IS NULL`);
  return row?.n || 0;
}

export async function alertHistory(limit = 60) {
  return many(
    `SELECT a.*, t.name AS tenant_name FROM alerts a LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.opened_at > now() - interval '30 days' ORDER BY a.resolved_at IS NULL DESC, a.opened_at DESC LIMIT $1`, [limit]);
}

/** Check every two minutes; network checks of the sites every fifteen. */
export function startAlerts(log) {
  let busy = false;
  let lastSiteCheck = 0;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const siteChecks = Date.now() - lastSiteCheck > 15 * 60_000;
      if (siteChecks) lastSiteCheck = Date.now();
      const conditions = await currentConditions({ siteChecks });
      // Without the site checks this round, keep any site_down alert as it is.
      if (!siteChecks) {
        const open = await many(`SELECT tenant_id, rule, subject, message FROM alerts WHERE resolved_at IS NULL AND rule = 'site_down'`);
        conditions.push(...open);
      }
      await syncAlerts({ conditions, log });
    } catch (err) {
      log.error({ err }, 'alert round failed');
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 120_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
