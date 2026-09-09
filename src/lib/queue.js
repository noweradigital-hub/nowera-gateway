import { config } from '../config.js';
import { many, query } from '../db.js';
import { dedupeKeyFor, driverFor } from '../destinations/index.js';

// Exponential backoff, capped. Index = attempt number.
const BACKOFF_SECONDS = [10, 30, 120, 600, 1800, 3600];
const MAX_ATTEMPTS = BACKOFF_SECONDS.length;

/**
 * Fan one canonical event out to every active destination of the tenant.
 * Destinations that deduplicate keep only the first leg to arrive; the unique
 * index does the work, so two simultaneous legs cannot both slip through.
 * Returns how many rows were actually queued.
 */
export async function enqueue(tenantId, event, destinations) {
  if (!destinations.length) return 0;
  const values = [];
  const params = [];
  destinations.forEach((dest, i) => {
    const base = i * 6;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
    params.push(
      tenantId, dest.id, event.event_name, event.event_id,
      JSON.stringify(event), dedupeKeyFor(dest.kind, event),
    );
  });
  const { rowCount } = await query(
    `INSERT INTO events (tenant_id, destination_id, event_name, event_id, payload, dedupe_key)
     VALUES ${values.join(', ')}
     ON CONFLICT (destination_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    params,
  );
  return rowCount;
}

/**
 * Claim a batch atomically so two workers (or two container replicas) never send
 * the same event twice. Rows move to 'sending' for the duration of the HTTP call;
 * `requeueStale` recovers any left behind by a crash.
 */
async function claimBatch(limit) {
  return many(
    `UPDATE events e
        SET status = 'sending', attempts = e.attempts + 1
       FROM (
         SELECT id FROM events
          WHERE status = 'pending' AND next_attempt_at <= now()
          ORDER BY next_attempt_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       ) claimed
      WHERE e.id = claimed.id
      RETURNING e.id, e.destination_id, e.payload, e.attempts`,
    [limit],
  );
}

async function markFailed(row, error, retryable) {
  const attempts = row.attempts;
  if (!retryable || attempts >= MAX_ATTEMPTS) {
    await query(
      `UPDATE events SET status = 'dead', last_error = $2, sent_at = NULL WHERE id = $1`,
      [row.id, error],
    );
    return;
  }
  const delay = BACKOFF_SECONDS[Math.min(attempts, BACKOFF_SECONDS.length - 1)];
  await query(
    `UPDATE events
        SET status = 'pending',
            last_error = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [row.id, error, String(delay)],
  );
}

/** Return events stranded in 'sending' by a crashed worker back to the queue. */
export async function requeueStale(olderThanMinutes = 10) {
  const { rowCount } = await query(
    `UPDATE events
        SET status = 'pending', next_attempt_at = now()
      WHERE status = 'sending'
        AND created_at < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount;
}

export async function tick() {
  const rows = await claimBatch(config.batchSize);
  if (!rows.length) return 0;

  const destinations = await many(
    `SELECT id, kind, settings FROM destinations WHERE id = ANY($1::int[])`,
    [[...new Set(rows.map((r) => r.destination_id))]],
  );
  const byId = new Map(destinations.map((d) => [d.id, d]));

  await Promise.all(rows.map(async (row) => {
    const dest = byId.get(row.destination_id);
    if (!dest) {
      await markFailed(row, 'destination no longer exists', false);
      return;
    }
    try {
      const result = await driverFor(dest.kind).send(row.payload, dest.settings || {});
      if (result.ok) {
        await query(`UPDATE events SET status = 'sent', sent_at = now(), last_error = NULL WHERE id = $1`, [row.id]);
      } else {
        await markFailed(row, result.error, result.retryable);
      }
    } catch (err) {
      await markFailed(row, `worker: ${err.message}`, true);
    }
  }));

  return rows.length;
}

export function startWorker(log) {
  let running = false;

  // Anything left 'sending' belongs to a previous process that died mid-flight.
  requeueStale(0).then((n) => { if (n) log.warn({ requeued: n }, 'recovered stranded events'); })
    .catch((err) => log.error({ err }, 'startup requeue failed'));

  const timer = setInterval(async () => {
    if (running) return; // never overlap ticks
    running = true;
    try {
      const n = await tick();
      if (n) log.debug({ sent: n }, 'worker tick');
    } catch (err) {
      log.error({ err }, 'worker tick failed');
    } finally {
      running = false;
    }
  }, config.workerIntervalMs);

  const stale = setInterval(() => {
    requeueStale(10).catch((err) => log.error({ err }, 'stale requeue failed'));
  }, 300_000);

  const retention = setInterval(async () => {
    try {
      await query(
        `DELETE FROM events
          WHERE status IN ('sent','dead')
            AND created_at < now() - ($1 || ' days')::interval`,
        [String(config.retentionDays)],
      );
    } catch (err) {
      log.error({ err }, 'retention sweep failed');
    }
  }, 3600_000);

  return () => { clearInterval(timer); clearInterval(stale); clearInterval(retention); };
}
