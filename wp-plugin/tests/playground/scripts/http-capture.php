<?php
// Test only, loaded by a blueprint mu-plugin into real requests (a Store API add
// to cart, ?wc-ajax=nwr_legs) while http.php has it switched on: records what the
// plugin sends to collector.test, and lets the Store API take a cart write
// without the nonce a block page would carry. Never deploy.
add_filter( 'woocommerce_store_api_disable_nonce_check', '__return_true' );
// ?slow=1: the legs pickup takes its time after WooCommerce has read the session,
// so a test can change the cart meanwhile.
if ( get_option( 'nwr_test_slow_legs' ) ) {
	add_action( 'wc_ajax_nwr_legs', function () {
		sleep( 2 );
	}, 9 );
}
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( false === strpos( $url, 'collector.test' ) ) {
		return $pre;
	}
	$log   = get_option( 'nwr_test_captured', array() );
	$log[] = array(
		'url'  => $url,
		'body' => json_decode( $args['body'] ?? '', true ),
	);
	update_option( 'nwr_test_captured', $log, false );
	return array( 'headers' => array(), 'body' => '{"ok":true}', 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array() );
}, 10, 3 );
