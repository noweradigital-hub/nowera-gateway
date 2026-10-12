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

## GA4: what the browser keeps

Measurement Protocol events only join a visitor's session (and the Ads click
that started it) through the Google tag's own `_ga` and `_ga_<stream>` cookies,
so a site keeps exactly one Google tag, configuration only:

- Fill **Google tag (GA4)** in the plugin settings and remove every other GA4
  snippet (header code, GTM GA4 tags, Site Kit). With a consent tool, the page
  only names the tag and sets a denied default; `px.js` loads it once the visitor
  allows statistics, so nothing goes to Google before that.
- The `ga4` destination's scope is **Všetky okrem page_view**: the tag counts page
  views and sessions, the gateway sends the ecommerce events. Use **Len udalosti
  bez prehliadača** when another integration (GTM) already sends ecommerce.
- `px.js` holds GA4-bound events for up to two seconds until the tag has written
  its cookies, so a new visitor's first events land in their session.
- Purchases carry hashed e-mail and phone (`user_data`) with marketing consent;
  GA4 uses them only with *user-provided data collection* switched on in the
  property. `user_id` is sent for customer accounts only.

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
4. **Destinations:** add Meta (dataset ID + CAPI token) and optionally GA4
   (measurement ID + Measurement Protocol API secret).
5. **Site:** install `wp-plugin/nowera-capi` and paste the pairing code (older
   plugins: host and key separately), choose the consent tool (FAZ Cookie Manager
   is the standard) and, for GA4, the Google tag ID. The Inštalácia tab checks
   the rest.
6. Turn on Meta test mode, press **Poslať testovací event**, confirm it in Events
   Manager under Test Events.

## Orders that are not plain goods, and the report API

From plugin 1.3 every order line has a kind. Adapters in
`wp-plugin/nowera-capi/adapters/` name the ones other plugins create: a booking
(Amelia, paid through WooCommerce), a gift card (PW WooCommerce Gift Cards), a
subscription (WPSubscription). What is sent follows from it:

| Order | Sent |
|---|---|
| Goods | `Purchase` (`ord-<id>`) of the money paid for them |
| A booking, paid or free | one `Lead` per order (`book-<id>`), kind `booking`, named after the service |
| Goods and a booking | both, adding up to the order's total |
| A gift card sold | `Purchase` with `content_category: gift_card` |
| Paid with a gift card | only the money added on top counts (the card was counted when sold) |
| Nothing left to pay | nothing; the order is in the order list only |
| A new subscription | `Purchase` and `Subscribe` (`sub-<id>`) |
| A subscription's renewal | nothing; in the order list only |

A refund or a cancellation takes back from GA4 only what a `Purchase` reported.

The plugin sends its order list every hour (`POST /r`, no contact data): each
order's kind, the events that stand for it, what it was worth, what was paid
and what a gift card settled, plus the bookings from the booking plugin's own
tables — those entered by staff included. The gateway keeps both for 400 days.

Two read-only endpoints on the administration's host serve them to the agency's
reports (an n8n workflow that pulls when its report is due):

- `GET /api/report/daily?from=YYYY-MM-DD&to=YYYY-MM-DD[&tenant=slug]`: per
  client and day the orders, money by kind, free orders, leads, renewals and
  bookings by web or staff. Without dates the last seven days.
- `GET /api/report/leads?since=YYYY-MM-DD&until=YYYY-MM-DD[&group=day|week|month][&forms=key,key]`:
  one client's leads per day in the shape of the
  [nwr-lead-stats](https://github.com/noweradigital-hub/nwr-lead-stats) plugin's
  `/counts` answer (`total`, `days`, `forms[]` with `key`, `title`, `total`,
  `days`, `complete_since`), so the same report node reads either. A lead is a
  counted order that holds a booking — one per order, under the service first
  booked on it (`amelia:<service id>`). Without dates today and the fourteen
  days before it, like the plugin.

Keys are shown once and kept as a hash. One for all clients is made under
Upozornenia → Reporty (with it, `/leads` needs `&tenant=slug`); a client's own,
made in its Nastavenia, opens that client alone. Either goes in
`Authorization: Bearer …` or `X-NWR-Leads-Key`.

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
