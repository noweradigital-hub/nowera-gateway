import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { many, one, pool, query } from '../db.js';
import { keyring, open, purposeKey, seal } from './secrets.js';
import { bucket } from './s3.js';

/**
 * Daily backups of the whole database to S3-compatible storage outside the VPS
 * (Cloudflare R2, Backblaze B2, …), encrypted before they leave the server.
 *
 * Format: gzip of JSON lines — a header, one line per row ({"t": table, "r": row
 * as Postgres serialises it}), a footer with row counts — sealed with AES-256-GCM
 * under a key derived from the secrets key. Restoring loads the rows into the
 * current schema, so a backup from an older version still restores after
 * migrations added columns.
 */

// Parents before children, so foreign keys hold while rows go back in.
export const TABLES = [
  { name: 'admin_users', key: 'id' },
  { name: 'tenants', key: 'id' },
  { name: 'destinations', key: 'id' },
  { name: 'app_settings', key: 'key' },
  { name: 'alerts', key: 'id' },
  { name: 'admin_audit', key: 'id' },
  { name: 'daily_counters', key: null },
  { name: 'received', key: 'id' },
  { name: 'events', key: 'id' },
];
// Sessions are not backed up: a restored server starts with everyone signed out.

const MAGIC = Buffer.from('NWRB');
const FORMAT = 1;
const PAGE = 2000;

// ------------------------------------------------------------------ dump

/** The database as gzip'd JSON lines. Returns { data, counts }. */
export async function createDump() {
  const gzip = createGzip({ level: 6 });
  const chunks = [];
  gzip.on('data', (c) => chunks.push(c));
  const finished = new Promise((resolve, reject) => { gzip.on('end', resolve); gzip.on('error', reject); });
  const write = (line) => new Promise((resolve) => { if (gzip.write(`${line}\n`)) resolve(); else gzip.once('drain', resolve); });

  const counts = {};
  await write(JSON.stringify({ nwr_backup: FORMAT, created_at: new Date().toISOString(), tables: TABLES.map((t) => t.name) }));
  for (const table of TABLES) {
    counts[table.name] = 0;
    if (!table.key || table.key !== 'id') {
      // Small tables without a numeric key: all at once.
      const rows = await many(`SELECT to_jsonb(t)::text AS r FROM ${table.name} t`);
      for (const row of rows) await write(`{"t":"${table.name}","r":${row.r}}`);
      counts[table.name] = rows.length;
      continue;
    }
    let after = 0;
    for (;;) {
      const rows = await many(`SELECT id, to_jsonb(t)::text AS r FROM ${table.name} t WHERE id > $1 ORDER BY id LIMIT ${PAGE}`, [after]);
      for (const row of rows) await write(`{"t":"${table.name}","r":${row.r}}`);
      counts[table.name] += rows.length;
      if (rows.length < PAGE) break;
      after = rows[rows.length - 1].id;
    }
  }
  await write(JSON.stringify({ end: true, counts }));
  gzip.end();
  await finished;
  return { data: Buffer.concat(chunks), counts };
}

// ------------------------------------------------------------------ encryption

/** MAGIC | format | key id (8) | iv (12) | ciphertext | tag (16) */
export function encryptBackup(data) {
  const { key, kid } = purposeKey('backup v1');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(data), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([FORMAT]), Buffer.from(kid, 'ascii'), iv, body, cipher.getAuthTag()]);
}

export function decryptBackup(file) {
  if (file.length < 41 || !file.subarray(0, 4).equals(MAGIC)) throw new Error('Toto nie je záloha Nowera Gateway.');
  if (file[4] !== FORMAT) throw new Error(`Neznámy formát zálohy (${file[4]}).`);
  const kid = file.subarray(5, 13).toString('ascii');
  const entry = keyring().find((k) => k.kid === kid);
  if (!entry) throw new Error(`Záloha je zašifrovaná iným kľúčom (${kid}). Nastavte SECRETS_KEY na kľúč na obnovu z pôvodného servera.`);
  const { key } = purposeKey('backup v1', entry);
  const decipher = createDecipheriv('aes-256-gcm', key, file.subarray(13, 25));
  decipher.setAuthTag(file.subarray(file.length - 16));
  try {
    return Buffer.concat([decipher.update(file.subarray(25, file.length - 16)), decipher.final()]);
  } catch {
    throw new Error('Zálohu sa nepodarilo rozšifrovať — je poškodená alebo upravená.');
  }
}

// ------------------------------------------------------------------ reading

/** Each line of a dump, parsed, without holding the unpacked text in memory. */
async function* lines(data) {
  const rl = createInterface({ input: Readable.from([data]).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield JSON.parse(line);
}

/** Read a whole backup without loading it: header, row counts, and whether it is complete. */
export async function inspectBackup(file) {
  const data = decryptBackup(file);
  let header = null;
  let footer = null;
  const counts = {};
  for await (const item of lines(data)) {
    if (item.nwr_backup) header = item;
    else if (item.end) footer = item;
    else counts[item.t] = (counts[item.t] || 0) + 1;
  }
  if (!header) throw new Error('Záloha nemá hlavičku.');
  if (!footer) throw new Error('Záloha je neúplná (chýba koniec).');
  for (const [table, n] of Object.entries(footer.counts)) {
    if ((counts[table] || 0) !== n) throw new Error(`Záloha je neúplná: ${table} má ${counts[table] || 0} z ${n} riadkov.`);
  }
  return { createdAt: header.created_at, counts: footer.counts };
}

// ------------------------------------------------------------------ restore

/**
 * Replace the whole database with a backup, in one transaction: either all of it
 * is restored or nothing changes. Only meant for an empty installation.
 */
export async function restoreBackup(file) {
  const data = decryptBackup(file);
  const client = await pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN');
    const cols = {};
    for (const t of TABLES) {
      const { rows } = await client.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1`, [t.name]);
      cols[t.name] = new Set(rows.map((r) => r.column_name));
    }
    await client.query(`TRUNCATE sessions, ${TABLES.map((t) => t.name).join(', ')} RESTART IDENTITY CASCADE`);

    let table = null;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      // Columns the backup has and the current schema knows; newer columns keep their defaults.
      const present = [...new Set(batch.flatMap((r) => Object.keys(r)))].filter((c) => cols[table].has(c));
      const list = present.map((c) => `"${c}"`).join(', ');
      await client.query(
        `INSERT INTO ${table} (${list}) SELECT ${list} FROM jsonb_populate_recordset(NULL::${table}, $1::jsonb)`,
        [JSON.stringify(batch)]);
      counts[table] = (counts[table] || 0) + batch.length;
      batch = [];
    };
    let complete = false;
    for await (const item of lines(data)) {
      if (item.nwr_backup) continue;
      if (item.end) { complete = true; break; }
      if (!cols[item.t]) continue; // a table this version no longer has
      if (item.t !== table || batch.length >= 500) { await flush(); table = item.t; }
      batch.push(item.r);
    }
    await flush();
    if (!complete) throw new Error('Záloha je neúplná (chýba koniec).');

    // Serial counters continue after the restored rows.
    for (const t of TABLES.filter((x) => x.key === 'id')) {
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${t.name}', 'id'), GREATEST(COALESCE(max(id), 0), 1), max(id) IS NOT NULL) FROM ${t.name}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  return counts;
}

// ------------------------------------------------------------------ settings and state

const DEFAULTS = { endpoint: '', region: 'auto', bucket: '', prefix: 'nowera-gateway/', access_key_id: '', secret_access_key: '', keep_days: 30 };

export async function backupSettings() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'backup'`);
  const value = { ...DEFAULTS, ...(row?.value || {}) };
  return { ...value, secret_access_key: open(value.secret_access_key || '') };
}

export async function saveBackupSettings(value) {
  const stored = { ...value, secret_access_key: seal(value.secret_access_key || '') };
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('backup', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(stored)]);
}

export const configured = (s) => Boolean(s.endpoint && s.bucket && s.access_key_id && s.secret_access_key);

export async function backupState() {
  const row = await one(`SELECT value FROM app_settings WHERE key = 'backup_state'`);
  return row?.value || {};
}

async function saveState(patch) {
  await query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ('backup_state', $1, now())
     ON CONFLICT (key) DO UPDATE SET value = app_settings.value || EXCLUDED.value, updated_at = now()`, [JSON.stringify(patch)]);
}

export const storage = (s, fetchImpl) => bucket({
  endpoint: s.endpoint, region: s.region || 'auto', bucket: s.bucket, accessKeyId: s.access_key_id, secretAccessKey: s.secret_access_key,
}, fetchImpl);

/** Settings typed into the form, checked; returns { value } or { error }. */
export function cleanSettings(b, current) {
  const endpoint = String(b.endpoint || '').trim().replace(/\/+$/, '');
  let url;
  try { url = new URL(endpoint); } catch { return { error: 'Endpoint musí byť adresa, napr. https://<účet>.r2.cloudflarestorage.com.' }; }
  // Plain http only for a storage on this machine (development).
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) {
    return { error: 'Endpoint musí začínať https://.' };
  }
  const bucketName = String(b.bucket || '').trim();
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName)) return { error: 'Názov bucketu: malé písmená, čísla, bodky a pomlčky.' };
  const prefix = String(b.prefix ?? DEFAULTS.prefix).trim().replace(/^\/+/, '');
  if (prefix && !/^[A-Za-z0-9._\-/]{1,100}$/.test(prefix)) return { error: 'Priečinok smie obsahovať písmená, čísla, bodky, pomlčky a lomky.' };
  const keepDays = Math.min(365, Math.max(3, Number(b.keep_days) || DEFAULTS.keep_days));
  const secret = String(b.secret_access_key || '').trim() || current.secret_access_key;
  const accessKey = String(b.access_key_id || '').trim();
  if (!accessKey || !secret) return { error: 'Vyplňte Access Key ID aj Secret Access Key.' };
  return {
    value: {
      endpoint: url.toString().replace(/\/+$/, ''), region: String(b.region || '').trim() || 'auto', bucket: bucketName,
      prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix,
      access_key_id: accessKey, secret_access_key: secret, keep_days: keepDays,
      configured_at: current.configured_at || new Date().toISOString(),
    },
  };
}

/** Write and delete a small object: proves the credentials can do what backups need. */
export async function testStorage(s, fetchImpl) {
  const store = storage(s, fetchImpl);
  const key = `${s.prefix}.nowera-test-${Date.now()}`;
  await store.put(key, Buffer.from('ok'), 'text/plain');
  await store.del(key);
}

const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, ''); // 2026-09-28T033012Z

/**
 * One backup: dump, encrypt, upload, then delete the ones older than keep_days
 * (always keeping the three newest). Records the outcome for the dashboard.
 */
let running = false;

export async function runBackup({ log, fetchImpl } = {}) {
  const s = await backupSettings();
  if (!configured(s)) throw new Error('Zálohy nie sú nastavené.');
  if (running) throw new Error('Záloha práve prebieha.');
  running = true;
  const started = Date.now();
  await saveState({ last_attempt_at: new Date().toISOString() });
  try {
    const { data, counts } = await createDump();
    const file = encryptBackup(data);
    const store = storage(s, fetchImpl);
    const key = `${s.prefix}${stamp(new Date())}.nwrb`;
    await store.put(key, file);

    let pruned = 0;
    try {
      const all = (await store.list(s.prefix)).filter((o) => o.key.endsWith('.nwrb')).sort((a, b) => b.modified - a.modified);
      const cutoff = Date.now() - s.keep_days * 86400_000;
      for (const o of all.slice(3)) {
        if (o.modified.getTime() < cutoff) { await store.del(o.key); pruned += 1; }
      }
    } catch (err) {
      log?.warn({ err: err.message }, 'backup pruning failed');
    }

    const result = { key, size: file.length, counts, ms: Date.now() - started, pruned };
    await saveState({ last_ok_at: new Date().toISOString(), last_ok_key: key, last_ok_size: file.length, last_counts: counts, last_error: null });
    log?.info({ key, size: file.length, ms: result.ms, pruned }, 'backup uploaded');
    return result;
  } catch (err) {
    await saveState({ last_error: String(err.message).slice(0, 300), last_error_at: new Date().toISOString() });
    log?.error({ err: err.message }, 'backup failed');
    throw err;
  } finally {
    running = false;
  }
}

/** The newest backups in storage, newest first. */
export async function listBackups(limit = 40) {
  const s = await backupSettings();
  if (!configured(s)) return [];
  const all = await storage(s).list(s.prefix);
  return all.filter((o) => o.key.endsWith('.nwrb')).sort((a, b) => b.modified - a.modified).slice(0, limit);
}

export async function fetchBackup(key) {
  const s = await backupSettings();
  if (!configured(s) || !key.startsWith(s.prefix) || !key.endsWith('.nwrb') || key.includes('..')) throw new Error('Neznáma záloha.');
  return storage(s).get(key);
}

const hourIn = (tz, now) => Number(new Date(now).toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: tz }));

/**
 * Due once a day in the small hours (3–6 in Bratislava), or whenever the last good
 * backup is over 30 hours old (the server was down at night, or it just got set
 * up). A failed attempt waits an hour before the next.
 */
export function backupDue(settings, state, now = Date.now()) {
  if (!configured(settings)) return false;
  const since = (iso) => (iso ? now - new Date(iso).getTime() : Infinity);
  if (since(state.last_attempt_at) < 60 * 60_000) return false;
  const age = since(state.last_ok_at);
  const hour = hourIn('Europe/Bratislava', now);
  return (age > 23 * 3600_000 && hour >= 3 && hour < 6) || age > 30 * 3600_000;
}

/** An alert condition when backups are set up but none succeeded for 36 hours. */
export async function backupCondition(now = Date.now()) {
  const [s, state] = await Promise.all([backupSettings(), backupState()]);
  if (!configured(s)) return null;
  const lastOk = state.last_ok_at ? new Date(state.last_ok_at).getTime() : null;
  const since = lastOk ?? new Date(s.configured_at || now).getTime();
  if (now - since < 36 * 3600_000) return null;
  const hours = Math.floor((now - since) / 3600_000);
  return {
    tenant_id: null, rule: 'backup', subject: '',
    message: `${lastOk ? `Posledná úspešná záloha pred ${hours} h.` : `Od nastavenia pred ${hours} h žiadna úspešná záloha.`}${state.last_error ? ` Chyba: ${state.last_error}` : ''}`,
  };
}

export function startBackups(log) {
  let busy = false;
  const check = async () => {
    if (busy) return;
    busy = true;
    try {
      const [s, state] = await Promise.all([backupSettings(), backupState()]);
      if (backupDue(s, state)) await runBackup({ log }).catch(() => {});
    } catch (err) {
      log.error({ err }, 'backup check failed');
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(check, 3 * 60_000);
  const timer = setInterval(check, 10 * 60_000);
  return () => { clearTimeout(first); clearInterval(timer); };
}
