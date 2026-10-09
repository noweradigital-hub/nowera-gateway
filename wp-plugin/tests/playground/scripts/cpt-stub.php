<?php
// Test only, loaded by a mu-plugin from the blueprint on every request: post
// types standing in for a real-estate site's listings (nwr_listing, like
// ballareality.sk's nh_property), another public type nobody selected and a
// non-public one; and a site's nowera_capi_cpt_item filter, which a test
// switches with the nwr_test_cpt_filter option. Never deploy.
add_action( 'init', function () {
	register_post_type( 'nwr_listing', array( 'public' => true, 'label' => 'Nehnuteľnosti', 'has_archive' => true ) );
	register_post_type( 'nwr_project', array( 'public' => true, 'label' => 'Projekty' ) );
	register_post_type( 'nwr_internal', array( 'public' => false, 'label' => 'Interné' ) );
} );

add_filter( 'nowera_capi_cpt_item', function ( $item, $post ) {
	switch ( get_option( 'nwr_test_cpt_filter' ) ) {
		case 'price':
			$item['item_price']    = get_post_meta( $post->ID, 'price', true );
			$item['currency']      = 'eur';
			$item['item_category'] = 'Rodinné domy';
			$item['id']            = 'not-the-post-id'; // the catalog knows the post ID
			$item['secret']        = 'stays out';
			break;
		case 'price_no_currency':
			$item['item_price'] = 1000;
			break;
		case 'price_inf':
			$item['item_price'] = '1e309';
			$item['currency']   = 'EUR';
			break;
		case 'net_inf':
			$item['item_price'] = 1200;
			$item['price_net']  = '1e309';
			$item['currency']   = 'EUR';
			break;
		case 'skip':
			return false;
	}
	return $item;
}, 10, 2 );
