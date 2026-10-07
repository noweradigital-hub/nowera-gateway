<?php
// Stands in for FAZ Cookie Manager 1.33: its consent-cookie helpers (same
// parsing as faz-cookie-manager.php) and its Google Consent Mode settings
// class. Loaded as a mu-plugin by set.php while a test uses consent=faz.
namespace {
	if ( ! function_exists( 'faz_get_valid_consent_cookie' ) ) {
		function faz_get_valid_consent_cookie( $cookie = '' ) {
			if ( '' !== $cookie ) {
				return (string) $cookie;
			}
			if ( ! isset( $_COOKIE['fazcookie-consent'] ) ) {
				return '';
			}
			$raw = sanitize_text_field( wp_unslash( (string) $_COOKIE['fazcookie-consent'] ) );
			if ( false !== strpos( $raw, '%' ) ) {
				$raw = sanitize_text_field( rawurldecode( $raw ) );
			}
			// FAZ drops a decision made under an older policy revision.
			$rev = get_option( 'nwr_test_faz_revision', 1 );
			if ( $rev > 1 && ! preg_match( '/(?:^|,)rev:' . $rev . '(?:,|$)/', $raw ) ) {
				return '';
			}
			return $raw;
		}
		function faz_parse_consent_cookie( $cookie = '' ) {
			$parsed = array();
			foreach ( explode( ',', (string) $cookie ) as $pair ) {
				$parts = explode( ':', trim( $pair ), 2 );
				if ( 2 === count( $parts ) && '' !== trim( $parts[0] ) ) {
					$parsed[ trim( $parts[0] ) ] = trim( $parts[1] );
				}
			}
			return $parsed;
		}
	}
}
namespace FazCookie\Admin\Modules\Gcm\Includes {
	if ( ! class_exists( Gcm_Settings::class ) ) {
		class Gcm_Settings {
			public function is_gcm_enabled() {
				return (bool) get_option( 'nwr_test_faz_gcm', 1 );
			}
		}
	}
}
