<?php
/**
 * Fires one server-side event the way WooCommerce would, with the visitor's
 * cookies taken from the query string, and returns what reached the gateway.
 *   ?event=add_to_cart|add_to_cart_variation|checkout|payment_info|purchase
 *   &cookies=cmplz_marketing:allow,_fbp:fb.1.1.2
 *   &ud=<json>   the stored returning-customer cookie (its JSON has commas)
 *   ?event=order_url|order_url_old  only create an order and return its thank-you URL
 *   ?event=login                    run wp_login for the test customer
 */
require __DIR__ . '/_bootstrap.php';
delete_option( 'nwr_test_captured' );

$cookies = array();
foreach ( array_filter( explode( ',', (string) ( $_GET['cookies'] ?? '' ) ) ) as $pair ) {
	[ $k, $v ] = array_pad( explode( ':', $pair, 2 ), 2, '' );
	$cookies[ $k ] = $v;
}
// ?cs=targeting|performance builds a CookieScript decision; ?cs=reject a rejection.
if ( isset( $_GET['cs'] ) ) {
	$cs = sanitize_text_field( wp_unslash( $_GET['cs'] ) );
	$cookies['CookieScriptConsent'] = 'reject' === $cs
		? nwr_cookiescript( array( 'strict' ), 'reject' )
		: nwr_cookiescript( array_merge( array( 'strict' ), array_filter( explode( '|', $cs ) ) ) );
}
if ( isset( $_GET['cs_raw'] ) ) {
	$cookies['CookieScriptConsent'] = wp_unslash( $_GET['cs_raw'] );
}
if ( isset( $_GET['ud'] ) ) {
	$cookies['_nwr_ud'] = wp_unslash( $_GET['ud'] );
}
nwr_cookies( $cookies );

$ids = get_option( 'nwr_test_ids' );
$event = sanitize_key( $_GET['event'] ?? '' );

if ( ! did_action( 'woocommerce_load_cart_from_session' ) && function_exists( 'wc_load_cart' ) ) {
	wc_load_cart();
}

function nwr_order( array $ids ): WC_Order {
	$order = wc_create_order();
	$order->add_product( wc_get_product( $ids['simple'] ), 2 );
	$order->add_product( wc_get_product( $ids['variations'][1] ), 1 );
	$order->set_address( array(
		'first_name' => 'Ján', 'last_name' => 'Novák', 'email' => 'Jan.Novak@Example.com',
		'phone' => '+421 903 123 456', 'city' => 'Banská Bystrica', 'postcode' => '974 01', 'country' => 'SK',
	), 'billing' );
	$order->calculate_totals();
	$order->save();
	return $order;
}

$footer = '';
switch ( $event ) {
	case 'add_to_cart':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 3 );
		break;
	case 'add_to_cart_variation':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['variable'], 1, $ids['variations'][0] );
		break;
	case 'checkout':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 1 );
		WC()->cart->add_to_cart( $ids['variable'], 1, $ids['variations'][1] );
		delete_option( 'nwr_test_captured' ); // only the checkout event, not the add_to_cart ones
		ob_start(); // Woo prints the coupon toggle on this hook
		do_action( 'woocommerce_before_checkout_form', WC()->checkout() );
		ob_end_clean();
		break;
	case 'payment_info':
		$order = nwr_order( $ids );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order ); // retry must not resend
		break;
	case 'payment_info_block':
		$order = nwr_order( $ids );
		do_action( 'woocommerce_store_api_checkout_order_processed', $order );
		break;
	case 'order_url':
	case 'order_url_old':
		$order = nwr_order( $ids );
		if ( 'order_url_old' === $event ) {
			$order->set_date_created( time() - 3 * DAY_IN_SECONDS );
			$order->save();
		}
		nwr_out( array( 'order' => $order->get_id(), 'received_url' => $order->get_checkout_order_received_url() ) );
		exit;
	case 'login':
		$customer = new WC_Customer( $ids['user'] );
		$customer->set_billing_email( 'Fakturacia@Example.com' );
		$customer->set_billing_phone( '0903 123 456' );
		$customer->save();
		$user = get_user_by( 'id', $ids['user'] );
		do_action( 'wp_login', $user->user_login, $user );
		break;
	case 'purchase':
		$order = nwr_order( $ids );
		remove_all_actions( 'wp_footer' ); // keep only the browser leg the thank-you hook queues
		ob_start();
		do_action( 'woocommerce_thankyou', $order->get_id() );
		do_action( 'woocommerce_thankyou', $order->get_id() ); // refresh of the thank-you page
		ob_end_clean();
		ob_start();
		do_action( 'wp_footer' );
		$footer = ob_get_clean();
		break;
	default:
		http_response_code( 400 );
		nwr_out( array( 'error' => 'unknown event' ) );
		exit;
}

$captured = nwr_captured();
foreach ( $captured as &$c ) {
	$c['signature_valid'] = hash_equals( hash_hmac( 'sha256', $c['raw'], NWR_TEST_SECRET ), (string) $c['signature'] );
	unset( $c['raw'] );
}
nwr_out( array( 'event' => $event, 'sent' => $captured, 'footer' => $footer ) );
