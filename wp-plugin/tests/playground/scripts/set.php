<?php
// Switches plugin settings between test cases: ?consent=none|complianz|custom
require __DIR__ . '/_bootstrap.php';
$mode = sanitize_key( $_GET['consent'] ?? 'none' );
nwr_settings( array( 'consent_mode' => $mode, 'consent_prefix' => 'custom' === $mode ? 'my_' : 'cmplz_' ) );
delete_option( 'nwr_test_captured' );
nwr_out( get_option( 'nowera_capi_settings' ) );
