<?php
// Returns an auth cookie for the test customer so curl can render a signed-in page.
require __DIR__ . '/_bootstrap.php';
$ids  = get_option( 'nwr_test_ids' );
$exp  = time() + HOUR_IN_SECONDS;
nwr_out( array(
	'name'  => LOGGED_IN_COOKIE,
	'value' => wp_generate_auth_cookie( $ids['user'], $exp, 'logged_in' ),
) );
