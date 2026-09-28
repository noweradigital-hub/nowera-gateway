<?php
// Test-only: nowera_capi_phone_digits() for each [number, country] in ?cases=<json>.
require __DIR__ . '/_bootstrap.php';
$cases = json_decode( wp_unslash( $_GET['cases'] ?? '[]' ), true ) ?: array();
nwr_out( array_map( fn( $c ) => nowera_capi_phone_digits( (string) $c[0], $c[1] ?? null ), $cases ) );
