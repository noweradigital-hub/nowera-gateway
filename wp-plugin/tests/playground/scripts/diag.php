<?php
require __DIR__ . '/_bootstrap.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
nwr_out( array(
	'active'      => get_option( 'active_plugins' ),
	'installed'   => array_keys( get_plugins() ),
	'woo_class'   => class_exists( 'WooCommerce' ),
	'capi_loaded' => function_exists( 'nowera_capi_settings' ),
) );
