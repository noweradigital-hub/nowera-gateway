import { resolve4 } from 'node:dns/promises';
import { config } from '../config.js';

/**
 * A new client from just the address of their website: the collector host, the
 * allowed origins and the cookie domain follow from it, and the consent tool is
 * recognised from the site's HTML.
 */

// Second-level suffixes under which the registrable domain has three labels.
const MULTI_PART = new Set(['co.uk', 'org.uk', 'com.pl', 'net.pl', 'org.pl', 'com.au', 'co.at', 'or.at', 'com.hr', 'co.hu', 'com.ua', 'com.ro', 'com.cy']);

/** The site's address as typed ("www.klient.sk", "https://shop.klient.sk/") → derived settings, or null. */
export function deriveFromSite(site) {
  const raw = String(site || '').trim();
  if (!raw) return null;
  let url;
  try { url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(host)) return null;
  const labels = host.split('.');
  const keep = MULTI_PART.has(labels.slice(-2).join('.')) ? 3 : 2;
  const domain = labels.slice(-keep).join('.');
  const origins = [`https://${domain}`, `https://www.${domain}`];
  if (!origins.includes(`https://${host}`)) origins.push(`https://${host}`);
  return {
    host,
    domain,
    slug: labels.slice(-keep)[0].replace(/[^a-z0-9-]/g, '-').slice(0, 40),
    collector_host: `t.${domain}`,
    allowed_origins: origins.join(','),
    cookie_domain: `.${domain}`,
    site_url: `https://${host}`,
  };
}

/** Recognise the consent tool from the site's front page. `null` when the page cannot be read. */
export async function detectConsent(siteUrl, fetchImpl = fetch) {
  let html;
  try {
    const res = await fetchImpl(siteUrl, {
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; NoweraGateway/1.0; +https://nowera.sk)' },
      signal: AbortSignal.timeout(6000),
    });
    html = (await res.text()).slice(0, 1_500_000);
  } catch {
    return null;
  }
  if (/faz-cookie-manager|fazcookie-consent|fazConfig/i.test(html)) return 'faz';
  if (/cookie-script\.com|CookieScript/i.test(html)) return 'cookiescript';
  if (/complianz|cmplz[-_]/i.test(html)) return 'complianz';
  return 'none';
}

let serverIp = { at: 0, value: null };

/** The address clients point their collector host at: where the dashboard host resolves. */
export async function gatewayIp() {
  if (Date.now() - serverIp.at < 3600_000 && serverIp.value) return serverIp.value;
  const ips = await resolve4(config.adminHost).catch(() => []);
  serverIp = { at: Date.now(), value: ips[0] || null };
  return serverIp.value;
}

/**
 * Host and key in one string for the plugin's settings, so nobody types the
 * host wrong or pastes the key into the host field. Shown once, like the key.
 */
export const pairingCode = (host, key) => `nwr1.${Buffer.from(JSON.stringify({ h: host, k: key })).toString('base64url')}`;

export function readPairingCode(code) {
  const m = /^nwr1\.([A-Za-z0-9_-]+)$/.exec(String(code || '').trim());
  if (!m) return null;
  try {
    const { h, k } = JSON.parse(Buffer.from(m[1], 'base64url').toString('utf8'));
    return typeof h === 'string' && typeof k === 'string' ? { host: h, key: k } : null;
  } catch {
    return null;
  }
}
