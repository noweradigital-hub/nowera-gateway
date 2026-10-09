<?php
/**
 * Custom post type catalog (Katalóg z vlastného typu obsahu).
 *   ?catalog=nwr_listing:home_listing,…  save the setting through its sanitizer
 *   &filter=price|price_no_currency|skip  what the site's nowera_capi_cpt_item filter does
 *   ?render=<post id>&cookies=…&cs=…  build that post's page in this process and report
 *                               its page context and what it queued for the gateway
 *   ?woo=off|on                  take WooCommerce out of the active plugins and back
 * Always returns the test posts' ids (created once).
 */
require __DIR__ . '/_bootstrap.php';

$ids = get_option( 'nwr_test_cpt_ids' );
if ( ! $ids || ! get_post( $ids['listing'] ) ) {
	$ids = array(
		'listing' => wp_insert_post( array( 'post_type' => 'nwr_listing', 'post_status' => 'publish', 'post_title' => 'RODINNÝ DOM | <b>TRNAVA</b> & okolie', 'post_name' => 'rodinny-dom-trnava' ) ),
		'draft'   => wp_insert_post( array( 'post_type' => 'nwr_listing', 'post_status' => 'draft', 'post_title' => 'Rozpracovaný inzerát' ) ),
		'locked'  => wp_insert_post( array( 'post_type' => 'nwr_listing', 'post_status' => 'publish', 'post_title' => 'Chránený inzerát', 'post_password' => 'tajne' ) ),
		'project' => wp_insert_post( array( 'post_type' => 'nwr_project', 'post_status' => 'publish', 'post_title' => 'Projekt Sady', 'post_name' => 'projekt-sady' ) ),
		'post'    => wp_insert_post( array( 'post_type' => 'post', 'post_status' => 'publish', 'post_title' => 'Blog', 'post_name' => 'blog-clanok' ) ),
	);
	update_post_meta( $ids['listing'], 'price', '385000' );
	update_option( 'nwr_test_cpt_ids', $ids );
}

if ( isset( $_GET['catalog'] ) ) {
	$input = array();
	foreach ( array_filter( explode( ',', (string) $_GET['catalog'] ) ) as $pair ) {
		[ $type, $content_type ] = array_pad( explode( ':', $pair, 2 ), 2, '' );
		$input[ $type ] = $content_type;
	}
	$settings                = get_option( 'nowera_capi_settings', array() );
	$settings['cpt_catalog'] = nowera_capi_clean_cpt_catalog( $input );
	update_option( 'nowera_capi_settings', $settings );
}
if ( isset( $_GET['filter'] ) ) {
	update_option( 'nwr_test_cpt_filter', sanitize_key( $_GET['filter'] ) );
}

if ( isset( $_GET['woo'] ) ) {
	$active = (array) get_option( 'active_plugins', array() );
	if ( 'off' === $_GET['woo'] ) {
		update_option( 'nwr_test_active_plugins', $active );
		update_option( 'active_plugins', array_values( array_diff( $active, array( 'woocommerce/woocommerce.php' ) ) ) );
	} elseif ( get_option( 'nwr_test_active_plugins' ) ) {
		update_option( 'active_plugins', get_option( 'nwr_test_active_plugins' ) );
		delete_option( 'nwr_test_active_plugins' );
	}
}

$out = array( 'ids' => $ids, 'settings' => nowera_capi_settings()['cpt_catalog'] );

if ( isset( $_GET['render'] ) ) {
	$cookies = array();
	foreach ( array_filter( explode( ',', (string) ( $_GET['cookies'] ?? '' ) ) ) as $pair ) {
		[ $k, $v ] = array_pad( explode( ':', $pair, 2 ), 2, '' );
		$cookies[ $k ] = $v;
	}
	// &cs=targeting|performance: a CookieScript decision (its JSON has commas).
	if ( isset( $_GET['cs'] ) ) {
		$cookies['CookieScriptConsent'] = nwr_cookiescript( array_merge( array( 'strict' ), array_filter( explode( '|', (string) $_GET['cs'] ) ) ) );
	}
	nwr_cookies( $cookies );
	delete_option( 'nwr_test_captured' );
	$post = get_post( absint( $_GET['render'] ) );
	$GLOBALS['wp_query']     = new WP_Query( array( 'p' => $post->ID, 'post_type' => $post->post_type, 'post_status' => 'any' ) );
	$GLOBALS['wp_the_query'] = $GLOBALS['wp_query'];
	$GLOBALS['post']         = $post;
	// This request's own address is the script's, which WordPress would "correct".
	remove_action( 'template_redirect', 'redirect_canonical' );
	remove_action( 'template_redirect', 'wp_old_slug_redirect' );
	ob_start();
	do_action( 'template_redirect' );
	do_action( 'wp_head' );
	do_action( 'wp_footer' );
	$html = ob_get_clean();
	nwr_flush();
	$out['context'] = nowera_capi_page_context();
	$out['head']    = $html;
	$out['sent']    = nwr_captured();
	$out['nocache'] = defined( 'DONOTCACHEPAGE' );
}

nwr_out( $out );
