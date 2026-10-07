# Plugin integration tests (WordPress Playground)

Runs the real plugin inside WordPress + WooCommerce on PHP 8.3, with no
network access to a gateway: `scripts/_bootstrap.php` intercepts every request
to `collector.test` through `pre_http_request` and stores the exact payload, so
tests assert what *would* have been sent, including the HMAC signature.

```bash
cd wp-plugin/tests/playground
npx -y @wp-playground/cli@latest server --port=9410 \
  --blueprint=blueprint.json \
  --mount=../../nowera-capi:/wordpress/wp-content/plugins/nowera-capi \
  --mount=./scripts:/wordpress/nwr-test
```

In another terminal, once it answers:

```bash
npm run test:wp
```

First boot downloads WordPress and WooCommerce and takes a minute or two.
`setup.php` is idempotent, so the suite can be rerun against the same instance.

## Gotchas this suite already hit

- Playground serves requests from several PHP workers, each with its own copy
  of the unmounted filesystem. A file a script writes at runtime (say into
  `mu-plugins`) exists in one worker only; switch test behaviour with options,
  and ship files through the blueprint or a mount.

- A product search with exactly one hit is redirected by WooCommerce to that
  product, which fires ViewContent, not Search. Search tests need two hits.
- `woocommerce_before_checkout_form` prints markup; buffer it in scripts.
- WooCommerce rejects a billing e-mail with surrounding spaces, so normalisation
  of whitespace cannot be tested through an order.
- Block themes make WooCommerce itself preload the customer's billing e-mail
  into the page. Assert on the plugin's own `<script>`, not the whole HTML.
- WordPress hides fatals behind "critical error"; the bootstrap disables that
  handler and prints `NWR_FATAL {...}` instead.
- Playground answers HTTP before the blueprint has activated WooCommerce, so
  "port is open" is not "ready". The suite polls `diag.php` until both plugins
  are loaded.

- Since 1.0 the plugin sends after the response (shutdown). Scripts call
  `nwr_flush()` before reading or resetting what was captured.
- Real page loads cannot reach `collector.test` (only these scripts intercept
  it), so the plugin's circuit breaker pauses sending after one; the bootstrap
  clears the pause at the start of every script.
- WooCommerce 9+ starts new stores in "coming soon" mode, which replaces shop
  pages for guests and their Cache-Control; `setup.php` turns it off.
- WooCommerce remembers the first `is_checkout()` answer per request;
  `nwr_on_checkout_page()` sets the query and the `woocommerce_is_checkout` filter.
- The update test verifies the real signed ZIP in `wp-plugin/releases/` and is
  skipped until `scripts/release-plugin.mjs` has built one.

These scripts are test-only and must never be deployed.
