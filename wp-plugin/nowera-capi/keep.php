<?php
/**
 * Nowera CAPI — cookie keeper.
 *
 * Safari keeps a cookie written by JavaScript, or by a tracking subdomain that
 * lives on another server, for 7 days only. The same cookie set by the site's
 * own server keeps its full 90 days. px.js calls this file about once a day, and
 * only when the visitor allowed marketing; it writes the visitor's own
 * identifiers back unchanged and reads or stores nothing else.
 *
 * Deliberately standalone — no WordPress bootstrap — so the call costs next to
 * nothing on a shared PHP pool.
 */

header( 'Cache-Control: no-store, max-age=0' );
header( 'X-Robots-Tag: noindex' );

$host = strtolower( (string) preg_replace( '/:\d+$/', '', (string) ( $_SERVER['HTTP_HOST'] ?? '' ) ) );

// Shared identifiers live on the registrable domain (.shop.sk for www.shop.sk),
// like the ones the gateway and the pixel write. An IP or single-label host
// cannot carry a domain attribute, so those get a host-only cookie.
$domain = '';
if ( '' !== $host && false === filter_var( $host, FILTER_VALIDATE_IP ) && false !== strpos( $host, '.' ) ) {
	$domain = '.' . preg_replace( '/^www\./', '', $host );
}

$secure  = ( ! empty( $_SERVER['HTTPS'] ) && 'off' !== $_SERVER['HTTPS'] ) || 'https' === ( $_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '' );
$expires = time() + 90 * 86400;

$shared = array(
	'_fbp'    => '/^fb\.\d\.\d{10,13}\.\d{1,20}$/',
	'_fbc'    => '/^fb\.\d\.\d{10,13}\.[A-Za-z0-9._-]{1,500}$/',
	'_nwr_id' => '/^[A-Za-z0-9_-]{8,64}$/',
);
foreach ( $shared as $name => $pattern ) {
	if ( isset( $_COOKIE[ $name ] ) && is_string( $_COOKIE[ $name ] ) && preg_match( $pattern, $_COOKIE[ $name ] ) ) {
		setcookie( $name, $_COOKIE[ $name ], array(
			'expires'  => $expires,
			'path'     => '/',
			'domain'   => $domain,
			'secure'   => $secure,
			'httponly' => false, // the Meta pixel and px.js read them
			'samesite' => 'Lax',
		) );
	}
}

// The hashed contact details are written host-only by the plugin; keep them so.
if ( isset( $_COOKIE['_nwr_ud'] ) && is_string( $_COOKIE['_nwr_ud'] ) && preg_match( '/^\{[\x20-\x7e]{2,1200}\}$/', $_COOKIE['_nwr_ud'] ) ) {
	setcookie( '_nwr_ud', $_COOKIE['_nwr_ud'], array(
		'expires'  => $expires,
		'path'     => '/',
		'secure'   => $secure,
		'httponly' => false,
		'samesite' => 'Lax',
	) );
}

http_response_code( 204 );
