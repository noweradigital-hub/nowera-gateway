<?php
// Shared bootstrap for the Playground test scripts. Never deploy these.
define( 'WP_DISABLE_FATAL_ERROR_HANDLER', true );
ini_set( 'display_errors', '1' );
error_reporting( E_ALL );
register_shutdown_function( function () {
	$e = error_get_last();
	if ( $e && in_array( $e['type'], array( E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR ), true ) ) {
		echo "\nNWR_FATAL " . json_encode( $e, JSON_UNESCAPED_SLASHES );
	}
} );
require '/wordpress/wp-load.php';
header( 'Content-Type: application/json; charset=utf-8' );
/**
 * Test-only: records every request the plugin would send to the gateway and
 * answers it locally, so the suite needs no network and sees the exact payload.
 * Never deploy.
 */
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( false === strpos( $url, 'collector.test' ) ) {
		return $pre;
	}
	$log   = get_option( 'nwr_test_captured', array() );
	$log[] = array(
		'url'       => $url,
		'signature' => $args['headers']['X-NWR-Signature'] ?? null,
		'body'      => json_decode( $args['body'], true ),
		'raw'       => $args['body'],
	);
	update_option( 'nwr_test_captured', $log, false );
	return array( 'headers' => array(), 'body' => '{"ok":true}', 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array() );
}, 10, 3 );


const NWR_TEST_SECRET = 'test-secret';

function nwr_out( $data ): void {
	echo wp_json_encode( $data, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES );
}

function nwr_captured(): array {
	return get_option( 'nwr_test_captured', array() );
}

function nwr_settings( array $overrides = array() ): void {
	update_option( 'nowera_capi_settings', array_merge( array(
		'collector_host' => 'collector.test',
		'ingest_secret'  => NWR_TEST_SECRET,
		'load_script'    => 1,
		'consent_mode'   => 'none',
		'consent_prefix' => 'cmplz_',
	), $overrides ) );
}

/**
 * Pretend the visitor sent these cookies with the request being simulated.
 * WordPress slashes $_COOKIE on a real request, so do the same here — that is
 * what catches a missing wp_unslash() before a json_decode().
 */
function nwr_cookies( array $cookies ): void {
	foreach ( array( 'cmplz_marketing', 'cmplz_statistics', '_fbp', '_fbc', '_ga', '_nwr_id', 'my_marketing', 'CookieScriptConsent', '_nwr_ud' ) as $k ) {
		unset( $_COOKIE[ $k ] );
	}
	foreach ( $cookies as $k => $v ) {
		$_COOKIE[ $k ] = wp_slash( $v );
	}
}

/** The CookieScriptConsent cookie exactly as CookieScript writes it. */
function nwr_cookiescript( array $categories, string $action = 'accept' ): string {
	return wp_json_encode( array(
		'action'     => $action,
		'categories' => wp_json_encode( $categories ),
		'key'        => 'test-key',
	) );
}
