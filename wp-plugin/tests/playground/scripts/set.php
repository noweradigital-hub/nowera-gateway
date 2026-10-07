<?php
// Switches plugin settings between test cases: ?consent=none|complianz|custom|cookiescript|faz[&ga4=G-…]
require __DIR__ . '/_bootstrap.php';
$mode = sanitize_key( $_GET['consent'] ?? 'none' );
nwr_settings( array(
	'consent_mode'   => $mode,
	'consent_prefix' => 'custom' === $mode ? 'my_' : 'cmplz_',
	'ga4_tag'        => sanitize_text_field( wp_unslash( $_GET['ga4'] ?? '' ) ),
) );
// FAZ itself is not installed here; a mu-plugin from the blueprint loads a
// stand-in while this option is on. (Files written at runtime would only
// exist in one of Playground's PHP workers, so the switch is an option.)
update_option( 'nwr_test_faz_stub', 'faz' === $mode && '0' !== ( $_GET['stub'] ?? '1' ) ? 1 : 0 );
update_option( 'nwr_test_faz_gcm', isset( $_GET['gcm'] ) ? (int) $_GET['gcm'] : 1 );
update_option( 'nwr_test_faz_revision', isset( $_GET['rev'] ) ? (int) $_GET['rev'] : 1 );
delete_option( 'nwr_test_captured' );
nwr_out( get_option( 'nowera_capi_settings' ) );
