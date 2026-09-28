#!/usr/bin/env node
/**
 * Release the WordPress plugin: build wp-plugin/releases/nowera-capi-<version>.zip,
 * sign it with the Ed25519 release key and point latest.json at it. The gateway
 * serves these files to the plugin's updater, which installs a release only when
 * its signature matches a public key built into the plugin — so neither a broken
 * into VPS nor the public repository can push code to client sites.
 *
 *   node scripts/release-plugin.mjs --init-key       create the key pair (once)
 *   node scripts/release-plugin.mjs --notes "…"      build and sign the current version
 *
 * The private key stays on this machine (~/.config/nowera-gateway/), outside the
 * repository. Keep a copy in the password manager: without it, the next release
 * has to be installed by hand on every site.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { crc32, deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'wp-plugin', 'nowera-capi');
const outDir = join(root, 'wp-plugin', 'releases');
const keyFile = join(homedir(), '.config', 'nowera-gateway', 'plugin-signing-key.pem');

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };

const publicKeyB64 = (priv) => Buffer.from(createPublicKey(priv).export({ format: 'jwk' }).x, 'base64url').toString('base64');

if (args.includes('--init-key')) {
  if (existsSync(keyFile)) {
    console.error(`${keyFile} already exists; not overwriting.`);
    process.exit(1);
  }
  mkdirSync(dirname(keyFile), { recursive: true, mode: 0o700 });
  const { privateKey } = generateKeyPairSync('ed25519');
  writeFileSync(keyFile, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
  chmodSync(keyFile, 0o600);
  console.log(`private key: ${keyFile}`);
  console.log(`public key (NOWERA_CAPI_RELEASE_KEYS): ${publicKeyB64(privateKey)}`);
  process.exit(0);
}

if (args.includes('--public-key')) {
  console.log(publicKeyB64(createPrivateKey(readFileSync(keyFile))));
  process.exit(0);
}

// ------------------------------------------------------------------ build

const source = readFileSync(join(pluginDir, 'nowera-capi.php'), 'utf8');
const version = (source.match(/^\s*\*\s*Version:\s*([0-9][0-9A-Za-z.-]*)\s*$/m) || [])[1];
const header = (name) => (source.match(new RegExp(`^\\s*\\*\\s*${name}:\\s*(.+?)\\s*$`, 'm')) || [])[1] || null;
if (!version) throw new Error('No Version: header in nowera-capi.php');
const constant = (source.match(/const NOWERA_CAPI_VERSION\s*=\s*'([^']+)'/) || [])[1];
if (constant !== version) throw new Error(`Version header ${version} and NOWERA_CAPI_VERSION ${constant} differ`);

const privateKey = createPrivateKey(readFileSync(keyFile));
const pub = publicKeyB64(privateKey);
if (!source.includes(pub)) throw new Error('The plugin does not list this release key in NOWERA_CAPI_RELEASE_KEYS; it would refuse the update.');

function files(dir) {
  return readdirSync(dir).filter((n) => !n.startsWith('.')).sort().flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

/** A plain ZIP (deflate), one top folder named like the plugin, as WordPress expects. */
function zip(entries, when) {
  const dosTime = (when.getUTCHours() << 11) | (when.getUTCMinutes() << 5) | (when.getUTCSeconds() >> 1);
  const dosDate = ((when.getUTCFullYear() - 1980) << 9) | ((when.getUTCMonth() + 1) << 5) | when.getUTCDate();
  const local = [];
  const central = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const isDir = e.name.endsWith('/');
    const data = isDir ? Buffer.alloc(0) : e.data;
    const packed = isDir ? data : deflateRawSync(data, { level: 9 });
    const method = !isDir && packed.length < data.length ? 8 : 0;
    const body = method === 8 ? packed : data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    local.push(lh, name, body);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(0x0314, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(method, 10); ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE((((isDir ? 0o40755 : 0o100644) << 16) | (isDir ? 0x10 : 0)) >>> 0, 38);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + body.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, end]);
}

const now = new Date();
const entries = [{ name: 'nowera-capi/' }, ...files(pluginDir).map((p) => ({
  name: `nowera-capi/${relative(pluginDir, p).split('\\').join('/')}`, data: readFileSync(p),
}))];
const archive = zip(entries, now);
const signature = sign(null, archive, privateKey).toString('base64');
const file = `nowera-capi-${version}.zip`;

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, file), archive);
writeFileSync(join(outDir, `${file}.sig`), `${signature}\n`);
const latest = {
  version,
  file,
  sha256: createHash('sha256').update(archive).digest('hex'),
  signature,
  released_at: now.toISOString(),
  requires: header('Requires at least'),
  requires_php: header('Requires PHP'),
  tested: header('Tested up to'),
  notes: arg('--notes') || '',
};
writeFileSync(join(outDir, 'latest.json'), `${JSON.stringify(latest, null, 2)}\n`);
console.log(`${file}: ${archive.length} bytes, ${entries.length - 1} files, sha256 ${latest.sha256}`);
