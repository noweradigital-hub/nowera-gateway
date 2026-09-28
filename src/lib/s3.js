import { createHash, createHmac } from 'node:crypto';

/**
 * The few S3 calls backups need, signed with AWS Signature Version 4, so any
 * S3-compatible storage works: Cloudflare R2, Backblaze B2, Hetzner, AWS itself.
 * Path-style URLs (endpoint/bucket/key), which all of them accept.
 */

const sha256 = (data) => createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => createHmac('sha256', key).update(data).digest();

// RFC 3986 as S3 expects it: every character but the unreserved ones is escaped.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/**
 * Sign one request: the headers to send (Authorization included), plus the
 * canonical request and signature for tests. `body` is a string or Buffer.
 */
export function signRequest({ method, url, region, accessKeyId, secretAccessKey, body = '', headers = {}, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const payloadHash = lower['x-amz-content-sha256'] || sha256(body);
  const all = { ...lower, host: u.host, 'x-amz-date': amzDate, 'x-amz-content-sha256': payloadHash };
  const names = Object.keys(all).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(all[n]).trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalUri = u.pathname.split('/').map((seg) => enc(decodeURIComponent(seg))).join('/') || '/';
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => [enc(k), enc(v)])
    .sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : x > y ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`).join('&');
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${day}/${region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');
  const out = { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}` };
  delete out.host; // fetch sets it from the URL
  return { headers: out, canonicalRequest, signature };
}

const unxml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, name) => unxml((xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)) || [])[1] || '');

/** A client for one bucket. */
export function bucket({ endpoint, region = 'auto', bucket: name, accessKeyId, secretAccessKey }, fetchImpl = fetch) {
  const base = `${String(endpoint).replace(/\/+$/, '')}/${enc(name)}`;
  const keyPath = (key) => key.split('/').map(enc).join('/');

  async function call(method, key, { query = {}, body = '', headers = {}, timeout = 120_000 } = {}) {
    const url = new URL(key ? `${base}/${keyPath(key)}` : base);
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) url.searchParams.set(k, v);
    const { headers: signed } = signRequest({ method, url: url.toString(), region, accessKeyId, secretAccessKey, body, headers });
    const res = await fetchImpl(url, { method, headers: signed, body: method === 'GET' || method === 'DELETE' ? undefined : body, signal: AbortSignal.timeout(timeout) });
    if (!res.ok && !(method === 'DELETE' && res.status === 404)) {
      const text = await res.text().catch(() => '');
      const code = tag(text, 'Code');
      const message = tag(text, 'Message');
      throw new Error(`${method} ${res.status}${code ? ` ${code}` : ''}${message ? `: ${message}` : ''}`);
    }
    return res;
  }

  return {
    async put(key, body, contentType = 'application/octet-stream') {
      await call('PUT', key, { body, headers: { 'content-type': contentType } });
    },
    async get(key) {
      const res = await call('GET', key);
      return Buffer.from(await res.arrayBuffer());
    },
    async del(key) {
      await call('DELETE', key, { timeout: 30_000 });
    },
    /** Every object under a prefix: { key, size, modified }. */
    async list(prefix = '') {
      const out = [];
      let token;
      do {
        const res = await call('GET', '', { query: { 'list-type': '2', prefix, 'continuation-token': token }, timeout: 30_000 });
        const xml = await res.text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          out.push({ key: tag(m[1], 'Key'), size: Number(tag(m[1], 'Size')), modified: new Date(tag(m[1], 'LastModified')) });
        }
        token = tag(xml, 'IsTruncated') === 'true' ? tag(xml, 'NextContinuationToken') : null;
      } while (token);
      return out;
    },
  };
}
