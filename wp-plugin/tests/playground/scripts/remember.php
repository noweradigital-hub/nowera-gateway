<?php
require __DIR__ . '/_bootstrap.php';
update_option( 'nwr_test_ids', json_decode( file_get_contents( 'php://input' ), true ) );
nwr_out( array( 'ok' => true ) );
