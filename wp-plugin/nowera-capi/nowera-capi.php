<?php
/**
 * Plugin Name:  Nowera CAPI
 * Description:  Posiela serverové eventy z WooCommerce do Nowera Gateway (Meta CAPI + GA4) a zdieľa event_id s prehliadačovou vetvou.
 * Version:      0.3.1
 * Author:       Nowera
 * License:      GPL-2.0-or-later
 * Requires PHP: 8.0
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const NOWERA_CAPI_OPTION = 'nowera_capi_settings';

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

/** Send one event to the gateway. Non-blocking: never delays the page for the visitor. */
function nowera_capi_send( string $event_name, string $event_id, array $user, array $props, ?string $url = null ): void {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['ingest_secret'] ) ) {
		return;
	}

	$marketing  = nowera_capi_has_consent( 'marketing' );
	$statistics = nowera_capi_has_consent( 'statistics' );
	if ( ! $marketing && ! $statistics ) {
		return; // nobody may receive this event
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

	$ga = nowera_capi_ga_ids();

	$payload = array(
		'event_name'        => $event_name,
		'event_id'          => $event_id,
		'event_time'        => time(),
		'ga_client_id'      => $ga['client_id'],
		'ga_session_id'     => $ga['session_id'],
		'event_source_url'  => $url ?: home_url( add_query_arg( array() ) ),
		'action_source'     => 'website',
		'user_data'         => $hashed,
		'custom_data'       => $props,
		'fbp'               => ( $marketing && isset( $_COOKIE['_fbp'] ) ) ? sanitize_text_field( wp_unslash( $_COOKIE['_fbp'] ) ) : null,
		'fbc'               => ( $marketing && isset( $_COOKIE['_fbc'] ) ) ? sanitize_text_field( wp_unslash( $_COOKIE['_fbc'] ) ) : null,
		'client_ip_address' => nowera_capi_client_ip(),
		'client_user_agent' => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '',
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

	$event_id = 'ord-' . $order->get_id();
	$contents = array();
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

	nowera_capi_send(
		'Purchase',
		$event_id,
		nowera_capi_user_from_order( $order ),
		$custom_data,
		$order->get_checkout_order_received_url()
	);

	$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
	$order->save();

	// Browser leg with the same event_id, so Meta collapses the two into one conversion.
	// It carries the same products: when Meta keeps the pixel copy, that copy must
	// still match the catalog.
	add_action( 'wp_footer', function () use ( $event_id, $custom_data ) {
		printf(
			'<script>window.nwr=window.nwr||function(){(window.nwr.q=window.nwr.q||[]).push(arguments)};' .
			'window.nwr("track","Purchase",%s,{eventID:%s});</script>' . "\n",
			wp_json_encode( $custom_data ),
			wp_json_encode( $event_id )
		);
	} );
}, 10, 1 );

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
	nowera_capi_send(
		'InitiateCheckout',
		wp_generate_uuid4(),
		nowera_capi_current_user(),
		array(
			'value'        => (float) WC()->cart->get_total( 'edit' ),
			'currency'     => get_woocommerce_currency(),
			'num_items'    => WC()->cart->get_cart_contents_count(),
			'content_ids'  => array_values( array_unique( $ids ) ),
			'content_type' => 'product',
		),
		wc_get_checkout_url()
	);
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
	if ( ! $order || $order->get_meta( '_nowera_capi_payment_info_sent' ) ) {
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
