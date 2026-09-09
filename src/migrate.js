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

-- Destinations that must not receive the same logical event twice (GA4 has no
-- deduplication of its own) get a key here; Meta wants both legs and leaves it NULL.
ALTER TABLE events ADD COLUMN IF NOT EXISTS dedupe_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS events_dedupe_idx
  ON events(destination_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

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
`;

const r = await pool.query(SQL);
console.log('migrations applied');
await pool.end();
