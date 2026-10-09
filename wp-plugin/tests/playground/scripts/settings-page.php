<?php
// Renders the admin settings screen and runs the sanitize callback, which the
// frontend tests never touch.
require __DIR__ . '/_bootstrap.php';
require_once ABSPATH . 'wp-admin/includes/template.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
do_action( 'admin_init' );

ob_start();
nowera_capi_render_settings();
$html = ob_get_clean();

global $wp_registered_settings;
$sanitize = $wp_registered_settings['nowera_capi_settings']['sanitize_callback'];

// A pairing code from the dashboard sets host and key; a bad one changes nothing.
$key     = str_repeat( 'ab', 32 );
$code    = 'nwr1.' . rtrim( strtr( base64_encode( wp_json_encode( array( 'h' => 't.novy-klient.sk', 'k' => $key ) ) ), '+/', '-_' ), '=' );
$paired  = call_user_func( $sanitize, array( 'pairing_code' => $code, 'collector_host' => 'old.host', 'ingest_secret' => '' ) );
$bad     = call_user_func( $sanitize, array( 'pairing_code' => 'nwr1.nonsense', 'collector_host' => 'collector.test', 'ingest_secret' => '' ) );
$errors  = get_settings_errors( 'nowera_capi_settings' );
$kept    = call_user_func( $sanitize, array( 'collector_host' => 'https://collector.test/', 'ingest_secret' => '' ) );

// The settings page as it renders under other stored settings; the option is
// written raw (no sanitizer) and put back afterwards.
$raw_update = function ( $value ) use ( $sanitize ) {
	remove_filter( 'sanitize_option_nowera_capi_settings', $sanitize );
	update_option( 'nowera_capi_settings', $value );
	add_filter( 'sanitize_option_nowera_capi_settings', $sanitize );
};
$render_with = function ( array $overrides ) use ( $raw_update ) {
	$before = get_option( 'nowera_capi_settings' );
	$raw_update( array_merge( (array) $before, $overrides ) );
	ob_start();
	nowera_capi_render_settings();
	$page = ob_get_clean();
	$raw_update( $before );
	return $page;
};
$prefix_row = function ( string $page ) {
	return array(
		'hidden' => (bool) preg_match( '/<tr id="nwr_prefix_row"\s+style="display:none">/', $page ),
		'input'  => (bool) preg_match( '/name="nowera_capi_settings\[consent_prefix\]"\s+value="my_"/', $page ),
	);
};
$prefix = array();
foreach ( array( 'none', 'faz', 'cookiescript', 'complianz', 'custom' ) as $mode ) {
	$prefix[ $mode ] = $prefix_row( $render_with( array( 'consent_mode' => $mode, 'consent_prefix' => 'my_' ) ) );
}

// Saving the catalog goes through the sanitizer registered on admin_init.
$offered   = array();
preg_match_all( '/name="nowera_capi_settings\[cpt_catalog\]\[([^\]]+)\]"/', $html, $m );
$offered   = $m[1];
$before    = get_option( 'nowera_capi_settings' );
update_option( 'nowera_capi_settings', array_merge( (array) $before, array( 'cpt_catalog' => array( 'nwr_listing' => 'home_listing', 'post' => 'product', 'nwr_project' => 'evil' ) ) ) );
$saved     = get_option( 'nowera_capi_settings' );
ob_start();
nowera_capi_render_settings();
$saved_page = ob_get_clean();
$raw_update( $before );

nwr_out( array(
	'prefix_row'         => $prefix,
	'cpt_offered'        => $offered,
	'cpt_saved'          => $saved['cpt_catalog'] ?? null,
	'cpt_saved_key_kept' => NWR_TEST_SECRET === ( $saved['ingest_secret'] ?? '' ),
	'cpt_selected'       => (bool) preg_match( '/<option value="home_listing"\s+selected=\'selected\'>/', $saved_page ),
	'cpt_clean'          => call_user_func( $sanitize, array( 'cpt_catalog' => array(
		'nwr_listing'  => 'home_listing',
		'nwr_project'  => 'vehicle',
		'nwr_internal' => 'product',
		'product'      => 'product',
		'page'         => 'product',
		'attachment'   => 'product',
		'nwr_missing'  => 'product',
	) ) )['cpt_catalog'],
	'cpt_bad_value'      => call_user_func( $sanitize, array( 'cpt_catalog' => array( 'nwr_listing' => '<script>', 'nwr_project' => array( 'product' ) ) ) )['cpt_catalog'],
	'cpt_not_array'      => call_user_func( $sanitize, array( 'cpt_catalog' => 'nwr_listing' ) )['cpt_catalog'],
	'cpt_default'        => call_user_func( $sanitize, array() )['cpt_catalog'],
	'has_consent_select' => (bool) preg_match( '/name="nowera_capi_settings\[consent_mode\]"/', $html ),
	'has_prefix_input'   => (bool) preg_match( '/name="nowera_capi_settings\[consent_prefix\]"/', $html ),
	'bogus_mode'         => call_user_func( $sanitize, array( 'consent_mode' => 'evil', 'consent_prefix' => 'x"<script>' ) ),
	'custom_mode'        => call_user_func( $sanitize, array( 'consent_mode' => 'custom', 'consent_prefix' => 'my_' ) ),
	'cookiescript_mode'  => call_user_func( $sanitize, array( 'consent_mode' => 'cookiescript' ) )['consent_mode'],
	'faz_mode'           => call_user_func( $sanitize, array( 'consent_mode' => 'faz' ) )['consent_mode'],
	'has_faz'            => (bool) preg_match( '/<option value="faz"/', $html ),
	'has_ga4_input'      => (bool) preg_match( '/name="nowera_capi_settings\[ga4_tag\]"/', $html ),
	'ga4_ok'             => call_user_func( $sanitize, array( 'ga4_tag' => ' g-abc1234 ' ) )['ga4_tag'],
	'ga4_bad'            => call_user_func( $sanitize, array( 'ga4_tag' => 'G-1"><script>' ) )['ga4_tag'],
	'has_cookiescript'   => (bool) preg_match( '/<option value="cookiescript"/', $html ),
	'key_in_page'        => false !== strpos( $html, NWR_TEST_SECRET ),
	'has_pairing_input'  => (bool) preg_match( '/name="nowera_capi_settings\[pairing_code\]"/', $html ),
	'has_test_button'    => false !== strpos( $html, 'nowera_capi_test' ),
	'paired'             => array( 'host' => $paired['collector_host'], 'key' => $paired['ingest_secret'] === $key ),
	'bad_pairing'        => array( 'host' => $bad['collector_host'], 'key_kept' => NWR_TEST_SECRET === $bad['ingest_secret'], 'error' => $errors[0]['message'] ?? null ),
	'blank_key_kept'     => NWR_TEST_SECRET === $kept['ingest_secret'],
	'host_cleaned'       => $kept['collector_host'],
	'bytes'              => strlen( $html ),
) );
