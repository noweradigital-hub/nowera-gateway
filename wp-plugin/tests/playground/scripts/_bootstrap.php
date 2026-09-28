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
// Real page loads in the suite cannot reach collector.test (only these scripts
// intercept it), so the plugin pauses sending after them; each script starts clean.
delete_transient( 'nowera_capi_pause' );
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
	// The updater asks for the newest release; tests put its description in an option.
	if ( false !== strpos( $url, '/wp/nowera-capi/info.json' ) ) {
		$info = get_option( 'nwr_test_release' );
		return $info
			? array( 'headers' => array(), 'body' => wp_json_encode( $info ), 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array() )
			: array( 'headers' => array(), 'body' => 'not found', 'response' => array( 'code' => 404, 'message' => 'Not Found' ), 'cookies' => array() );
	}
	// ?fail=down: the gateway does not answer; ?fail=401: it refuses the key.
	$fail = get_option( 'nwr_test_fail' );
	if ( 'down' === $fail ) {
		update_option( 'nwr_test_attempts', (int) get_option( 'nwr_test_attempts', 0 ) + 1, false );
		return new WP_Error( 'http_request_failed', 'cURL error 28: Operation timed out' );
	}
	$log   = get_option( 'nwr_test_captured', array() );
	$log[] = array(
		'url'       => $url,
		'signature' => $args['headers']['X-NWR-Signature'] ?? null,
		'timestamp' => $args['headers']['X-NWR-Timestamp'] ?? null,
		'plugin'    => $args['headers']['X-NWR-Plugin'] ?? null,
		'body'      => json_decode( $args['body'], true ),
		'raw'       => $args['body'],
	);
	update_option( 'nwr_test_captured', $log, false );
	return array( 'headers' => array(), 'body' => '{"ok":true}', 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array() );
}, 10, 3 );


const NWR_TEST_SECRET = 'test-secret';

/** Deliver what the plugin queued for after the response, as shutdown would. */
function nwr_flush(): void {
	if ( function_exists( 'nowera_capi_flush_outbox' ) ) {
		nowera_capi_flush_outbox( false );
	}
}

/** Open the checkout page as WordPress would route it, so is_checkout() is true. */
function nwr_on_checkout_page(): void {
	$GLOBALS['wp_query']     = new WP_Query( array( 'page_id' => wc_get_page_id( 'checkout' ) ) );
	$GLOBALS['wp_the_query'] = $GLOBALS['wp_query'];
	// WooCommerce remembers the first answer of is_checkout() for the request, and
	// this script asked before it "opened" the page.
	add_filter( 'woocommerce_is_checkout', '__return_true' );
}

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
