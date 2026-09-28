import { pool } from '../db.js';
import { secretKeys } from '../destinations/index.js';
import { isSealed, open, seal, sealedWithCurrent } from './secrets.js';

/**
 * Seal every secret still stored in plain text (rows from before sealing), and
 * re-seal those sealed with an older key. Runs at startup; cheap when there is
 * nothing to do. A value that no key opens is left alone and reported, so one
 * bad row cannot stop the gateway from starting.
 */

const needsWork = (v) => Boolean(v) && !sealedWithCurrent(v);

function trySeal(value, problems, where) {
  try {
    return seal(isSealed(value) ? open(value) : value);
  } catch (err) {
    problems.push(`${where}: ${err.message}`);
    return value;
  }
}

export async function sealStoredSecrets(log) {
  const client = await pool.connect();
  const problems = [];
  let changed = 0;
  try {
    // One gateway at a time, should two ever start together.
    await client.query('SELECT pg_advisory_lock(727001)');

    const dests = await client.query('SELECT id, kind, settings FROM destinations');
    for (const d of dests.rows) {
      const settings = d.settings || {};
      const next = { ...settings };
      let dirty = false;
      for (const key of secretKeys(d.kind)) {
        if (!needsWork(settings[key])) continue;
        next[key] = trySeal(settings[key], problems, `destinácia ${d.id} ${key}`);
        dirty = dirty || next[key] !== settings[key];
      }
      if (dirty) {
        await client.query('UPDATE destinations SET settings = $2 WHERE id = $1', [d.id, JSON.stringify(next)]);
        changed += 1;
      }
    }

    const tenants = await client.query('SELECT id, ingest_secret, ingest_secret_prev FROM tenants');
    for (const t of tenants.rows) {
      if (!needsWork(t.ingest_secret) && !needsWork(t.ingest_secret_prev)) continue;
      await client.query('UPDATE tenants SET ingest_secret = $2, ingest_secret_prev = $3 WHERE id = $1', [t.id,
        needsWork(t.ingest_secret) ? trySeal(t.ingest_secret, problems, `klient ${t.id} kľúč`) : t.ingest_secret,
        needsWork(t.ingest_secret_prev) ? trySeal(t.ingest_secret_prev, problems, `klient ${t.id} predchádzajúci kľúč`) : t.ingest_secret_prev]);
      changed += 1;
    }

    const users = await client.query('SELECT id, totp_secret, totp_pending FROM admin_users');
    for (const u of users.rows) {
      if (!needsWork(u.totp_secret) && !needsWork(u.totp_pending)) continue;
      await client.query('UPDATE admin_users SET totp_secret = $2, totp_pending = $3 WHERE id = $1', [u.id,
        needsWork(u.totp_secret) ? trySeal(u.totp_secret, problems, `používateľ ${u.id} 2FA`) : u.totp_secret,
        needsWork(u.totp_pending) ? trySeal(u.totp_pending, problems, `používateľ ${u.id} 2FA`) : u.totp_pending]);
      changed += 1;
    }

    // Secrets inside dashboard settings: the alert webhook, the backup credentials.
    const SETTING_SECRETS = { alerts: ['webhook_url'], backup: ['secret_access_key'] };
    const settings = await client.query(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [Object.keys(SETTING_SECRETS)]);
    for (const row of settings.rows) {
      const value = { ...(row.value || {}) };
      let dirty = false;
      for (const field of SETTING_SECRETS[row.key]) {
        if (!needsWork(value[field])) continue;
        value[field] = trySeal(value[field], problems, `${row.key}.${field}`);
        dirty = true;
      }
      if (dirty) {
        await client.query('UPDATE app_settings SET value = $2 WHERE key = $1', [row.key, JSON.stringify(value)]);
        changed += 1;
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727001)').catch(() => {});
    client.release();
  }
  if (changed) log?.info({ rows: changed }, 'sealed stored secrets');
  if (problems.length) log?.error({ problems }, 'some stored secrets cannot be opened with the current keys');
  return { changed, problems };
}
