import { BlockList, isIP } from 'node:net';

// Cloudflare's published edge ranges (https://www.cloudflare.com/ips/).
// A collector host proxied through Cloudflare reaches us from one of these, with
// the visitor's own address in CF-Connecting-IP. That is also how a visitor on
// IPv6 gets recorded with IPv6: the VPS itself is only reachable over IPv4.
const CLOUDFLARE_RANGES = [
  '173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
  '141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
  '197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
  '104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
  '2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
  '2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
];

const cloudflare = new BlockList();
for (const range of CLOUDFLARE_RANGES) {
  const [net, bits] = range.split('/');
  cloudflare.addSubnet(net, Number(bits), net.includes(':') ? 'ipv6' : 'ipv4');
}

export function fromCloudflare(ip) {
  const addr = String(ip || '').trim().replace(/^::ffff:/i, '');
  const family = isIP(addr);
  return family !== 0 && cloudflare.check(addr, family === 6 ? 'ipv6' : 'ipv4');
}

/** The visitor's address as the collector saw it. */
export function clientIp(req) {
  const hops = String(req.headers['x-forwarded-for'] || '')
    .split(',').map((h) => h.trim()).filter(Boolean);

  // The last hop is whoever connected to Traefik. Only when that is a Cloudflare
  // edge is CF-Connecting-IP believed; anyone else could have typed it.
  const cf = String(req.headers['cf-connecting-ip'] || '').trim();
  if (cf && isIP(cf) && fromCloudflare(hops.length ? hops[hops.length - 1] : req.ip)) return cf;

  // Traefik terminates TLS and sets X-Forwarded-For; take the original client.
  return hops.length ? hops[0] : req.ip;
}
