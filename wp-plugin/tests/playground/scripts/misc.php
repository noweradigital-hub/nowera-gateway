<?php
// Client address handling and WooCommerce compatibility declarations.
require __DIR__ . '/_bootstrap.php';

$ip = function ( array $server ) {
	foreach ( array( 'REMOTE_ADDR', 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR' ) as $k ) {
		unset( $_SERVER[ $k ] );
	}
	foreach ( $server as $k => $v ) {
		$_SERVER[ $k ] = $v;
	}
	return nowera_capi_client_ip();
};

$compat = array();
if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
	foreach ( array( 'custom_order_tables', 'cart_checkout_blocks' ) as $feature ) {
		$list               = \Automattic\WooCommerce\Utilities\FeaturesUtil::get_compatible_plugins_for_feature( $feature );
		$compat[ $feature ] = in_array( 'nowera-capi/nowera-capi.php', $list['compatible'] ?? array(), true );
	}
}

nwr_out( array(
	'via_cloudflare'   => $ip( array( 'REMOTE_ADDR' => '172.68.10.20', 'HTTP_CF_CONNECTING_IP' => '2a02:ab88:1:2::3' ) ),
	'forged_direct'    => $ip( array( 'REMOTE_ADDR' => '198.51.100.7', 'HTTP_CF_CONNECTING_IP' => '203.0.113.99' ) ),
	'local_proxy'      => $ip( array( 'REMOTE_ADDR' => '127.0.0.1', 'HTTP_X_FORWARDED_FOR' => '203.0.113.5, 10.0.0.2' ) ),
	'already_resolved' => $ip( array( 'REMOTE_ADDR' => '203.0.113.8' ) ),
	'compat'           => $compat,
) );
