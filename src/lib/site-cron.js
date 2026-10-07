import { lookup as dnsLookup } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { many, query } from '../db.js';
import { siteOrigin } from './checks.js';

/**
 * WordPress runs its scheduled tasks (WP-Cron, and through it Action Scheduler:
 * the plugin's purchase fallback after payment, retries, the order list) only
 * when a visit reaches PHP. Pages served from a page cache never do, and some
 * hosts switch WP-Cron off without a real cron in its place. So the gateway can
 * call the site's wp-cron.php itself every few minutes, per client.
 */

export const CRON_EVERY_MINUTES = 5;
// One site per tick: twenty sites fill the five minutes evenly, and sites on a
// shared PHP pool (kidvak .com/.cz/.pl) never start their jobs at once.
const TICK_MS = 15_000;
const TIMEOUT_MS = 20_000;
// A plugin report older than this says nothing about the scheduler today.
const REPORT_FRESH_MS = 8 * 3600_000;

/**
 * The address to call: the configured one, or wp-cron.php on the site. Only an
 * https address on one of the client's own allowed origins is used, so the
 * setting cannot point the gateway at anything else.
 */
export function cronUrl(tenant) {
  const origins = String(tenant.allowed_origins || '').split(',').map((s) => s.trim()).filter(Boolean);
  const fallback = siteOrigin(tenant) ? `${siteOrigin(tenant)}/wp-cron.php` : null;
  const raw = String(tenant.cron_url || '').trim() || fallback;
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !origins.includes(url.origin) || !/\/wp-cron\.php$/.test(url.pathname)) return null;
  return `${url.origin}${url.pathname}`;
}

/** Whether an address is one the gateway may call: not loopback, private or link-local. */
export function publicAddress(ip) {
  const v = isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return !(a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x.startsWith('::ffff:')) return publicAddress(x.slice(7));
    return !(x === '::1' || x === '::' || x.startsWith('fc') || x.startsWith('fd') || x.startsWith('fe8') || x.startsWith('fe9')
      || x.startsWith('fea') || x.startsWith('feb') || x.startsWith('ff'));
  }
  return false;
}

/** What the settings form may store: a clean address on the client's site, or null (the default). */
export function normalizeCronUrl(value, tenant) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  return cronUrl({ ...tenant, cron_url: text });
}

/** Calls one site's WP-Cron and says how it went, in a line for the dashboard. */
/**
 * DNS lookup for the call itself: the name must resolve to public addresses
 * only, checked on the very lookup the connection uses (no second resolution
 * that could answer differently).
 */
export function publicLookup(hostname, options, callback) {
  dnsLookup(hostname, { all: true }, (err, addrs) => {
    if (err) return callback(err);
    if (!addrs.length || !addrs.every((a) => publicAddress(a.address))) {
      const e = new Error('Adresa webu nevedie na verejnú IP.');
      e.code = 'ENOTPUBLIC';
      return callback(e);
    }
    if (options && options.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

/** A GET over https that connects only to public addresses; resolves like fetch would, minimally. */
export function guardedGet(url, { headers = {}, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { method: 'GET', headers, lookup: publicLookup, timeout: timeoutMs }, (res) => {
      res.resume(); // the answer is empty; nothing to read
      resolve({ status: res.statusCode, headers: { get: (n) => res.headers[String(n).toLowerCase()] ?? null } });
    });
    req.on('timeout', () => { const e = new Error('timeout'); e.name = 'TimeoutError'; req.destroy(e); });
    req.on('error', reject);
    req.end();
  });
}

export async function runSiteCron(tenant, fetchImpl = null, now = Date.now()) {
  const url = cronUrl(tenant);
  if (!url) return { ok: false, text: 'Adresa nie je wp-cron.php na webe klienta (https).' };
  const started = Date.now();
  try {
    // No doing_wp_cron: WordPress only honours one that matches its own lock, and
    // takes a call without it as an external cron. The extra parameter keeps a
    // cache from answering instead of WordPress.
    // Redirects are not followed (https.request never does).
    const get = fetchImpl || ((u, o) => guardedGet(u, o));
    const res = await get(`${url}?nwr=${Math.floor(now / 1000)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NoweraGateway-Cron/1.0; +https://nowera.sk)', 'cache-control': 'no-cache' },
    });
    const ms = Date.now() - started;
    const header = (n) => (typeof res.headers?.get === 'function' ? res.headers.get(n) : null);
    if (header('cf-mitigated') === 'challenge') return { ok: false, text: 'Cloudflare volanie zablokoval (challenge) — povoľte ho vo WAF.' };
    return res.status >= 200 && res.status < 300
      ? { ok: true, text: `HTTP ${res.status}, ${ms} ms` }
      : { ok: false, text: `HTTP ${res.status}${res.status >= 300 && res.status < 400 ? ' (presmerovanie — zadajte presnú adresu)' : ''}` };
  } catch (err) {
    return { ok: false, text: err.name === 'TimeoutError' ? `neodpovedal do ${TIMEOUT_MS / 1000} s` : err.code === 'ENOTPUBLIC' ? err.message : `${err.code || ''} ${err.message}`.trim() };
  }
}

/** Every 15 seconds: the client whose turn it is, if any. */
export function startSiteCron(log, { fetchImpl = null } = {}) {
  let busy = false;
  const round = async () => {
    if (busy) return;
    busy = true;
    try {
      const due = await many(
        `SELECT * FROM tenants
          WHERE active AND cron_enabled
            AND (cron_last_at IS NULL OR cron_last_at < now() - ($1 || ' minutes')::interval)
          ORDER BY cron_last_at NULLS FIRST LIMIT 1`,
        [String(CRON_EVERY_MINUTES)],
      );
      for (const t of due) {
        const result = await runSiteCron(t, fetchImpl);
        await query(
          `UPDATE tenants SET cron_last_at = now(), cron_last_ok = $2, cron_last_status = $3,
                  cron_ok_at = CASE WHEN $2 THEN now() ELSE cron_ok_at END
            WHERE id = $1`,
          [t.id, result.ok, result.text.slice(0, 200)],
        );
        if (!result.ok) log.warn({ tenant: t.id, status: result.text }, 'site cron failed');
      }
    } catch (err) {
      log.error({ err }, 'site cron round failed');
    } finally {
      busy = false;
    }
  };
  const timer = setInterval(round, TICK_MS);
  return () => clearInterval(timer);
}

/**
 * The install check line for the scheduler. A successful call only proves that
 * WordPress answered; whether the plugin's tasks run on time comes from the
 * plugin's own report (sent with the order list), as long as it is recent.
 */
export function cronCheck(tenant, now = Date.now()) {
  const r = tenant.cron_report || null;
  const fresh = r && r.at && now - new Date(r.at).getTime() < REPORT_FRESH_MS ? r : null;
  const late = fresh && fresh.due > 0
    ? ` Plugin ale hlási ${fresh.due} úloh po termíne (najstaršia ${Math.round(fresh.oldest / 60)} min).` : '';
  if (tenant.cron_enabled) {
    if (!tenant.cron_last_at) return { state: 'todo', text: 'Gateway ho zavolá do pár minút.' };
    if (!tenant.cron_last_ok) return { state: 'bad', text: `Gateway WP-Cron nezavolal: ${tenant.cron_last_status}.` };
    const minutes = Math.round((now - new Date(tenant.cron_ok_at || tenant.cron_last_at).getTime()) / 60_000);
    const calls = `Gateway volá wp-cron.php každých ${CRON_EVERY_MINUTES} min, naposledy pred ${minutes} min (${tenant.cron_last_status}).`;
    if (minutes > 3 * CRON_EVERY_MINUTES) return { state: 'warn', text: calls };
    if (late) return { state: 'warn', text: calls + late };
    // WordPress answering is not yet the tasks running: that the plugin confirms.
    if (!fresh) return { state: 'todo', text: `${calls} Či úlohy pluginu bežia načas, potvrdí plugin 1.2+ so zoznamom objednávok.` };
    return { state: 'ok', text: `${calls} Úlohy pluginu nemeškajú.` };
  }
  if (fresh && fresh.due > 0) {
    return { state: fresh.disabled ? 'bad' : 'warn', text: `Na webe čaká ${fresh.due} úloh pluginu po termíne${fresh.disabled ? ' a WP-Cron je vypnutý (DISABLE_WP_CRON)' : ''}. Zapnite spúšťanie WP-Cron z gatewaya v Nastaveniach.` };
  }
  if (fresh) {
    return { state: 'ok', text: fresh.disabled ? 'WP-Cron spúšťa server webu (DISABLE_WP_CRON), úlohy pluginu nemeškajú.' : 'Úlohy pluginu nemeškajú.' };
  }
  return { state: 'warn', text: 'Nevieme, či plánovač na webe beží (plugin 1.2+ to hlási so zoznamom objednávok). Ak web nemá skutočný cron, zapnite spúšťanie z gatewaya v Nastaveniach.' };
}
