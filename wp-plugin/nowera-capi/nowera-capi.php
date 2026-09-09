<?php
/**
 * Plugin Name:  Nowera CAPI
 * Description:  Posiela serverové eventy z WooCommerce do Nowera Gateway (Meta CAPI + GA4) a zdieľa event_id s prehliadačovou vetvou.
 * Version:      0.1.0
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
	printf(
		'<script async src="https://%s/px.js"></script>' . "\n",
		esc_attr( $s['collector_host'] )
	);
}, 1 );

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

	$hashed = array();
	foreach ( $user as $key => $value ) {
		$digest = nowera_capi_hash( $key, $value );
		if ( $digest !== null ) {
			$hashed[ $key ] = $digest;
		}
	}

	$body = wp_json_encode( array(
		'event_name'        => $event_name,
		'event_id'          => $event_id,
		'event_time'        => time(),
		'event_source_url'  => $url ?: home_url( add_query_arg( array() ) ),
		'action_source'     => 'website',
		'user_data'         => $hashed,
		'custom_data'       => $props,
		'fbp'               => isset( $_COOKIE['_fbp'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['_fbp'] ) ) : null,
		'fbc'               => isset( $_COOKIE['_fbc'] ) ? sanitize_text_field( wp_unslash( $_COOKIE['_fbc'] ) ) : null,
		'client_ip_address' => nowera_capi_client_ip(),
		'client_user_agent' => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '',
	) );

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
		'external_id' => $order->get_customer_id() ? (string) $order->get_customer_id() : '',
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
	foreach ( $order->get_items() as $item ) {
		$contents[] = array(
			'id'         => (string) $item->get_product_id(),
			'item_name'  => $item->get_name(),
			'quantity'   => $item->get_quantity(),
			'item_price' => $order->get_item_total( $item, false, true ),
		);
	}

	nowera_capi_send(
		'Purchase',
		$event_id,
		nowera_capi_user_from_order( $order ),
		array(
			'value'        => (float) $order->get_total(),
			'currency'     => $order->get_currency(),
			'order_id'     => $order->get_id(),
			'contents'     => $contents,
			'content_type' => 'product',
			'num_items'    => $order->get_item_count(),
		),
		$order->get_checkout_order_received_url()
	);

	$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
	$order->save();

	// Browser leg with the same event_id, so Meta collapses the two into one conversion.
	add_action( 'wp_footer', function () use ( $event_id, $order ) {
		printf(
			'<script>window.nwr=window.nwr||function(){(window.nwr.q=window.nwr.q||[]).push(arguments)};' .
			'window.nwr("track","Purchase",{value:%s,currency:%s,order_id:%d},{eventID:%s});</script>' . "\n",
			wp_json_encode( (float) $order->get_total() ),
			wp_json_encode( $order->get_currency() ),
			$order->get_id(),
			wp_json_encode( $event_id )
		);
	} );
}, 10, 1 );

add_action( 'woocommerce_add_to_cart', function ( $cart_item_key, $product_id, $quantity ) {
	$product = wc_get_product( $product_id );
	if ( ! $product ) {
		return;
	}
	nowera_capi_send(
		'AddToCart',
		wp_generate_uuid4(),
		nowera_capi_current_user(),
		array(
			'value'        => (float) $product->get_price() * (int) $quantity,
			'currency'     => get_woocommerce_currency(),
			'content_ids'  => array( (string) $product_id ),
			'content_name' => $product->get_name(),
			'content_type' => 'product',
		),
		get_permalink( $product_id )
	);
}, 10, 3 );

add_action( 'woocommerce_before_checkout_form', function () {
	if ( ! WC()->cart || WC()->cart->is_empty() ) {
		return;
	}
	nowera_capi_send(
		'InitiateCheckout',
		wp_generate_uuid4(),
		nowera_capi_current_user(),
		array(
			'value'     => (float) WC()->cart->get_total( 'edit' ),
			'currency'  => get_woocommerce_currency(),
			'num_items' => WC()->cart->get_cart_contents_count(),
		),
		wc_get_checkout_url()
	);
} );

function nowera_capi_current_user(): array {
	if ( ! is_user_logged_in() ) {
		return array();
	}
	$user = wp_get_current_user();
	return array_filter( array(
		'em'          => $user->user_email,
		'fn'          => $user->first_name,
		'ln'          => $user->last_name,
		'external_id' => (string) $user->ID,
	) );
}
