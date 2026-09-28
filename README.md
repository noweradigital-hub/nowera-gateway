# Nowera Gateway

Multi-tenant server-side tracking gateway. One container serves every client's
own collector subdomain, holds per-client configuration, and forwards events to
Meta Conversions API and GA4 Measurement Protocol.

Functionally this is what Stape sells, self-hosted: a first-party endpoint on the
client's domain, server-set `_fbp`/`_fbc` cookies, browser/server deduplication,
and per-client credentials — with no per-event pricing.

```
klient.sk  ──script──►  t.klient.sk/px.js      (loader, first-party)
           ──events──►  t.klient.sk/e          (browser leg)
WordPress  ──signed──►  t.klient.sk/s          (server leg, real order data)
                              │
                              ▼
                     queue (Postgres, retried)
                              │
                     ┌────────┴────────┐
                     ▼                 ▼
              Meta CAPI            GA4 MP
```

## Why deduplication matters

Both legs of a visit send the same `event_id`. Meta collapses them into one
conversion when the pixel hit and the CAPI hit share `event_name` + `event_id`
within 48 hours. Without it, every purchase is counted twice.

The browser leg exists because it carries signals the server never sees; the
server leg exists because ad blockers and ITP eat the browser leg. Running both
and deduplicating is the point of the whole system.

## Google Ads

There is no separate Ads destination, and that is deliberate. Server-side Google
Ads conversions are imported *from* GA4 — you mark the GA4 event as a conversion
and link the Ads account. The Google Ads API is only needed for offline
conversion uploads (CRM data with a GCLID), which is a different problem with a
different approval process. Configure the `ga4` destination and import in Ads.

## Layout

| Path | Purpose |
|---|---|
| `src/server.js` | Fastify entrypoint, registers routes and starts the worker |
| `src/routes/collect.js` | `/px.js`, `/e`, `/s`, `/health` — the public surface |
| `src/routes/admin.js` | Dashboard, gated to `ADMIN_HOST` |
| `src/lib/loader.js` | The first-party JS served per tenant |
| `src/lib/hash.js` | Meta PII normalization + SHA-256 |
| `src/lib/queue.js` | Postgres-backed delivery queue with backoff |
| `src/destinations/` | One module per destination (`meta`, `ga4`) |
| `src/lib/secrets.js` | Seals tokens and keys stored in Postgres (AES-256-GCM) |
| `src/lib/backup.js` | Nightly encrypted backups to S3-compatible storage, restore |
| `src/lib/routing.js` | Collector hosts for Traefik's HTTP provider |
| `src/routes/updates.js` | Signed plugin releases for the plugin's updater |
| `wp-plugin/nowera-capi/` | WordPress/WooCommerce server-leg plugin |
| `scripts/release-plugin.mjs` | Builds and signs a plugin release into `wp-plugin/releases/` |

## Local development

```bash
npm install
cp .env.example .env        # fill in the secrets
npm run migrate
npm run seed:admin -- you@example.com
npm run dev
npm test
```

Tests need no database — the HTTP suite injects stub data access into the routes.

## Deploying to the production VPS

This box has **no SSH**. Everything goes through the Hostinger VPS Docker-project
API, which takes inline compose YAML plus an `environment` string that becomes
`.env`. That means named volumes only — no bind mounts, no files placed by hand.

Ports 80/443 belong to the existing `root` project's Traefik (serving n8n). Do
not add a second proxy: attach to the external network `root_default` and route
by label using the existing `mytlschallenge` ACME resolver.

1. Point the admin host (`ADMIN_HOST`) at the VPS address with a real A record.
2. Set the project environment: `GATEWAY_IMAGE`, `DB_PASSWORD`, `SESSION_SECRET`,
   `INGEST_SECRET`, `ADMIN_HOST`, and `ADMIN_EMAIL` for the first login.
3. Deploy `docker/compose.yml` as a Docker project. The one-shot `migrate` and
   `seed` services run before the gateway starts — there is no shell on this box,
   so nothing is run by hand.
4. Read the generated admin password from the `seed` service log, then clear
   `ADMIN_EMAIL` so a later redeploy does not reset it.

### DNS and TLS gotchas worth knowing

- If the domain has a wildcard `*` A record, a new subdomain *appears* to resolve
  while pointing at the wrong host. Always confirm a real A record exists, not
  just that the name resolves.
- Traefik does not promptly retry a failed ACME order — it can sit for 25+
  minutes. If a certificate fails because DNS was not ready, fixing DNS is not
  enough: force a fresh order by redeploying the project with any label change.
- Image pulls on a small VPS can take several minutes, during which the project
  list looks empty and log calls 404. Poll the deploy action rather than assuming
  failure.

## Adding a client

1. **Admin → Nový klient:** the name and the website address; the collector host,
   allowed origins, cookie domain and the consent tool follow from it. The page
   after it shows the pairing code (host and key for the plugin) once.
2. **DNS:** the client adds `t.<their-domain>` → `CNAME <ADMIN_HOST>` (or an A
   record to the VPS), directly or proxied by Cloudflare (SSL mode Full).
3. **Routing:** once Traefik reads the gateway's host list (HTTP provider, see
   `docker/compose.yml`), the host is routed as soon as its DNS points here, and a
   direct one gets its certificate. Until then: append `Host(\`t.klient.sk\`)`
   to the `nwrgw-collector` router rule and redeploy.
4. **Destinations:** add Meta (dataset ID + CAPI token) and optionally GA4.
5. **Site:** install `wp-plugin/nowera-capi` and paste the pairing code (older
   plugins: host and key separately). The Inštalácia tab checks the rest.
6. Turn on Meta test mode, press **Poslať testovací event**, confirm it in Events
   Manager under Test Events.

## Backups and secrets

- Tokens, the sites' signing keys, authenticator secrets, the alert webhook and
  the backup credentials are sealed in Postgres with AES-256-GCM. The key is
  `SECRETS_KEY`, or derived from `SESSION_SECRET` when that is unset — **never
  change `SESSION_SECRET` without first setting `SECRETS_KEY` to the recovery key**
  (Zálohy → Kľúč na obnovu), or the stored tokens cannot be opened.
- **Zálohy** backs the whole database up every night (3–6 h Bratislava) to any
  S3-compatible storage (Cloudflare R2 recommended), encrypted with that key,
  kept `keep_days`. "Overiť poslednú zálohu" downloads and checks the latest one.
- Restore on a new server: set `SECRETS_KEY` to the recovery key, deploy, sign in
  with the seeded admin, and upload the `.nwrb` file under Zálohy (only offered
  while the installation has no clients).
- Plugin releases are signed with an Ed25519 key kept outside the repository
  (`~/.config/nowera-gateway/plugin-signing-key.pem`); the plugin refuses an
  update whose signature does not match a key built into it.

## Security model

- `/e` is authenticated by `Origin` against the tenant's allowlist — the page is
  public, so there is no secret to hold. It can only write to that tenant.
- `/s` is authenticated by HMAC-SHA256 over the timestamp and raw body with the
  tenant's own key (±5 minutes). Without it anyone could inject fake purchases
  into a client's dataset.
- The admin UI answers only on `ADMIN_HOST`; a client's collector subdomain
  resolves to the same process but 404s every admin route.
- Admin sessions use a `SameSite=Strict` HttpOnly cookie, which also blocks
  cross-site form POSTs.
- Access tokens are sealed in Postgres and never rendered in the UI; session
  tokens are stored only as hashes.

## Operational notes

- **Meta bumps its API version about twice a year.** `META_API_VERSION` is a
  single env var; bump it and redeploy.
- Failed deliveries retry with backoff (10s → 1h, 6 attempts) then land in
  `dead` and show in the event log with Meta's own error text.
- Events are swept after `RETENTION_DAYS` (default 30).
- Everything runs in one process on one box: if it goes down, no client is
  measuring. Give it its own VPS before the client count gets serious.
- Running this for clients makes Nowera a data processor for their visitors'
  personal data. A DPA with each client is required, not optional.
