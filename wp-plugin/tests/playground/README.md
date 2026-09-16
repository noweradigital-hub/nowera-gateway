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

These scripts are test-only and must never be deployed.
