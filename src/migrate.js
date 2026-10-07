import { pool } from './db.js';

const SQL = `
CREATE TABLE IF NOT EXISTS tenants (
  id              SERIAL PRIMARY KEY,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  -- host the loader and collector are served on, e.g. t.klient.sk
  collector_host  TEXT NOT NULL UNIQUE,
  -- browser origins allowed to POST /e, comma separated, e.g. https://klient.sk,https://www.klient.sk
  allowed_origins TEXT NOT NULL DEFAULT '',
  -- cookie scope shared by the site and the collector, e.g. .klient.sk
  cookie_domain   TEXT,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS destinations (
  id          SERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL CHECK (kind IN ('meta','ga4')),
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  -- kind-specific settings; meta: {dataset_id, access_token, test_event_code}
  --                        ga4:  {measurement_id, api_secret}
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS destinations_tenant_idx ON destinations(tenant_id);

CREATE TABLE IF NOT EXISTS events (
  id              BIGSERIAL PRIMARY KEY,
  tenant_id       INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  destination_id  INTEGER NOT NULL REFERENCES destinations(id) ON DELETE CASCADE,
  event_name      TEXT NOT NULL,
  event_id        TEXT,
  payload         JSONB NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','sending','sent','dead')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at         TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS events_claim_idx
  ON events(status, next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS events_stale_idx ON events(status, created_at) WHERE status = 'sending';
CREATE INDEX IF NOT EXISTS events_tenant_created_idx ON events(tenant_id, created_at DESC);

-- How the tenant's site asks for consent. Delivered inside px.js, so it applies
-- even to pages the site serves from a full-page cache.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS consent_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS consent_prefix TEXT NOT NULL DEFAULT 'cmplz_';

-- Path of the nowera-capi cookie keeper on the client's own site, also delivered
-- inside px.js so pages from a long-lived page cache use it too. The default fills
-- the existing tenants, which all run the WordPress plugin that ships it.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS keep_path TEXT DEFAULT '/wp-content/plugins/nowera-capi/keep.php';

-- Destinations that must not receive the same logical event twice (GA4 has no
-- deduplication of its own) get a key here; Meta wants both legs and leaves it NULL.
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_idx
  ON events(destination_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

-- Each tenant signs its server events with its own key. Until a tenant is moved
-- to it (legacy_ingest = FALSE), the shared INGEST_SECRET and signatures without
-- a timestamp stay accepted, so existing sites keep working through the switch.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ingest_secret TEXT;
-- The key before the last rotation, still accepted until someone revokes it, so
-- rotating does not drop the site's events while its plugin is being updated.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS ingest_secret_prev TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS legacy_ingest BOOLEAN NOT NULL DEFAULT TRUE;
-- Events the browser may not report on its own, comma separated (e.g. Purchase):
-- the site's server sends them signed, so a forged browser request cannot.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS server_only_events TEXT NOT NULL DEFAULT '';

-- One row per event the gateway accepted, whatever it was forwarded to: what the
-- dashboard counts and measures. Flags only, no personal data; kept 90 days.
CREATE TABLE IF NOT EXISTS received (
  id          BIGSERIAL PRIMARY KEY,
  tenant_id   INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name  TEXT NOT NULL,
  event_id    TEXT NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('browser','server')),
  consent     TEXT CHECK (consent IN ('marketing','statistics')),
  has_em      BOOLEAN NOT NULL DEFAULT FALSE,
  has_ph      BOOLEAN NOT NULL DEFAULT FALSE,
  has_ext     BOOLEAN NOT NULL DEFAULT FALSE,
  has_fbp     BOOLEAN NOT NULL DEFAULT FALSE,
  has_fbc     BOOLEAN NOT NULL DEFAULT FALSE,
  has_ip      BOOLEAN NOT NULL DEFAULT FALSE,
  has_country BOOLEAN NOT NULL DEFAULT FALSE,
  value       NUMERIC,
  currency    TEXT
);
CREATE INDEX IF NOT EXISTS received_tenant_time_idx ON received(tenant_id, created_at DESC);
-- The shop's own order list, reported by the plugin (POST /r), to prove which
-- orders produced a delivered Purchase and why the others did not.
CREATE TABLE IF NOT EXISTS order_audit (
  tenant_id     INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id      TEXT NOT NULL,
  day           DATE NOT NULL,
  created_at    TIMESTAMPTZ,
  paid_at       TIMESTAMPTZ,
  status        TEXT NOT NULL,
  total         NUMERIC(14,2),
  currency      TEXT,
  ready         BOOLEAN NOT NULL DEFAULT FALSE,
  consent       TEXT NOT NULL DEFAULT '',
  has_ctx       BOOLEAN NOT NULL DEFAULT FALSE,
  purchase_sent BOOLEAN NOT NULL DEFAULT FALSE,
  thankyou      BOOLEAN NOT NULL DEFAULT FALSE,
  via           TEXT NOT NULL DEFAULT '',
  reported_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, order_id)
);
CREATE INDEX IF NOT EXISTS order_audit_day_idx ON order_audit(tenant_id, day);
CREATE TABLE IF NOT EXISTS audit_snapshots (
  tenant_id    INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day          DATE NOT NULL,
  orders       INTEGER NOT NULL DEFAULT 0,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
-- When the site started running its current plugin version (the order audit's grace period).
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plugin_version_since TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS received_purchase_idx ON received(tenant_id, event_id) WHERE event_name = 'Purchase';
CREATE INDEX IF NOT EXISTS events_purchase_idx ON events(tenant_id, event_id) WHERE event_name = 'Purchase';
-- The no_events alert counts every tenant's events of the last two weeks by time.
CREATE INDEX IF NOT EXISTS received_time_idx ON received(created_at);

-- What happened to requests that never became events: crawlers, floods, browser
-- copies of server-only events. Per tenant and day.
CREATE TABLE IF NOT EXISTS daily_counters (
  tenant_id INTEGER NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day       DATE NOT NULL,
  name      TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, day, name)
);

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS first_event_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS last_event_at TIMESTAMPTZ;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plugin_version TEXT;
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS plugin_seen_at TIMESTAMPTZ;
-- Hours without an event before the no_events alert; NULL = derived from the client's traffic.
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS quiet_alert_hours NUMERIC(4,1);

-- The destination's last answer, for the event detail in the dashboard, and when
-- a worker took the row, so a crashed worker's rows are recovered by that time.
ALTER TABLE events ADD COLUMN IF NOT EXISTS response TEXT;
ALTER TABLE events ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS source TEXT;
CREATE INDEX IF NOT EXISTS events_tenant_event_id_idx ON events(tenant_id, event_id);

-- Dashboard-wide settings, e.g. where alerts go and which rules are on.
CREATE TABLE IF NOT EXISTS app_settings (
  key        TEXT PRIMARY KEY,
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A problem the gateway noticed, open until the condition clears. One open row
-- per tenant, rule and subject (e.g. which destination).
CREATE TABLE IF NOT EXISTS alerts (
  id                   BIGSERIAL PRIMARY KEY,
  tenant_id            INTEGER REFERENCES tenants(id) ON DELETE CASCADE,
  rule                 TEXT NOT NULL,
  subject              TEXT NOT NULL DEFAULT '',
  message              TEXT NOT NULL,
  opened_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at          TIMESTAMPTZ,
  notified_at          TIMESTAMPTZ,
  resolved_notified_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS alerts_open_idx ON alerts(tenant_id, rule, subject) WHERE resolved_at IS NULL;
CREATE INDEX IF NOT EXISTS alerts_opened_idx ON alerts(opened_at DESC);

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);

-- Two-factor sign-in (TOTP): the active secret, one being set up, and the last
-- step used so a code cannot be replayed.
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_secret TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_pending TEXT;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_enabled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS totp_last_step BIGINT NOT NULL DEFAULT 0;
ALTER TABLE admin_users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ;

-- Who changed what in the dashboard.
CREATE TABLE IF NOT EXISTS admin_audit (
  id      BIGSERIAL PRIMARY KEY,
  at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id INTEGER,
  email   TEXT,
  action  TEXT NOT NULL,
  target  TEXT
);
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON admin_audit(at DESC);
`;

const r = await pool.query(SQL);
console.log('migrations applied');
await pool.end();
