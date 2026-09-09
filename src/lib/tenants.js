import { many, one } from '../db.js';

const TTL_MS = 30_000;
const cache = new Map(); // host -> { at, value }

export function invalidateTenantCache(host) {
  if (host) cache.delete(host.toLowerCase());
  else cache.clear();
}

/** Look up an active tenant plus its active destinations by collector host. */
export async function tenantByHost(hostHeader) {
  if (!hostHeader) return null;
  const host = String(hostHeader).toLowerCase().split(':')[0];

  const hit = cache.get(host);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  const tenant = await one(
    `SELECT id, slug, name, collector_host, allowed_origins, cookie_domain
       FROM tenants
      WHERE lower(collector_host) = $1 AND active = TRUE`,
    [host],
  );
  let value = null;
  if (tenant) {
    tenant.destinations = await many(
      `SELECT id, kind, settings FROM destinations
        WHERE tenant_id = $1 AND active = TRUE`,
      [tenant.id],
    );
    value = tenant;
  }
  cache.set(host, { at: Date.now(), value });
  return value;
}

export function originAllowed(tenant, origin) {
  if (!origin) return false;
  const allowed = String(tenant.allowed_origins || '')
    .split(',')
    .map((s) => s.trim().toLowerCase().replace(/\/$/, ''))
    .filter(Boolean);
  return allowed.includes(origin.toLowerCase().replace(/\/$/, ''));
}
