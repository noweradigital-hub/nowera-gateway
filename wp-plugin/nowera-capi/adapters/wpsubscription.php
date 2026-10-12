<?php
/**
 * WPSubscription ("Subscriptions for WooCommerce", tables and meta prefixed
 * subscrpt_). A product with the subscription switched on is a subscription;
 * an order the plugin created to charge the next term is a renewal — no visitor
 * placed it, so it is kept in the order list and reported to nobody.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter( 'nowera_capi_line_kind', function ( $kind, $line ) {
	$product = $line->get_product();
	if ( ! $product ) {
		return $kind;
	}
	$on = $product->get_meta( '_subscrpt_enabled' );
	if ( ! $on && $product->get_parent_id() ) {
		$on = get_post_meta( $product->get_parent_id(), '_subscrpt_enabled', true );
	}
	return $on && 'no' !== $on ? 'subscription' : $kind;
}, 10, 2 );

add_filter( 'nowera_capi_order_renewal', function ( $renewal, $order ) {
	global $wpdb;
	static $has_table = null;
	$table = $wpdb->prefix . 'subscrpt_order_relation';
	if ( null === $has_table ) {
		$has_table = $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $table ) ) === $table;
	}
	if ( $renewal || ! $has_table ) {
		return $renewal;
	}
	// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table name only.
	return (bool) $wpdb->get_var( $wpdb->prepare( "SELECT 1 FROM {$table} WHERE order_id = %d AND type = 'renew' LIMIT 1", $order->get_id() ) );
}, 10, 2 );
