import { config } from '../config.js';
import { many, one, query } from '../db.js';
import { consentAllows, dedupeKeyFor, driverFor, openSettings, wants } from '../destinations/index.js';
import { plural } from './stats.js';

// How long to wait after the n-th failed attempt (n = 1 is the first entry).
// Quick retries cover a blip; the long steps carry an event through an outage of
// a whole day: the last try is about 26 hours after the first, well inside what
// the destinations still accept (Meta and OpenAI 7 days, GA4 72 hours).
export const RETRY_DELAYS_SECONDS = [10, 30, 120, 600, 1800, 3600, 7200, 14400, 21600, 43200];
export const MAX_ATTEMPTS = RETRY_DELAYS_SECONDS.length + 1;

/** Seconds until the next try after `attempts` failed ones, or null when it is time to give up. */
export function retryDelay(attempts) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts >= MAX_ATTEMPTS) return null;
  return RETRY_DELAYS_SECONDS[attempts - 1];
}

/**
 * Fan one canonical event out to every active destination of the tenant.
 * Destinations that deduplicate keep only the first leg to arrive; the unique
 * index does the work, so two simultaneous legs cannot both slip through.
 * Returns how many rows were actually queued. `run` lets a caller queue inside
 * its own transaction.
 */
export async function enqueue(tenantId, event, allDestinations, run = query) {
  const destinations = allDestinations.filter((d) => wants(d, event) && consentAllows(d.kind, event));
  if (!destinations.length) return 0;
  const values = [];
  const params = [];
  destinations.forEach((dest, i) => {
    const base = i * 7;
    values.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7})`);
    params.push(
      tenantId, dest.id, event.event_name, event.event_id,
      JSON.stringify(event), dedupeKeyFor(dest.kind, event), event.source || null,
    );
  });
  const { rowCount } = await run(
    `INSERT INTO events (tenant_id, destination_id, event_name, event_id, payload, dedupe_key, source)
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
        SET status = 'sending', attempts = e.attempts + 1, claimed_at = now()
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
  const delay = retryable ? retryDelay(row.attempts) : null;
  if (delay === null) {
    await query(
      `UPDATE events SET status = 'dead', last_error = $2, response = $2, sent_at = NULL WHERE id = $1`,
      [row.id, error],
    );
    return;
  }
  await query(
    `UPDATE events
        SET status = 'pending',
            last_error = $2,
            response = $2,
            next_attempt_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [row.id, error, String(delay)],
  );
}

/**
 * Return events stranded in 'sending' by a crashed worker back to the queue.
 * Counted from when a worker took the row, not from when the event arrived: a
 * retried event is old, yet its current attempt may be seconds in flight.
 */
export async function requeueStale(olderThanMinutes = 10) {
  const { rowCount } = await query(
    `UPDATE events
        SET status = 'pending', next_attempt_at = now()
      WHERE status = 'sending'
        AND COALESCE(claimed_at, created_at) < now() - ($1 || ' minutes')::interval`,
    [String(olderThanMinutes)],
  );
  return rowCount;
}

// A due event is normally claimed within one tick (2 s); one left waiting this
// long means the worker is not running or cannot keep up.
export const QUEUE_LATE_MINUTES = 10;
// A row is 'sending' for one HTTP call (10 s at most). The stale sweep returns
// rows older than 10 minutes every 5 minutes, so 20 minutes means it is not running.
export const SENDING_STUCK_MINUTES = 20;

/**
 * How the queue looks right now, timed by the database's own clock: how long the
 * oldest due event has waited and how long the oldest 'sending' row has been out.
 */
export async function queueState() {
  const row = await one(
    `SELECT (SELECT extract(epoch FROM now() - min(next_attempt_at))::int FROM events
              WHERE status = 'pending' AND next_attempt_at <= now()) AS due_age,
            (SELECT count(*)::int FROM events
              WHERE status = 'pending' AND next_attempt_at <= now() - ($1 || ' minutes')::interval) AS late,
            (SELECT extract(epoch FROM now() - min(COALESCE(claimed_at, created_at)))::int FROM events
              WHERE status = 'sending') AS sending_age,
            (SELECT count(*)::int FROM events
              WHERE status = 'sending' AND COALESCE(claimed_at, created_at) < now() - ($2 || ' minutes')::interval) AS stuck`,
    [String(QUEUE_LATE_MINUTES), String(SENDING_STUCK_MINUTES)],
  );
  return {
    dueAge: row?.due_age ?? null,
    late: row?.late ?? 0,
    sendingAge: row?.sending_age ?? null,
    stuck: row?.stuck ?? 0,
  };
}

/** What is wrong with the queue, as { code, message } in Slovak, or null when it moves. */
export function queueProblem(state) {
  if (!state) return null;
  const minutes = (s) => Math.floor(s / 60);
  if (state.dueAge !== null && state.dueAge >= QUEUE_LATE_MINUTES * 60) {
    return {
      code: 'queue_late',
      message: `${plural(Math.max(state.late, 1), 'event čaká', 'eventy čakajú', 'eventov čaká')} na odoslanie dlhšie ako ${QUEUE_LATE_MINUTES} min, najstarší ${minutes(state.dueAge)} min. Worker nebeží alebo nestíha.`,
    };
  }
  if (state.sendingAge !== null && state.sendingAge >= SENDING_STUCK_MINUTES * 60) {
    return {
      code: 'queue_stuck',
      message: `${plural(Math.max(state.stuck, 1), 'event zostal', 'eventy zostali', 'eventov zostalo')} v stave „odosiela sa“, najstarší ${minutes(state.sendingAge)} min. Worker sa zasekol a nikto ich nevracia do fronty.`,
    };
  }
  return null;
}

/** Deliveries since the last summary line, per destination kind. */
const tally = new Map();
function count(kind, outcome) {
  const t = tally.get(kind) || { sent: 0, failed: 0 };
  t[outcome] += 1;
  tally.set(kind, t);
}

export async function tick(log) {
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
      const result = await driverFor(dest.kind).send(row.payload, openSettings(dest.kind, dest.settings || {}));
      if (result.ok) {
        await query(`UPDATE events SET status = 'sent', sent_at = now(), last_error = NULL, response = $2 WHERE id = $1`,
          [row.id, result.response ? String(result.response).slice(0, 500) : null]);
        count(dest.kind, 'sent');
      } else {
        await markFailed(row, result.error, result.retryable);
        count(dest.kind, 'failed');
        // The destination's own error text: codes and messages, no customer data.
        log?.warn({ kind: dest.kind, event: row.payload?.event_name, attempt: row.attempts,
          error: String(result.error).slice(0, 300) }, 'delivery failed');
      }
    } catch (err) {
      await markFailed(row, `worker: ${err.message}`, true);
      count(dest.kind, 'failed');
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
      const n = await tick(log);
      if (n) log.debug({ sent: n }, 'worker tick');
    } catch (err) {
      log.error({ err }, 'worker tick failed');
    } finally {
      running = false;
    }
  }, config.workerIntervalMs);

  // One line every ten minutes says delivery works, without logging each event.
  const summary = setInterval(() => {
    if (!tally.size) return;
    log.info({ deliveries: Object.fromEntries(tally) }, 'deliveries in the last 10 minutes');
    tally.clear();
  }, 600_000);

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

  return () => { clearInterval(timer); clearInterval(summary); clearInterval(stale); clearInterval(retention); };
}
