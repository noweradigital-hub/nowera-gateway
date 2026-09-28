import { resolve4, resolve6 } from 'node:dns/promises';
import { fromCloudflare } from './client-ip.js';
import { config } from '../config.js';
import { polls, routeOf } from './routing.js';
import { newer, pluginRelease } from './plugin-release.js';

/**
 * The installation checklist on a tenant's page: can a browser reach the
 * collector, does the site's plugin talk to us, is the setup the safe one.
 * Network checks take a second or two, so results are kept for ten minutes.
 */

const CACHE_MS = 10 * 60_000;
const cache = new Map(); // tenant id -> { at, value }

async function timed(fn) {
  const start = Date.now();
  try {
    const value = await fn();
    return { ok: true, value, ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: err.message || String(err), ms: Date.now() - start };
  }
}

/** The site's own origin: the first allowed origin, preferring www. */
export function siteOrigin(tenant) {
  const origins = String(tenant.allowed_origins || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origins.find((o) => /\/\/www\./.test(o)) || origins[0] || null;
}

const ago = (d) => (d ? (Date.now() - new Date(d).getTime()) / 3600_000 : null);

export async function runChecks(tenant, destinations, { force = false, fetchImpl = fetch } = {}) {
  const hit = cache.get(tenant.id);
  if (!force && hit && Date.now() - hit.at < CACHE_MS) return hit.value;

  const host = tenant.collector_host;
  const [v4, v6] = await Promise.all([
    resolve4(host).catch(() => []),
    resolve6(host).catch(() => []),
  ]);
  const proxied = v4.length > 0 && v4.every((ip) => fromCloudflare(ip));
  const dns = v4.length
    ? { state: 'ok', text: proxied
      ? `Za Cloudflare${v6.length ? ', IPv4 aj IPv6' : ', len IPv4'}.`
      : `Smeruje na ${v4.join(', ')}${v6.length ? ' a IPv6' : ''}.` }
    : { state: 'bad', text: `${host} sa nedá preložiť. Chýba DNS záznam ${host} → CNAME ${config.adminHost}.` };

  const px = await timed(async () => {
    const res = await fetchImpl(`https://${host}/px.js`, { signal: AbortSignal.timeout(5000) });
    const text = await res.text();
    if (!res.ok) {
      // Traefik's own answer for a host it has no router for.
      if (res.status === 404 && /404 page not found/.test(text)) throw new Error('server tento host zatiaľ nesmeruje');
      throw new Error(`HTTP ${res.status}`);
    }
  });
  const https = px.ok
    ? { state: 'ok', text: `Certifikát platí, px.js sa načíta za ${px.ms} ms.` }
    : { state: 'bad', text: `px.js sa nenačítal: ${px.error}.` };

  // Automatic routing is on once Traefik polls the collector list (see routing.js).
  const route = v4.length ? await routeOf(host).catch(() => null) : null;
  const polled = polls.last && Date.now() - polls.last.getTime() < 3 * 60_000;
  const routing = !route
    ? { state: 'bad', text: 'DNS zatiaľ nesmeruje na gateway (priamo ani cez Cloudflare), preto ho server nesmeruje.' }
    : polled
      ? { state: 'ok', text: route === 'cloudflare'
        ? 'Automaticky, cez Cloudflare (SSL režim Full).' : 'Automaticky, s certifikátom Let\'s Encrypt.' }
      : px.ok
        ? { state: 'ok', text: 'Z nastavenia servera (docker/compose.yml).' }
        : { state: 'warn', text: 'Automatické smerovanie ešte nie je zapnuté: host treba doplniť do docker/compose.yml a nasadiť.' };

  const pluginAge = ago(tenant.plugin_seen_at);
  const latest = pluginRelease()?.version;
  const behind = latest && tenant.plugin_version && newer(latest, tenant.plugin_version)
    ? ` Dostupná je ${latest}${newer('1.0.0', tenant.plugin_version) ? ' — túto verziu treba nainštalovať ručne, ďalšie sa už aktualizujú samy' : ' a nainštaluje sa sama'}.` : '';
  const plugin = tenant.plugin_version
    ? { state: pluginAge !== null && pluginAge < 48 ? 'ok' : 'warn',
      text: `Verzia ${tenant.plugin_version}, posledný podpísaný event ${formatAgo(tenant.plugin_seen_at)}.${behind}` }
    : { state: tenant.keep_path ? 'warn' : 'todo',
      text: tenant.keep_path ? 'Plugin sa zatiaľ neozval (alebo je starší ako 0.9.0).' : 'Web bez pluginu.' };

  const key = tenant.ingest_secret && tenant.legacy_ingest === false
    ? { state: 'ok', text: 'Vlastný kľúč, spoločný kľúč vypnutý.' }
    : tenant.ingest_secret
      ? { state: 'warn', text: 'Vlastný kľúč nastavený, spoločný kľúč ešte povolený.' }
      : { state: 'warn', text: 'Web podpisuje spoločným kľúčom všetkých klientov.' };

  const consentNames = { cookiescript: 'CookieScript', complianz: 'Complianz', custom: 'vlastný nástroj', none: null };
  const consentName = consentNames[tenant.consent_mode];
  const consent = consentName
    ? { state: 'ok', text: `${consentName}: eventy čakajú na rozhodnutie návštevníka.` }
    : { state: 'warn', text: 'Súhlas sa nekontroluje, eventy idú vždy.' };

  let keeper = { state: 'todo', text: 'Nie je nastavený (web bez pluginu).' };
  const origin = siteOrigin(tenant);
  if (tenant.keep_path && origin) {
    const res = await timed(async () => {
      const r = await fetchImpl(origin + tenant.keep_path, { signal: AbortSignal.timeout(5000), redirect: 'manual' });
      return r.status;
    });
    keeper = res.ok && res.value === 204
      ? { state: 'ok', text: `${tenant.keep_path} odpovedá 204.` }
      : { state: 'warn', text: `${tenant.keep_path} odpovedá ${res.ok ? res.value : res.error}.` };
  }

  const events = tenant.last_event_at
    ? { state: ago(tenant.last_event_at) < 6 ? 'ok' : 'warn', text: `Posledný event ${formatAgo(tenant.last_event_at)}.` }
    : { state: 'bad', text: 'Zatiaľ neprišiel žiadny event.' };

  const meta = destinations.find((d) => d.kind === 'meta');
  const ga4 = destinations.find((d) => d.kind === 'ga4');
  const metaCheck = !meta
    ? { state: 'todo', text: 'Nepridaná.' }
    : meta.settings?.verify_error
      ? { state: 'bad', text: `Overenie zlyhalo: ${meta.settings.verify_error}` }
      : meta.settings?.verified_at
        ? { state: 'ok', text: `Token overený ${formatAgo(meta.settings.verified_at)}.` }
        : { state: 'warn', text: 'Token ešte nebol overený.' };
  const ga4Check = ga4 ? { state: 'ok', text: 'Pridaná.' } : { state: 'todo', text: 'Nepridaná. Voliteľné.' };

  const value = {
    at: new Date(),
    items: [
      { title: `DNS záznam ${host}`, ...dns },
      { title: 'Smerovanie na serveri', ...routing },
      { title: 'HTTPS', ...https },
      { title: 'Plugin Nowera CAPI', ...plugin },
      { title: 'Kľúč pre plugin', ...key },
      { title: 'Súhlas s cookies', ...consent },
      { title: 'Cookie keeper', ...keeper },
      { title: 'Eventy', ...events },
      { title: 'Meta', ...metaCheck },
      { title: 'GA4', ...ga4Check },
    ],
  };
  cache.set(tenant.id, { at: Date.now(), value });
  return value;
}

export function forgetChecks(tenantId) {
  cache.delete(tenantId);
}

export function formatAgo(d) {
  if (!d) return '—';
  const min = Math.round((Date.now() - new Date(d).getTime()) / 60_000);
  if (min < 1) return 'práve teraz';
  if (min < 60) return `pred ${min} min`;
  const h = Math.round(min / 60);
  if (h < 48) return `pred ${h} h`;
  return `pred ${Math.round(h / 24)} dňami`;
}
