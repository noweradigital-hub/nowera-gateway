<?php
/**
 * Plugin Name:  Nowera CAPI
 * Description:  Posiela serverové eventy z WooCommerce do Nowera Gateway (Meta CAPI + GA4) a zdieľa event_id s prehliadačovou vetvou.
 * Version:      0.8.0
 * Author:       Nowera
 * License:      GPL-2.0-or-later
 * Requires PHP: 8.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const NOWERA_CAPI_OPTION = 'nowera_capi_settings';

/** Contact fields kept, hashed, in the _nwr_ud cookie for returning customers. */
const NOWERA_CAPI_STORED_KEYS = array( 'em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country' );

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

function nowera_capi_settings(): array {
	$defaults = array(
		'collector_host' => '',
		'ingest_secret'  => '',
		'load_script'    => 1,
		'consent_mode'   => 'none',
		'consent_prefix' => 'cmplz_',
	);
	return wp_parse_args( get_option( NOWERA_CAPI_OPTION, array() ), $defaults );
}

add_action( 'admin_menu', function () {
	add_options_page( 'Nowera CAPI', 'Nowera CAPI', 'manage_options', 'nowera-capi', 'nowera_capi_render_settings' );
} );

add_action( 'admin_init', function () {
	register_setting( 'nowera_capi', NOWERA_CAPI_OPTION, array(
		'sanitize_callback' => function ( $input ) {
			return array(
				'collector_host' => sanitize_text_field( $input['collector_host'] ?? '' ),
				'ingest_secret'  => sanitize_text_field( $input['ingest_secret'] ?? '' ),
				'load_script'    => empty( $input['load_script'] ) ? 0 : 1,
				'consent_mode'   => in_array( $input['consent_mode'] ?? 'none', array( 'none', 'cookiescript', 'complianz', 'custom' ), true )
					? $input['consent_mode']
					: 'none',
				'consent_prefix' => preg_replace( '/[^a-zA-Z0-9_\-]/', '', $input['consent_prefix'] ?? 'cmplz_' ) ?: 'cmplz_',
			);
		},
	) );
} );

function nowera_capi_render_settings(): void {
	$s = nowera_capi_settings();
	?>
	<div class="wrap">
		<h1>Nowera CAPI</h1>
		<form method="post" action="options.php">
			<?php settings_fields( 'nowera_capi' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="nwr_host">Collector host</label></th>
					<td>
						<input id="nwr_host" class="regular-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[collector_host]"
						       value="<?php echo esc_attr( $s['collector_host'] ); ?>" placeholder="t.klient.sk">
						<p class="description">Bez <code>https://</code>. Musí sedieť s hostom nastaveným v Gateway administrácii.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_secret">Ingest secret</label></th>
					<td>
						<input id="nwr_secret" class="regular-text code" type="password" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[ingest_secret]"
						       value="<?php echo esc_attr( $s['ingest_secret'] ); ?>" autocomplete="off">
						<p class="description">Hodnota <code>INGEST_SECRET</code> z gateway servera. Podpisuje serverové eventy.</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Loader</th>
					<td>
						<label>
							<input type="checkbox" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[load_script]" value="1" <?php checked( $s['load_script'] ); ?>>
							Vložiť <code>px.js</code> do hlavičky
						</label>
						<p class="description">Vypnite, ak loader vkladáte cez GTM alebo ručne.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_consent">Súhlas s cookies</label></th>
					<td>
						<select id="nwr_consent" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[consent_mode]">
							<option value="none" <?php selected( $s['consent_mode'], 'none' ); ?>>Nekontrolovať (meria sa vždy)</option>
							<option value="cookiescript" <?php selected( $s['consent_mode'], 'cookiescript' ); ?>>CookieScript</option>
							<option value="complianz" <?php selected( $s['consent_mode'], 'complianz' ); ?>>Complianz</option>
							<option value="custom" <?php selected( $s['consent_mode'], 'custom' ); ?>>Iný nástroj (cookie s prefixom)</option>
						</select>
						<p class="description">
							Meta dostane eventy len so súhlasom <strong>marketing</strong>, GA4 so súhlasom <strong>statistics</strong>
							(v CookieScripte kategórie <code>targeting</code> a <code>performance</code>).
							Pri inom nástroji zavolajte po rozhodnutí návštevníka <code>nwr('consent')</code>.
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_prefix">Prefix súhlasových cookies</label></th>
					<td>
						<input id="nwr_prefix" class="regular-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[consent_prefix]"
						       value="<?php echo esc_attr( $s['consent_prefix'] ); ?>">
						<p class="description">Complianz predvolene <code>cmplz_</code> — cookie <code>cmplz_marketing=allow</code>.</p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

/* -------------------------------------------------------------------------
 * Loader
 * ---------------------------------------------------------------------- */

add_action( 'wp_head', function () {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['load_script'] ) ) {
		return;
	}
	$config = array();

	if ( 'none' !== $s['consent_mode'] ) {
		$config[] = 'window.nwrConsent=' . wp_json_encode( array(
			'mode'   => $s['consent_mode'],
			'prefix' => $s['consent_prefix'],
		) ) . ';';
	}

	// What this page is. Identical for every visitor, so it is safe in cached HTML.
	$page = nowera_capi_page_context();
	if ( $page ) {
		$config[] = 'window.nwrPage=' . wp_json_encode( $page ) . ';';
	}

	// This site's own endpoint that re-sets our identifiers from its server,
	// which Safari keeps for 90 days instead of 7. Same for every visitor.
	$config[] = 'window.nwrKeep=' . wp_json_encode( plugins_url( 'keep.php', __FILE__ ) ) . ';';

	// Hashed identifiers only for signed-in customers, whose pages are never
	// served from the shared page cache. For a guest this line could be cached
	// and handed to every later visitor as if they were the same person; guest
	// identity reaches Meta through the server leg at checkout instead.
	if ( is_user_logged_in() ) {
		$identity = array();
		foreach ( nowera_capi_current_user() as $key => $value ) {
			$digest = nowera_capi_hash( $key, $value );
			if ( $digest !== null ) {
				$identity[ $key ] = $digest;
			}
		}
		if ( $identity ) {
			$config[] = 'window.nwrUser=' . wp_json_encode( $identity ) . ';';
		}
	}

	if ( $config ) {
		printf( '<script>%s</script>' . "\n", implode( '', $config ) );
	}

	printf(
		'<script async src="https://%s/px.js"></script>' . "\n",
		esc_attr( $s['collector_host'] )
	);
}, 1 );

/* -------------------------------------------------------------------------
 * Consent, catalog ids, page context
 * ---------------------------------------------------------------------- */

/**
 * Whether the visitor behind this request agreed to a consent category.
 * 'marketing' gates Meta, 'statistics' gates GA4.
 */
function nowera_capi_has_consent( string $category ): bool {
	$s = nowera_capi_settings();
	if ( 'none' === $s['consent_mode'] ) {
		return true;
	}

	if ( 'cookiescript' === $s['consent_mode'] ) {
		$map = array( 'marketing' => 'targeting', 'statistics' => 'performance' );
		return isset( $map[ $category ] ) && in_array( $map[ $category ], nowera_capi_cookiescript_categories(), true );
	}

	// Complianz reports into the WP Consent API when that plugin is present.
	if ( 'complianz' === $s['consent_mode'] && function_exists( 'wp_has_consent' ) ) {
		return (bool) wp_has_consent( $category );
	}
	$name = $s['consent_prefix'] . $category;
	return isset( $_COOKIE[ $name ] ) && 'allow' === sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) );
}

/**
 * Categories the visitor accepted in CookieScript. Its cookie is JSON whose
 * "categories" field is itself a JSON string, e.g.
 *   {"action":"accept","categories":"[\"targeting\",\"performance\"]"}
 * WordPress adds slashes to $_COOKIE, so it has to be unslashed before decoding.
 */
function nowera_capi_cookiescript_categories(): array {
	if ( empty( $_COOKIE['CookieScriptConsent'] ) || ! is_string( $_COOKIE['CookieScriptConsent'] ) ) {
		return array();
	}
	$data = json_decode( wp_unslash( $_COOKIE['CookieScriptConsent'] ), true );
	if ( ! is_array( $data ) ) {
		return array();
	}
	$categories = $data['categories'] ?? array();
	if ( is_string( $categories ) ) {
		$categories = json_decode( $categories, true );
	}
	return is_array( $categories ) ? array_values( array_filter( $categories, 'is_string' ) ) : array();
}

/**
 * The id Meta's catalog knows this product by. Meta for WooCommerce syncs the
 * catalog, so its own helper is the source of truth; the same filter is honoured
 * when that plugin is absent so a customised retailer id still matches.
 */
function nowera_capi_content_id( \WC_Product $product ): string {
	if ( class_exists( 'WC_Facebookcommerce_Utils' ) && is_callable( array( 'WC_Facebookcommerce_Utils', 'get_fb_retailer_id' ) ) ) {
		return (string) \WC_Facebookcommerce_Utils::get_fb_retailer_id( $product );
	}
	return (string) apply_filters( 'wc_facebook_fb_retailer_id', (string) $product->get_id(), $product );
}

function nowera_capi_product_price( \WC_Product $product ): float {
	return $product->is_type( 'variable' )
		? (float) $product->get_variation_price( 'min' )
		: (float) $product->get_price();
}

/**
 * Describes the current shop page for the browser leg: a product, a category
 * or a search. Mirrors what Meta for WooCommerce used to send, so catalog
 * matching and audiences keep working after its own tracking is switched off.
 */
function nowera_capi_page_context(): ?array {
	if ( ! function_exists( 'is_product' ) ) {
		return null;
	}
	$currency = get_woocommerce_currency();

	if ( is_product() ) {
		$product = wc_get_product( get_queried_object_id() );
		if ( ! $product ) {
			return null;
		}
		$id    = nowera_capi_content_id( $product );
		$price = nowera_capi_product_price( $product );
		$cats  = wp_get_post_terms( $product->get_id(), 'product_cat', array( 'fields' => 'names' ) );
		return array(
			'type' => 'product',
			'data' => array(
				'content_name'     => wp_strip_all_tags( $product->get_name() ),
				'content_ids'      => array( $id ),
				'content_type'     => $product->is_type( array( 'variable', 'grouped' ) ) ? 'product_group' : 'product',
				'contents'         => array( array( 'id' => $id, 'quantity' => 1, 'item_price' => $price ) ),
				'content_category' => is_array( $cats ) ? implode( ', ', $cats ) : '',
				'value'            => $price,
				'currency'         => $currency,
			),
		);
	}

	global $wp_query;
	$listed = function () use ( $wp_query ) {
		$ids      = array();
		$contents = array();
		$group    = false;
		foreach ( array_slice( (array) $wp_query->posts, 0, 10 ) as $post ) {
			$product = wc_get_product( $post );
			if ( ! $product ) {
				continue;
			}
			$id         = nowera_capi_content_id( $product );
			$ids[]      = $id;
			$contents[] = array( 'id' => $id, 'quantity' => 1 );
			$group      = $group || $product->is_type( 'variable' );
		}
		return array( $ids, $contents, $group ? 'product_group' : 'product' );
	};

	if ( is_product_category() ) {
		$term = get_queried_object();
		list( $ids, $contents, $type ) = $listed();
		return array(
			'type' => 'category',
			'data' => array(
				'content_name'     => $term->name,
				'content_category' => $term->name,
				'content_ids'      => $ids,
				'content_type'     => $type,
				'contents'         => $contents,
				'currency'         => $currency,
			),
		);
	}

	if ( is_search() && '' !== get_search_query() && 'product' === get_query_var( 'post_type' ) ) {
		list( $ids, $contents, $type ) = $listed();
		return array(
			'type' => 'search',
			'data' => array(
				'search_string' => get_search_query(),
				'content_ids'   => $ids,
				'content_type'  => $type,
				'contents'      => $contents,
				'currency'      => $currency,
			),
		);
	}

	return null;
}

/* -------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------- */

/**
 * Meta's normalization rules, mirrored from the gateway's hash.js so a value
 * hashed here produces the same digest as one hashed there.
 */
function nowera_capi_hash( string $key, $value ): ?string {
	if ( $value === null || $value === '' ) {
		return null;
	}
	$value = (string) $value;
	if ( preg_match( '/^[a-f0-9]{64}$/i', $value ) ) {
		return strtolower( $value ); // already hashed upstream
	}

	$lower = mb_strtolower( trim( $value ), 'UTF-8' );
	switch ( $key ) {
		case 'em':
			$normalized = $lower;
			break;
		case 'ph':
			$normalized = ltrim( preg_replace( '/\D/', '', $value ), '0' );
			break;
		case 'fn':
		case 'ln':
		case 'ct':
			$normalized = preg_replace( '/[^\p{L}]/u', '', $lower );
			break;
		case 'st':
			$normalized = substr( preg_replace( '/[^\p{L}]/u', '', $lower ), 0, 2 );
			break;
		case 'zp':
			$normalized = preg_replace( '/\s/', '', $lower );
			break;
		case 'country':
			$normalized = substr( $lower, 0, 2 );
			break;
		default:
			$normalized = $lower;
	}

	return $normalized === '' ? null : hash( 'sha256', $normalized );
}

/**
 * GA4 joins a Measurement Protocol hit to the visitor's browser session by these
 * two ids. Without them the event lands as Direct and is useless for Ads import.
 */
function nowera_capi_ga_ids(): array {
	$client_id = null;
	$session_id = null;

	if ( ! empty( $_COOKIE['_ga'] ) ) {
		$parts = explode( '.', sanitize_text_field( wp_unslash( $_COOKIE['_ga'] ) ) );
		if ( count( $parts ) >= 4 ) {
			$client_id = $parts[ count( $parts ) - 2 ] . '.' . $parts[ count( $parts ) - 1 ];
		}
	}

	// The session cookie is named after the stream id, which we do not configure
	// anywhere — find whichever _ga_* cookie this property set.
	foreach ( $_COOKIE as $name => $value ) {
		if ( strpos( $name, '_ga_' ) !== 0 ) {
			continue;
		}
		$parts = explode( '.', sanitize_text_field( wp_unslash( $value ) ) );
		if ( count( $parts ) >= 3 ) {
			$session_id = $parts[2];
			break;
		}
	}

	return array( 'client_id' => $client_id, 'session_id' => $session_id );
}

/* -------------------------------------------------------------------------
 * Returning customers
 * ---------------------------------------------------------------------- */

/**
 * Hashed contact details stored after a purchase or a login. Read by px.js on
 * every later page (cached ones too) and by the server events below, so a
 * returning customer is recognised before they type anything.
 */
function nowera_capi_stored_user(): array {
	if ( empty( $_COOKIE['_nwr_ud'] ) || ! is_string( $_COOKIE['_nwr_ud'] ) ) {
		return array();
	}
	$data = json_decode( wp_unslash( $_COOKIE['_nwr_ud'] ), true );
	if ( ! is_array( $data ) ) {
		return array();
	}
	$out = array();
	foreach ( NOWERA_CAPI_STORED_KEYS as $key ) {
		if ( isset( $data[ $key ] ) && is_string( $data[ $key ] ) && preg_match( '/^[a-f0-9]{64}$/i', $data[ $key ] ) ) {
			$out[ $key ] = strtolower( $data[ $key ] );
		}
	}
	return $out;
}

/**
 * Store the hashed identity for later visits. Only with marketing consent, and
 * only when there is an email or a phone: a name alone identifies nobody.
 */
function nowera_capi_remember_user( array $raw ): void {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || headers_sent() || ! nowera_capi_has_consent( 'marketing' ) ) {
		return;
	}
	$hashed = array();
	foreach ( NOWERA_CAPI_STORED_KEYS as $key ) {
		$digest = isset( $raw[ $key ] ) ? nowera_capi_hash( $key, $raw[ $key ] ) : null;
		if ( $digest !== null ) {
			$hashed[ $key ] = $digest;
		}
	}
	if ( empty( $hashed['em'] ) && empty( $hashed['ph'] ) ) {
		return;
	}

	// A response that sets a personal cookie must never be served from a page cache.
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	do_action( 'litespeed_control_set_nocache', 'nowera-capi: returning-customer cookie' );
	nocache_headers();

	$value = wp_json_encode( $hashed );
	setcookie( '_nwr_ud', $value, array(
		'expires'  => time() + 90 * DAY_IN_SECONDS,
		'path'     => '/',
		'secure'   => is_ssl(),
		'httponly' => false, // px.js reads it
		'samesite' => 'Lax',
	) );
	$_COOKIE['_nwr_ud'] = wp_slash( $value );
}

/**
 * A visitor arriving from a Meta ad carries ?fbclid=. The loader normally turns
 * it into the _fbc cookie; this is the fallback for when it cannot run — the
 * click id is what ties the later purchase back to the ad.
 */
function nowera_capi_capture_fbclid(): void {
	if ( empty( $_GET['fbclid'] ) || isset( $_COOKIE['_fbc'] ) || headers_sent() ) {
		return;
	}
	if ( ! nowera_capi_has_consent( 'marketing' ) ) {
		return;
	}
	$fbclid = sanitize_text_field( wp_unslash( $_GET['fbclid'] ) );
	if ( ! preg_match( '/^[A-Za-z0-9._-]{1,500}$/', $fbclid ) ) {
		return;
	}

	// Meta's own shape: fb.<subdomain index>.<created at, ms>.<click id>.
	$value  = 'fb.1.' . ( time() * 1000 ) . '.' . $fbclid;
	$host   = (string) wp_parse_url( home_url(), PHP_URL_HOST );
	$domain = ( defined( 'COOKIE_DOMAIN' ) && COOKIE_DOMAIN ) ? COOKIE_DOMAIN : '.' . preg_replace( '/^www\./', '', $host );

	// This response now carries one visitor's click id, so it must not be cached.
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	do_action( 'litespeed_control_set_nocache', 'nowera-capi: click id cookie' );
	nocache_headers();

	setcookie( '_fbc', $value, array(
		'expires'  => time() + 90 * DAY_IN_SECONDS,
		'path'     => '/',
		'domain'   => $domain,
		'secure'   => is_ssl(),
		'httponly' => false, // the Meta pixel reads it too
		'samesite' => 'Lax',
	) );
	$_COOKIE['_fbc'] = $value;
}

// The thank-you page of a fresh order: the buyer's own contact details. The order
// key proves the link came from checkout, the age check keeps an old forwarded
// link from tagging somebody else's browser.
add_action( 'template_redirect', function () {
	nowera_capi_capture_fbclid();

	if ( ! function_exists( 'is_order_received_page' ) || ! is_order_received_page() ) {
		return;
	}
	$order_id = absint( get_query_var( 'order-received' ) );
	$key      = isset( $_GET['key'] ) ? wc_clean( wp_unslash( $_GET['key'] ) ) : '';
	$order    = $order_id ? wc_get_order( $order_id ) : false;
	if ( ! $order || '' === $key || ! hash_equals( $order->get_order_key(), (string) $key ) ) {
		return;
	}
	$created = $order->get_date_created();
	if ( ! $created || $created->getTimestamp() < time() - DAY_IN_SECONDS ) {
		return;
	}
	nowera_capi_remember_user( nowera_capi_user_from_order( $order ) );
}, 5 );

// A login: the account's billing details, which are usually the ones ads know.
add_action( 'wp_login', function ( $login, $user ) {
	if ( ! $user instanceof \WP_User ) {
		return;
	}
	$raw = array(
		'em' => $user->user_email,
		'fn' => $user->first_name,
		'ln' => $user->last_name,
	);
	if ( class_exists( 'WC_Customer' ) ) {
		try {
			$customer = new \WC_Customer( $user->ID );
			$raw      = array_merge( $raw, array_filter( array(
				'em'      => $customer->get_billing_email(),
				'ph'      => $customer->get_billing_phone(),
				'fn'      => $customer->get_billing_first_name(),
				'ln'      => $customer->get_billing_last_name(),
				'ct'      => $customer->get_billing_city(),
				'zp'      => $customer->get_billing_postcode(),
				'country' => $customer->get_billing_country(),
			) ) );
		} catch ( \Exception $e ) {
			// No customer record: the account fields above are still useful.
		}
	}
	nowera_capi_remember_user( $raw );
}, 10, 2 );

/** First-party visitor id set by the gateway; often a guest's only stable identifier. */
function nowera_capi_visitor_id(): ?string {
	return empty( $_COOKIE['_nwr_id'] )
		? null
		: sanitize_text_field( wp_unslash( $_COOKIE['_nwr_id'] ) );
}

function nowera_capi_client_ip(): string {
	foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR', 'REMOTE_ADDR' ) as $key ) {
		if ( ! empty( $_SERVER[ $key ] ) ) {
			$ip = trim( explode( ',', sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ) )[0] );
			if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
				return $ip;
			}
		}
	}
	return '';
}

/**
 * The referrer of the page this request renders, for events fired during a
 * full page load (checkout, thank-you page). An AJAX or REST call's referrer is
 * the page itself, not the one before it, so those get none. Query string and
 * fragment are dropped: on a same-site referrer they can hold order keys.
 */
function nowera_capi_page_referrer( ?string $event_url ): ?string {
	if ( empty( $_SERVER['HTTP_REFERER'] ) || wp_doing_ajax() || wp_doing_cron() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
		return null;
	}
	$parts = wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['HTTP_REFERER'] ) ) );
	if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) || ! in_array( $parts['scheme'], array( 'http', 'https' ), true ) ) {
		return null;
	}
	$referrer = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' ) . ( $parts['path'] ?? '/' );
	if ( $event_url && strtok( $event_url, '?#' ) === $referrer ) {
		return null; // the page referring to itself, e.g. a form posted back
	}
	return $referrer;
}

/**
 * Whether the buyer has ordered before: an earlier order under the same account
 * or billing email that was not abandoned, failed or cancelled. Custom statuses
 * (shipped, delivered…) count, since they come after payment.
 */
function nowera_capi_customer_segment( \WC_Order $order ): ?string {
	$email       = (string) $order->get_billing_email();
	$customer_id = (int) $order->get_customer_id();
	if ( '' === $email && ! $customer_id ) {
		return null;
	}

	$skip     = array( 'wc-pending', 'wc-failed', 'wc-cancelled', 'wc-checkout-draft' );
	$statuses = array_values( array_diff( array_keys( wc_get_order_statuses() ), $skip ) );
	$args     = array(
		'type'    => 'shop_order',
		'status'  => $statuses,
		'exclude' => array( $order->get_id() ),
		'limit'   => 1,
		'return'  => 'ids',
	);
	$created = $order->get_date_created();
	if ( $created ) {
		$args['date_created'] = '<' . $created->getTimestamp();
	}

	$lookups = array();
	if ( $customer_id ) {
		$lookups[] = array( 'customer_id' => $customer_id );
	}
	if ( '' !== $email ) {
		$lookups[] = array( 'billing_email' => $email );
		if ( strtolower( $email ) !== $email ) {
			$lookups[] = array( 'billing_email' => strtolower( $email ) );
		}
	}
	foreach ( $lookups as $lookup ) {
		if ( wc_get_orders( array_merge( $args, $lookup ) ) ) {
			return 'existing_customer_to_business';
		}
	}
	return 'new_customer_to_business';
}

/**
 * What the current request tells us about the visitor: consent, and the
 * identifiers that may travel with it. An event built later, when the visitor
 * is gone (a payment confirmed by the gateway), passes a stored copy instead.
 */
function nowera_capi_request_context(): array {
	$marketing  = nowera_capi_has_consent( 'marketing' );
	$statistics = nowera_capi_has_consent( 'statistics' );
	$ga         = nowera_capi_ga_ids();
	$cookie     = function ( string $name ) use ( $marketing ) {
		return ( $marketing && isset( $_COOKIE[ $name ] ) ) ? sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) ) : null;
	};
	return array(
		'marketing'     => $marketing,
		'statistics'    => $statistics,
		'fbp'           => $cookie( '_fbp' ),
		'fbc'           => $cookie( '_fbc' ),
		// No cookie yet on the very landing page the ad click opened.
		'fbclid'        => ( $marketing && ! empty( $_GET['fbclid'] ) ) ? sanitize_text_field( wp_unslash( $_GET['fbclid'] ) ) : null,
		'ga_client_id'  => $ga['client_id'],
		'ga_session_id' => $ga['session_id'],
		'ip'            => nowera_capi_client_ip(),
		'ua'            => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '',
	);
}

/**
 * Send one event to the gateway. Non-blocking: never delays the page for the
 * visitor. Returns what happened, so a caller can record it on the order:
 * 'marketing' (Meta will get it), 'statistics' (only GA4 may), 'none' (the
 * visitor gave no consent) or 'not_configured'.
 */
function nowera_capi_send( string $event_name, string $event_id, array $user, array $props, ?string $url = null, ?array $ctx = null ): string {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['ingest_secret'] ) ) {
		return 'not_configured';
	}

	$ctx        = $ctx ?? nowera_capi_request_context();
	$marketing  = ! empty( $ctx['marketing'] );
	$statistics = ! empty( $ctx['statistics'] );
	if ( ! $marketing && ! $statistics ) {
		return 'none'; // nobody may receive this event
	}
	if ( ! $marketing ) {
		// Contact details and the visitor id are only for advertising use.
		$user = array_intersect_key( $user, array( 'country' => true ) );
	}

	$hashed = array();
	foreach ( $user as $key => $value ) {
		$digest = nowera_capi_hash( $key, $value );
		if ( $digest !== null ) {
			$hashed[ $key ] = $digest;
		}
	}

	$source_url = $url ?: home_url( add_query_arg( array() ) );

	$payload = array(
		'event_name'        => $event_name,
		'event_id'          => $event_id,
		'event_time'        => isset( $ctx['event_time'] ) ? (int) $ctx['event_time'] : time(),
		'ga_client_id'      => $ctx['ga_client_id'] ?? null,
		'ga_session_id'     => $ctx['ga_session_id'] ?? null,
		'event_source_url'  => $source_url,
		'referrer_url'      => array_key_exists( 'referrer_url', $ctx ) ? $ctx['referrer_url'] : nowera_capi_page_referrer( $source_url ),
		'action_source'     => 'website',
		'user_data'         => $hashed,
		'custom_data'       => $props,
		'fbp'               => $marketing ? ( $ctx['fbp'] ?? null ) : null,
		'fbc'               => $marketing ? ( $ctx['fbc'] ?? null ) : null,
		'fbclid'            => $marketing ? ( $ctx['fbclid'] ?? null ) : null,
		'client_ip_address' => $ctx['ip'] ?? '',
		'client_user_agent' => $ctx['ua'] ?? '',
	);
	if ( 'none' !== $s['consent_mode'] ) {
		$payload['consent'] = array( 'marketing' => $marketing, 'statistics' => $statistics );
	}
	$body = wp_json_encode( $payload );

	$response = wp_remote_post( 'https://' . $s['collector_host'] . '/s', array(
		'timeout'  => 5,
		'blocking' => false,
		'headers'  => array(
			'Content-Type'    => 'application/json',
			'X-NWR-Signature' => hash_hmac( 'sha256', $body, $s['ingest_secret'] ),
		),
		'body'     => $body,
	) );

	if ( is_wp_error( $response ) ) {
		error_log( '[nowera-capi] ' . $response->get_error_message() );
	}

	return $marketing ? 'marketing' : 'statistics';
}

/** Plain-language outcome of a Purchase, written to the order so it can be checked later. */
function nowera_capi_record_outcome( \WC_Order $order, string $outcome, bool $after_payment = false ): void {
	$notes = array(
		'marketing'      => 'Purchase odoslaný do Mety aj GA4 (súhlas: marketing).',
		'statistics'     => 'Purchase odoslaný len pre štatistiku — bez marketingového súhlasu ho Meta nedostane.',
		'none'           => 'Purchase neodoslaný — návštevník nedal súhlas s cookies.',
		'not_configured' => 'Purchase neodoslaný — plugin nemá vyplnený collector alebo kľúč.',
	);
	$note = $notes[ $outcome ] ?? $outcome;
	if ( $after_payment ) {
		$note = 'Po potvrdení platby (zákazník sa nevrátil na web): ' . $note;
	}
	$order->update_meta_data( '_nowera_capi_purchase_consent', $outcome );
	$order->add_order_note( 'Nowera CAPI: ' . $note );
}

/**
 * Keep what the checkout request knew about the buyer. When the payment gateway
 * confirms the order later and the buyer never returns to the thank-you page,
 * that confirmation arrives without the buyer's cookies — this is all we have.
 * Marketing identifiers are kept only if the buyer allowed marketing.
 */
function nowera_capi_remember_checkout_context( \WC_Order $order ): void {
	if ( $order->get_meta( '_nowera_capi_ctx' ) ) {
		return;
	}
	$ctx  = nowera_capi_request_context();
	$keep = array(
		'marketing'     => (bool) $ctx['marketing'],
		'statistics'    => (bool) $ctx['statistics'],
		'ga_client_id'  => $ctx['ga_client_id'],
		'ga_session_id' => $ctx['ga_session_id'],
	);
	if ( $ctx['marketing'] ) {
		$keep['fbp']     = $ctx['fbp'];
		$keep['fbc']     = $ctx['fbc'];
		$keep['visitor'] = nowera_capi_visitor_id();
	}
	$order->update_meta_data( '_nowera_capi_ctx', $keep );
}

/** Purchase custom_data, shared by the thank-you page and the after-payment path. */
function nowera_capi_purchase_data( \WC_Order $order ): array {
	$contents    = array();
	$content_ids = array();
	foreach ( $order->get_items() as $item ) {
		$product = $item->get_product();
		$id      = $product ? nowera_capi_content_id( $product ) : (string) ( $item->get_variation_id() ?: $item->get_product_id() );
		$content_ids[] = $id;
		$contents[]    = array(
			'id'         => $id,
			'item_name'  => $item->get_name(),
			'quantity'   => $item->get_quantity(),
			'item_price' => $order->get_item_total( $item, false, true ),
		);
	}

	$custom_data = array(
		'value'        => (float) $order->get_total(),
		'currency'     => $order->get_currency(),
		'order_id'     => $order->get_id(),
		'content_ids'  => $content_ids,
		'contents'     => $contents,
		'content_type' => 'product',
		'num_items'    => $order->get_item_count(),
	);
	// New or returning buyer, for campaigns that optimise for new customers.
	$segment = nowera_capi_customer_segment( $order );
	if ( $segment ) {
		$custom_data['customer_segmentation'] = $segment;
	}
	return $custom_data;
}

/**
 * The browser half of a server event: same event_id and same products, so Meta
 * collapses the two into one conversion and the pixel's own identifiers (fbp,
 * fbc, user agent) count towards the match.
 */
function nowera_capi_browser_leg( string $event_name, string $event_id, array $custom_data ): void {
	add_action( 'wp_footer', function () use ( $event_name, $event_id, $custom_data ) {
		printf(
			'<script>window.nwr=window.nwr||function(){(window.nwr.q=window.nwr.q||[]).push(arguments)};' .
			'window.nwr("track",%s,%s,{eventID:%s});</script>' . "\n",
			wp_json_encode( $event_name ),
			wp_json_encode( $custom_data ),
			wp_json_encode( $event_id )
		);
	} );
}

/** Identity fields we can read from the logged-in user or a Woo order. */
function nowera_capi_user_from_order( \WC_Order $order ): array {
	return array_filter( array(
		'em'          => $order->get_billing_email(),
		'ph'          => $order->get_billing_phone(),
		'fn'          => $order->get_billing_first_name(),
		'ln'          => $order->get_billing_last_name(),
		'ct'          => $order->get_billing_city(),
		'zp'          => $order->get_billing_postcode(),
		'country'     => $order->get_billing_country(),
		'external_id' => $order->get_customer_id()
			? (string) $order->get_customer_id()
			: (string) nowera_capi_visitor_id(),
	) );
}

/* -------------------------------------------------------------------------
 * WooCommerce events
 * ---------------------------------------------------------------------- */

add_action( 'woocommerce_thankyou', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order ) {
		return;
	}
	// The thank-you page is refreshed and bookmarked; send Purchase exactly once.
	if ( $order->get_meta( '_nowera_capi_purchase_sent' ) ) {
		return;
	}

	$event_id    = 'ord-' . $order->get_id();
	$custom_data = nowera_capi_purchase_data( $order );

	$outcome = nowera_capi_send(
		'Purchase',
		$event_id,
		nowera_capi_user_from_order( $order ),
		$custom_data,
		$order->get_checkout_order_received_url()
	);

	nowera_capi_record_outcome( $order, $outcome );
	// Only a delivered event closes the order for good. Without consent the
	// visitor may still accept the banner on this very page, and then a reload
	// (or the browser leg waiting in the loader) still reports the purchase.
	if ( 'marketing' === $outcome || 'statistics' === $outcome ) {
		$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
	}
	$order->save();

	nowera_capi_browser_leg( 'Purchase', $event_id, $custom_data );
}, 10, 1 );

/**
 * A paid order whose buyer never came back to the thank-you page (common with
 * 24pay's redirect) would never be reported. Wait half an hour first: if the
 * thank-you page does load, it reports the purchase with fresher consent.
 */
function nowera_capi_schedule_purchase_fallback( $order_id ): void {
	$order = wc_get_order( $order_id );
	if ( ! $order || ! function_exists( 'as_schedule_single_action' ) ) {
		return;
	}
	if ( $order->get_meta( '_nowera_capi_purchase_sent' ) || $order->get_meta( '_nowera_capi_purchase_consent' ) || ! $order->get_meta( '_nowera_capi_ctx' ) ) {
		return; // already reported, already decided, or never went through our checkout
	}
	$args = array( (int) $order->get_id() );
	if ( ! as_next_scheduled_action( 'nowera_capi_purchase_fallback', $args, 'nowera-capi' ) ) {
		as_schedule_single_action( time() + 30 * MINUTE_IN_SECONDS, 'nowera_capi_purchase_fallback', $args, 'nowera-capi' );
	}
}
add_action( 'woocommerce_payment_complete', 'nowera_capi_schedule_purchase_fallback' );
add_action( 'woocommerce_order_status_processing', 'nowera_capi_schedule_purchase_fallback' );
add_action( 'woocommerce_order_status_completed', 'nowera_capi_schedule_purchase_fallback' );

add_action( 'nowera_capi_purchase_fallback', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order || $order->get_meta( '_nowera_capi_purchase_sent' ) || $order->get_meta( '_nowera_capi_purchase_consent' ) ) {
		return; // the thank-you page got there first
	}
	$stored = $order->get_meta( '_nowera_capi_ctx' );
	if ( ! is_array( $stored ) ) {
		return;
	}

	// Consent and identifiers as they were at checkout; address and browser as
	// WooCommerce stored them with the order; the time of the payment itself.
	$paid = $order->get_date_paid() ?: $order->get_date_created();
	$ctx  = array(
		'marketing'     => ! empty( $stored['marketing'] ),
		'statistics'    => ! empty( $stored['statistics'] ),
		'fbp'           => $stored['fbp'] ?? null,
		'fbc'           => $stored['fbc'] ?? null,
		'fbclid'        => null,
		'ga_client_id'  => $stored['ga_client_id'] ?? null,
		'ga_session_id' => $stored['ga_session_id'] ?? null,
		'ip'            => (string) $order->get_customer_ip_address(),
		'ua'            => (string) $order->get_customer_user_agent(),
		'event_time'    => $paid ? $paid->getTimestamp() : time(),
		'referrer_url'  => null,
	);
	$user = nowera_capi_user_from_order( $order );
	if ( ! $order->get_customer_id() && ! empty( $stored['visitor'] ) ) {
		$user['external_id'] = (string) $stored['visitor']; // no visitor cookie in this request
	}

	$outcome = nowera_capi_send( 'Purchase', 'ord-' . $order->get_id(), $user, nowera_capi_purchase_data( $order ), $order->get_checkout_order_received_url(), $ctx );
	nowera_capi_record_outcome( $order, $outcome, true );
	if ( 'marketing' === $outcome || 'statistics' === $outcome ) {
		$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
	}
	$order->save();
} );

add_action( 'woocommerce_add_to_cart', function ( $cart_item_key, $product_id, $quantity, $variation_id = 0 ) {
	$product = wc_get_product( $variation_id ?: $product_id );
	if ( ! $product ) {
		return;
	}
	$id = nowera_capi_content_id( $product );
	nowera_capi_send(
		'AddToCart',
		wp_generate_uuid4(),
		nowera_capi_current_user(),
		array(
			'value'        => round( (float) $product->get_price() * (int) $quantity, wc_get_price_decimals() ),
			'currency'     => get_woocommerce_currency(),
			'content_ids'  => array( $id ),
			'contents'     => array( array( 'id' => $id, 'quantity' => (int) $quantity, 'item_price' => (float) $product->get_price() ) ),
			'content_name' => $product->get_name(),
			'content_type' => 'product',
		),
		get_permalink( $product_id )
	);
}, 10, 4 );

add_action( 'woocommerce_before_checkout_form', function () {
	if ( ! WC()->cart || WC()->cart->is_empty() ) {
		return;
	}
	$ids = array();
	foreach ( WC()->cart->get_cart() as $line ) {
		if ( ! empty( $line['data'] ) && $line['data'] instanceof \WC_Product ) {
			$ids[] = nowera_capi_content_id( $line['data'] );
		}
	}
	$event_id    = wp_generate_uuid4();
	$custom_data = array(
		'value'        => (float) WC()->cart->get_total( 'edit' ),
		'currency'     => get_woocommerce_currency(),
		'num_items'    => WC()->cart->get_cart_contents_count(),
		'content_ids'  => array_values( array_unique( $ids ) ),
		'content_type' => 'product',
	);

	nowera_capi_send( 'InitiateCheckout', $event_id, nowera_capi_current_user(), $custom_data, wc_get_checkout_url() );
	// The checkout page is never cached, so the browser leg can share this id.
	nowera_capi_browser_leg( 'InitiateCheckout', $event_id, $custom_data );
} );

/**
 * Best identity available before an order exists. Most checkouts are guests, so
 * falling back to what they typed into the cart/checkout session is what keeps
 * Event Match Quality off the floor.
 */
function nowera_capi_current_user(): array {
	$data = array();

	if ( is_user_logged_in() ) {
		$user = wp_get_current_user();
		$data = array(
			'em'          => $user->user_email,
			'fn'          => $user->first_name,
			'ln'          => $user->last_name,
			'external_id' => (string) $user->ID,
		);
	} elseif ( function_exists( 'WC' ) && WC()->customer ) {
		$customer = WC()->customer;
		$data = array(
			'em'      => $customer->get_billing_email(),
			'ph'      => $customer->get_billing_phone(),
			'fn'      => $customer->get_billing_first_name(),
			'ln'      => $customer->get_billing_last_name(),
			'ct'      => $customer->get_billing_city(),
			'zp'      => $customer->get_billing_postcode(),
			'country' => $customer->get_billing_country(),
		);
	}

	// A returning customer: what this session knows wins, the stored identity
	// fills the gaps (usually everything, for a guest who has not typed yet).
	$data = array_merge( nowera_capi_stored_user(), array_filter( $data ) );

	if ( empty( $data['external_id'] ) ) {
		$visitor = nowera_capi_visitor_id();
		if ( $visitor ) {
			$data['external_id'] = $visitor;
		}
	}

	return array_filter( $data );
}

/**
 * AddPaymentInfo when the checkout is submitted and the order exists, just
 * before the customer is sent to pay. It carries the full billing identity, so
 * it is also the strongest match signal before the purchase itself.
 */
function nowera_capi_add_payment_info( $order ): void {
	$order = $order instanceof \WC_Order ? $order : wc_get_order( $order );
	if ( ! $order ) {
		return;
	}
	// The last moment the buyer is certainly on the site: keep what we know.
	nowera_capi_remember_checkout_context( $order );
	if ( $order->get_meta( '_nowera_capi_payment_info_sent' ) ) {
		$order->save_meta_data();
		return;
	}

	$ids = array();
	foreach ( $order->get_items() as $item ) {
		$product = $item->get_product();
		if ( $product ) {
			$ids[] = nowera_capi_content_id( $product );
		}
	}

	nowera_capi_send(
		'AddPaymentInfo',
		'pay-' . $order->get_id(),
		nowera_capi_user_from_order( $order ),
		array(
			'value'        => (float) $order->get_total(),
			'currency'     => $order->get_currency(),
			'content_ids'  => array_values( array_unique( $ids ) ),
			'content_type' => 'product',
		),
		wc_get_checkout_url()
	);

	$order->update_meta_data( '_nowera_capi_payment_info_sent', time() );
	$order->save_meta_data();
}

// Classic checkout passes the id first; the block checkout passes the order.
add_action( 'woocommerce_checkout_order_processed', function ( $order_id, $posted = array(), $order = null ) {
	nowera_capi_add_payment_info( $order ?: $order_id );
}, 20, 3 );
add_action( 'woocommerce_store_api_checkout_order_processed', 'nowera_capi_add_payment_info', 20, 1 );
