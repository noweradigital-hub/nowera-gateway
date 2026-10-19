<?php
// Real-request capture for the Store API tests: ?capture=1|0 switches it (and
// clears what was captured), ?slow=1|0 slows the legs pickup down; with no
// argument, returns what real requests sent.
require __DIR__ . '/_bootstrap.php';
if ( isset( $_GET['capture'] ) ) {
	update_option( 'nwr_test_capture_http', '1' === $_GET['capture'] ? 1 : 0, false );
	delete_option( 'nwr_test_captured' );
}
if ( isset( $_GET['slow'] ) ) {
	update_option( 'nwr_test_slow_legs', '1' === $_GET['slow'] ? 1 : 0, false );
}
nwr_out( array( 'on' => (bool) get_option( 'nwr_test_capture_http' ), 'sent' => nwr_captured() ) );
