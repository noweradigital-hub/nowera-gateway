import { resolve4 } from 'node:dns/promises';
import { many } from '../db.js';
import { fromCloudflare } from './client-ip.js';
import { gatewayIp } from './onboarding.js';

/**
 * Collector hosts for Traefik (its HTTP provider polls this), so a new client
 * needs no change to the compose file and no redeploy.
 *
 * A host is listed only once its DNS points here — directly, or through
 * Cloudflare's proxy. Directly: Traefik gets a Let's Encrypt certificate over the
 * TLS-ALPN challenge. Behind Cloudflare that challenge never arrives, so the
 * router has no certificate resolver and Cloudflare (SSL mode Full) accepts the
 * default certificate. A host whose DNS is not ready yet stays out, so failed
 * challenges never count against the Let's Encrypt rate limit.
 */

const DNS_TTL_MS = 5 * 60_000;
const dnsCache = new Map(); // host -> { at, ips }

async function ipsOf(host, resolve) {
  const hit = dnsCache.get(host);
  if (hit && Date.now() - hit.at < DNS_TTL_MS) return hit.ips;
  const ips = await resolve(host).catch(() => []);
  dnsCache.set(host, { at: Date.now(), ips });
  return ips;
}

/** How a host reaches us: 'direct', 'cloudflare', or null while DNS points elsewhere. */
export async function routeOf(host, { resolve = resolve4, serverIp } = {}) {
  const ips = await ipsOf(host, resolve);
  if (!ips.length) return null;
  if (ips.every((ip) => fromCloudflare(ip))) return 'cloudflare';
  const own = serverIp ?? await gatewayIp();
  return own && ips.includes(own) ? 'direct' : null;
}

const routerName = (host) => `nwrgw-${host.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;

// Filled in by the Docker labels in docker/compose.yml (service nwrgw, resolver mytlschallenge).
const SERVICE = process.env.TRAEFIK_SERVICE || 'nwrgw@docker';
const RESOLVER = process.env.TRAEFIK_CERT_RESOLVER || 'mytlschallenge';

/** `tenants` and `resolve` are for tests; normally the active tenants and real DNS. */
export async function traefikConfig({ tenants, ...opts } = {}) {
  tenants ||= await many('SELECT collector_host FROM tenants WHERE active ORDER BY id');
  const routers = {};
  for (const { collector_host: host } of tenants) {
    if (!/^[a-z0-9.-]+$/i.test(host)) continue;
    const route = await routeOf(host.toLowerCase(), opts);
    if (!route) continue;
    routers[routerName(host)] = {
      rule: `Host(\`${host.toLowerCase()}\`)`,
      entryPoints: ['web', 'websecure'],
      service: SERVICE,
      tls: route === 'direct' ? { certResolver: RESOLVER } : {},
    };
  }
  return { http: { routers } };
}

/** When Traefik last asked, so the dashboard can tell whether automatic routing is on. */
export const polls = { last: null };

export function forgetDns(host) {
  if (host) dnsCache.delete(host.toLowerCase());
  else dnsCache.clear();
}
