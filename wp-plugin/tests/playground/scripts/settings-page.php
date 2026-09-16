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

nwr_out( array(
	'has_consent_select' => (bool) preg_match( '/name="nowera_capi_settings\[consent_mode\]"/', $html ),
	'has_prefix_input'   => (bool) preg_match( '/name="nowera_capi_settings\[consent_prefix\]"/', $html ),
	'bogus_mode'         => call_user_func( $sanitize, array( 'consent_mode' => 'evil', 'consent_prefix' => 'x"<script>' ) ),
	'custom_mode'        => call_user_func( $sanitize, array( 'consent_mode' => 'custom', 'consent_prefix' => 'my_' ) ),
	'bytes'              => strlen( $html ),
) );
