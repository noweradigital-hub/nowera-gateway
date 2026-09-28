<?php
/**
 * Removing the plugin removes its settings and scheduled jobs. What it wrote on
 * orders (notes, whether the Purchase was sent) stays: that is order history.
 */
if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}
delete_option( 'nowera_capi_settings' );
delete_option( 'nowera_capi_status' );
delete_transient( 'nowera_capi_pause' );
delete_site_transient( 'nowera_capi_release' );
if ( function_exists( 'as_unschedule_all_actions' ) ) {
	as_unschedule_all_actions( 'nowera_capi_purchase_fallback' );
}
