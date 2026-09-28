<?php
/**
 * The updater: signature check of a release ZIP and what WordPress is told about
 * a newer version. POST {zip: base64, signature, sha256, version}.
 */
require __DIR__ . '/_bootstrap.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';

$in   = json_decode( (string) file_get_contents( 'php://input' ), true );
$zip  = base64_decode( (string) ( $in['zip'] ?? '' ) );
$sig  = (string) ( $in['signature'] ?? '' );
$sha  = (string) ( $in['sha256'] ?? '' );
$file = 'nowera-capi/nowera-capi.php';

update_option( 'nwr_test_release', array(
	'version'      => (string) ( $in['version'] ?? '9.9.9' ),
	'file'         => 'nowera-capi-9.9.9.zip',
	'download_url' => 'https://collector.test/wp/nowera-capi/nowera-capi-9.9.9.zip',
	'signature'    => $sig,
	'sha256'       => $sha,
	'notes'        => 'Testovacie vydanie.',
), false );
delete_site_transient( 'nowera_capi_release' );
$update = apply_filters( 'update_plugins_signals.nwra.sk', false, get_plugin_data( WP_PLUGIN_DIR . '/' . $file ), $file );

// A description pointing somewhere else is ignored.
update_option( 'nwr_test_release', array( 'version' => '9.9.9', 'download_url' => 'https://evil.test/x.zip', 'signature' => $sig ), false );
$foreign = nowera_capi_release_info( true );

nwr_settings( array( 'auto_update' => 0 ) );
$auto_off = apply_filters( 'auto_update_plugin', true, (object) array( 'plugin' => $file ) );
nwr_settings();
$auto_on = apply_filters( 'auto_update_plugin', false, (object) array( 'plugin' => $file ) );
delete_option( 'nwr_test_release' );
delete_site_transient( 'nowera_capi_release' );

$header = get_plugin_data( WP_PLUGIN_DIR . '/' . $file );
nwr_out( array(
	'valid'       => nowera_capi_verify_release( $zip, $sig, $sha ),
	'tampered'    => nowera_capi_verify_release( $zip . ' ', $sig, '' ),
	'wrong_sha'   => nowera_capi_verify_release( $zip, $sig, str_repeat( '0', 64 ) ),
	'garbage_sig' => nowera_capi_verify_release( $zip, base64_encode( str_repeat( 'x', 64 ) ), '' ),
	'update'      => $update,
	'foreign'     => $foreign,
	'auto_off'    => $auto_off,
	'auto_on'     => $auto_on,
	'update_uri'  => $header['UpdateURI'] ?? null,
	'version'     => $header['Version'] ?? null,
) );
