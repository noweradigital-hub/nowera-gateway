import { many, pool, query } from '../db.js';
import { hashField } from './hash.js';
import { enqueue } from './queue.js';
import { recordReceived } from './stats-writer.js';

/**
 * Purchases from Stripe webhooks, for a site we cannot change.
 *
 * The site's thank-you page reports its own Purchase through px.js, which the
 * gateway already forwards to Meta's Conversions API. Stripe tells us about every
 * paid Checkout, including the buyers who never came back to that page. Each paid
 * session waits until HOLD_MINUTES after the payment, then one of these happens:
 *   matched     the browser's Purchase for it arrived — nothing more is sent;
 *   sent        no browser Purchase, but the buyer's visit left consent and
 *               identifiers (a browser context) — a server Purchase goes out;
 *   no_consent  the visit refused both marketing and statistics;
 *   no_visit    no browser context at all: nothing proves consent, nothing goes;
 *   ambiguous   more than one browser Purchase could be this payment;
 *   test        a Stripe test-mode event.
 *
 * The join is the buyer's email (Stripe's customer_email, which the site sets
 * from the order and Checkout does not let the buyer change), hashed, with the
 * currency and amount. A buyer whose browser Purchase reaches us only after the
 * hold would be counted twice; the sites this serves show their thank-you page
 * once, straight after Stripe's redirect, so that should not happen in practice.
 */

// A payment is decided once its browser Purchase can no longer arrive.
export const HOLD_MINUTES = 30;
// How long before the payment the buyer's visit may have been.
const VISIT_WINDOW_SECONDS = 2 * 3600;
// Server clocks (ours, Stripe's) may disagree a little.
const CLOCK_SKEW_SECONDS = 60;
// A browser Purchase for this payment arrives after Stripe's redirect: from a
// little before the payment to some time after it, never hours later.
const PURCHASE_BEFORE_SECONDS = 15 * 60;
const PURCHASE_AFTER_SECONDS = HOLD_MINUTES * 60;
const MAX_AGE_SECONDS = 7 * 86400;

const seconds = (t) => Math.floor(new Date(t).getTime() / 1000);
const sameMoney = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005;

/** Whether the visit allowed anything at all. No consent block = the site asks for none. */
function anyConsent(consent) {
  if (!consent) return true;
  return consent.marketing === true || consent.statistics === true;
}

/**
 * The part of a browser event worth keeping for the matcher, or null. Only events
 * that carry a hashed email and some consent: without an email there is nothing
 * to join a payment to, without consent nothing may be sent for it.
 */
export function browserContext(event) {
  const em = event?.user?.em;
  if (!em || !/^[a-f0-9]{64}$/.test(em) || !anyConsent(event.consent)) return null;
  const props = event.properties || {};
  const value = Number(props.value);
  return {
    email_hash: em,
    event_name: event.event_name,
    event_id: event.event_id,
    value: event.event_name === 'Purchase' && Number.isFinite(value) ? value : null,
    currency: typeof props.currency === 'string' ? props.currency.slice(0, 3).toUpperCase() : null,
    consent: event.consent || null,
    snapshot: {
      user: event.user,
      context: event.context || {},
      event_source_url: event.event_source_url || null,
      account_id: event.account_id || null,
      google_user: event.google_user || null,
    },
  };
}

/** Called for every accepted browser event of a tenant with Stripe on. */
export async function recordBrowserContext(tenantId, event, run = query) {
  const row = browserContext(event);
  if (!row) return false;
  await run(
    `INSERT INTO browser_contexts (tenant_id, email_hash, event_name, event_id, value, currency, consent, snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [tenantId, row.email_hash, row.event_name, row.event_id, row.value, row.currency,
      row.consent ? JSON.stringify(row.consent) : null, JSON.stringify(row.snapshot)],
  );
  return true;
}

/**
 * Keep one paid Checkout. Stripe retries a webhook until it gets a 2xx and may
 * send both completed and async_payment_succeeded: the session id keeps one row.
 */
export async function storePayment(tenantId, checkout, run = query) {
  const { rowCount } = await run(
    `INSERT INTO stripe_payments (tenant_id, session_id, stripe_event_id, livemode, email_hash, value, currency,
                                  order_ref, paid_at, due_at, status, decided_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, to_timestamp($9),
             GREATEST(to_timestamp($9) + ($10 || ' minutes')::interval, now() + interval '1 minute'),
             $11, CASE WHEN $11 = 'waiting' THEN NULL ELSE now() END)
     ON CONFLICT (tenant_id, session_id) DO NOTHING`,
    [tenantId, checkout.sessionId, checkout.stripeEventId, checkout.livemode,
      checkout.email ? hashField('em', checkout.email) : null, checkout.value, checkout.currency,
      checkout.orderRef, checkout.paidAt, String(HOLD_MINUTES), checkout.livemode ? 'waiting' : 'test'],
  );
  return rowCount > 0;
}

/**
 * The server Purchase for a payment, in the canonical event shape the queue and
 * the destination drivers use, carrying what the buyer's visit allowed.
 */
export function purchaseFromStripe(payment, context, nowSeconds = Math.floor(Date.now() / 1000)) {
  const snap = context.snapshot || {};
  let eventTime = seconds(payment.paid_at);
  if (eventTime > nowSeconds) eventTime = nowSeconds;
  if (eventTime < nowSeconds - MAX_AGE_SECONDS) eventTime = nowSeconds - MAX_AGE_SECONDS;
  const properties = { value: Number(payment.value), currency: payment.currency, content_type: 'product' };
  if (payment.order_ref) properties.order_id = payment.order_ref;
  return {
    event_name: 'Purchase',
    event_id: `stripe-${payment.session_id}`.slice(0, 100),
    event_time: eventTime,
    event_source_url: snap.event_source_url || null,
    referrer_url: null,
    action_source: 'website',
    user: { ...(snap.user || {}), em: payment.email_hash },
    consent: context.consent || null,
    account_id: snap.account_id || null,
    google_user: snap.google_user || null,
    properties,
    context: snap.context || {},
    source: 'server',
    // No page reported it, so a GA4 property the site measures in the browser
    // (scope "browserless") takes it too.
    browserless: true,
  };
}

/** The time windows a payment is judged in, as Date objects for the SQL too. */
export function windowsOf(payment) {
  const paid = seconds(payment.paid_at);
  const at = (s) => new Date(s * 1000);
  return {
    purchaseFrom: at(paid - PURCHASE_BEFORE_SECONDS),
    purchaseTo: at(paid + PURCHASE_AFTER_SECONDS),
    visitFrom: at(paid - VISIT_WINDOW_SECONDS),
    visitTo: at(paid + CLOCK_SKEW_SECONDS),
  };
}

const within = (c, from, to) => {
  const t = seconds(c.created_at);
  return t >= seconds(from) && t <= seconds(to);
};

/**
 * What to do with one due payment. `purchases` are the browser Purchases with the
 * same email around the payment, `visits` the browser contexts with that email
 * before it, newest first. Pure, so every branch is tested without a database.
 * `used` holds browser Purchase ids already matched to other payments.
 *
 * The newest visit before the payment decides about consent. A visit that later
 * refused tells us nothing (px.js sends nothing without consent), so a
 * withdrawal inside the two hours before paying cannot be seen here.
 */
export function decide(payment, { purchases = [], visits = [] } = {}, used = new Set()) {
  if (!payment.email_hash) return { status: 'no_visit' };
  const w = windowsOf(payment);

  const candidates = new Set(purchases
    .filter((c) => c.event_name === 'Purchase' && !used.has(c.event_id)
      && within(c, w.purchaseFrom, w.purchaseTo)
      && c.currency === payment.currency
      && c.value !== null && c.value !== undefined && sameMoney(c.value, payment.value))
    .map((c) => c.event_id));
  if (candidates.size === 1) return { status: 'matched', matched_event_id: [...candidates][0] };
  if (candidates.size > 1) return { status: 'ambiguous' };

  const visit = visits.find((c) => within(c, w.visitFrom, w.visitTo));
  if (!visit) return { status: 'no_visit' };
  if (!anyConsent(visit.consent)) return { status: 'no_consent' };
  return { status: 'sent', context: visit };
}

/**
 * The destinations a Stripe Purchase goes to. GA4 joins a hit to a session only
 * by the browser's client id; without one it would invent a visitor, so it gets
 * nothing rather than a misattributed purchase.
 */
export function stripeDestinations(destinations, event) {
  return destinations.filter((d) => d.kind !== 'ga4' || Boolean(event.context?.gaClientId));
}

/**
 * Decide every due payment. One transaction per batch, rows locked with SKIP
 * LOCKED: the decision, the queued deliveries and the new status commit together,
 * so a crash can neither lose a purchase nor send it twice.
 */
export async function processDue(log, limit = 20) {
  const client = await pool.connect();
  const run = (text, params) => client.query(text, params);
  const received = [];
  let done = 0;
  try {
    await run('BEGIN');
    const { rows: due } = await run(
      `SELECT * FROM stripe_payments
        WHERE status = 'waiting' AND due_at <= now()
        ORDER BY due_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [limit],
    );
    for (const payment of due) {
      const w = windowsOf(payment);
      // Every browser Purchase of this email around the payment, unlimited (the
      // window keeps it small) so neither a match nor an ambiguity is cut off.
      const { rows: purchases } = await run(
        `SELECT event_name, event_id, value, currency, created_at
           FROM browser_contexts
          WHERE tenant_id = $1 AND email_hash = $2 AND event_name = 'Purchase'
            AND created_at BETWEEN $3 AND $4`,
        [payment.tenant_id, payment.email_hash, w.purchaseFrom, w.purchaseTo],
      );
      // The newest visit before the payment: its consent and identifiers.
      const { rows: visits } = await run(
        `SELECT event_name, event_id, consent, snapshot, created_at
           FROM browser_contexts
          WHERE tenant_id = $1 AND email_hash = $2
            AND created_at BETWEEN $3 AND $4
          ORDER BY created_at DESC
          LIMIT 1`,
        [payment.tenant_id, payment.email_hash, w.visitFrom, w.visitTo],
      );
      const { rows: usedRows } = await run(
        `SELECT matched_event_id FROM stripe_payments
          WHERE tenant_id = $1 AND matched_event_id IS NOT NULL AND id <> $2
            AND received_at > now() - interval '7 days'`,
        [payment.tenant_id, payment.id],
      );
      const decision = decide(payment, { purchases, visits }, new Set(usedRows.map((r) => r.matched_event_id)));

      let sentId = null;
      if (decision.status === 'sent') {
        const { rows: dests } = await run(
          `SELECT d.id, d.kind, d.settings FROM destinations d JOIN tenants t ON t.id = d.tenant_id
            WHERE d.tenant_id = $1 AND d.active = TRUE AND t.active = TRUE`,
          [payment.tenant_id],
        );
        const event = purchaseFromStripe(payment, decision.context);
        await enqueue(payment.tenant_id, event, stripeDestinations(dests, event), run);
        sentId = event.event_id;
        received.push([payment.tenant_id, event]);
      }
      await run(
        `UPDATE stripe_payments SET status = $2, matched_event_id = $3, sent_event_id = $4, decided_at = now()
          WHERE id = $1`,
        [payment.id, decision.status, decision.matched_event_id || null, sentId],
      );
      done += 1;
    }
    await run('COMMIT');
  } catch (err) {
    await run('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
  // Counted only once committed, like every other received event.
  for (const [tenantId, event] of received) recordReceived(tenantId, event, 'server');
  if (done) log?.info({ decided: done, sent: received.length }, 'stripe payments decided');
  return done;
}

/** What came of the tenant's Stripe payments in the last 30 days, by status. */
export async function stripeCounts(tenantId) {
  const rows = await many(
    `SELECT status, count(*)::int AS n FROM stripe_payments
      WHERE tenant_id = $1 AND received_at > now() - interval '30 days'
      GROUP BY status`,
    [tenantId],
  );
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

export function startStripeMatcher(log, intervalMs = 30_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await processDue(log);
    } catch (err) {
      log.error({ err }, 'stripe matcher failed');
    } finally {
      running = false;
    }
  }, intervalMs);

  // Browser contexts are only needed while a payment may still be waiting.
  const retention = setInterval(() => {
    query(`DELETE FROM browser_contexts WHERE created_at < now() - interval '7 days'`)
      .then(() => query(`DELETE FROM stripe_payments WHERE received_at < now() - interval '90 days'`))
      .catch((err) => log.error({ err }, 'stripe retention failed'));
  }, 3600_000);

  return () => { clearInterval(timer); clearInterval(retention); };
}
