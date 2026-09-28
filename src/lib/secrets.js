import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config.js';

/**
 * Secrets stored in the database — destination tokens, the sites' signing keys,
 * authenticator secrets, the alert webhook, backup credentials — are sealed with
 * AES-256-GCM under a key that lives only in the server's environment, so a leaked
 * dump or backup does not hand out access to every client's Meta dataset.
 *
 * The key is SECRETS_KEY when set; otherwise it is derived from SESSION_SECRET,
 * which needs no new variable on an existing server. Every sealed value names the
 * key it was sealed with, so a server can hold the old key next to a new one and
 * re-seal at startup. The recovery key shown under Zálohy is the current key;
 * set as SECRETS_KEY on a new server, it opens a restored backup.
 */

const PREFIX = 'enc:v1:';
const RECOVERY_PREFIX = 'nwrk1_';

const fingerprint = (key) => createHash('sha256').update(key).digest('hex').slice(0, 8);

/** SECRETS_KEY as printed by the dashboard, as base64, or as 64 hex characters. */
export function parseKey(text) {
  const raw = String(text || '').trim();
  let key = null;
  if (raw.startsWith(RECOVERY_PREFIX)) key = Buffer.from(raw.slice(RECOVERY_PREFIX.length), 'base64url');
  else if (/^[0-9a-f]{64}$/i.test(raw)) key = Buffer.from(raw, 'hex');
  else if (raw) key = Buffer.from(raw, 'base64');
  if (!key || key.length !== 32) throw new Error('SECRETS_KEY must be 32 bytes (the recovery key from Zálohy, base64 or hex)');
  return key;
}

let ring = null;
let ringFrom = null;

/** The current key first, then any older one that may still open stored values. */
export function keyring() {
  const from = `${config.secretsKey}|${config.sessionSecret}`;
  if (ring && ringFrom === from) return ring;
  const keys = [];
  if (config.secretsKey) keys.push(parseKey(config.secretsKey));
  if (config.sessionSecret) {
    keys.push(Buffer.from(hkdfSync('sha256', config.sessionSecret, 'nowera-gateway', 'secrets v1', 32)));
  }
  ring = keys.map((key) => ({ key, kid: fingerprint(key) }));
  ringFrom = from;
  return ring;
}

function primary() {
  const k = keyring()[0];
  if (!k) throw new Error('no key for secrets: set SESSION_SECRET or SECRETS_KEY');
  return k;
}

export const isSealed = (value) => typeof value === 'string' && value.startsWith(PREFIX);

const kidOf = (value) => value.slice(PREFIX.length, PREFIX.length + 8);

/** Whether a stored value is sealed with the current key (nothing to redo). */
export const sealedWithCurrent = (value) => isSealed(value) && kidOf(value) === primary().kid;

/** Encrypt a secret for storage. Empty values and already current ones stay as they are. */
export function seal(value) {
  if (value === null || value === undefined || value === '') return value;
  if (sealedWithCurrent(value)) return value;
  const plain = isSealed(value) ? open(value) : String(value);
  const { key, kid } = primary();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return `${PREFIX}${kid}:${Buffer.concat([iv, body]).toString('base64url')}`;
}

/** The secret behind a stored value. Values stored before sealing pass through. */
export function open(value) {
  if (!isSealed(value)) return value;
  const kid = kidOf(value);
  const entry = keyring().find((k) => k.kid === kid);
  if (!entry) throw new Error(`secret sealed with an unknown key (${kid}); is SECRETS_KEY or SESSION_SECRET different from before?`);
  const data = Buffer.from(value.slice(PREFIX.length + 9), 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', entry.key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString('utf8');
}

/** A separate key for one purpose (e.g. backups), derived from the current key. */
export function purposeKey(purpose, from = primary()) {
  return { key: Buffer.from(hkdfSync('sha256', from.key, 'nowera-gateway', purpose, 32)), kid: from.kid };
}

/** The current key as the dashboard prints it for safekeeping. */
export const recoveryKey = () => RECOVERY_PREFIX + primary().key.toString('base64url');

/** Where the current key comes from, for the dashboard. */
export const keySource = () => (config.secretsKey ? 'SECRETS_KEY' : 'SESSION_SECRET');
