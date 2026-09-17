<?php
// Creates a category, a simple and a variable product, and a customer.
require __DIR__ . '/_bootstrap.php';
nwr_settings();
delete_option( 'nwr_test_captured' );

// The thank-you page lives under the checkout page.
if ( wc_get_page_id( 'checkout' ) <= 0 || ! get_post( wc_get_page_id( 'checkout' ) ) ) {
	WC_Install::create_pages();
}

// Idempotent: the suite calls this on every run against the same Playground.
$existing = get_option( 'nwr_test_ids' );
if ( $existing && wc_get_product( $existing['simple'] ) ) {
	nwr_out( $existing );
	exit;
}

$cat = term_exists( 'Osušky', 'product_cat' ) ?: wp_insert_term( 'Osušky', 'product_cat' );

$simple = new WC_Product_Simple();
$simple->set_name( 'Detská osuška' );
$simple->set_sku( 'KV-OSU-1' );
$simple->set_regular_price( '24.90' );
$simple->set_category_ids( array( (int) $cat['term_id'] ) );
$simple->save();

$attr = new WC_Product_Attribute();
$attr->set_name( 'Veľkosť' );
$attr->set_options( array( 'S', 'M' ) );
$attr->set_visible( true );
$attr->set_variation( true );

$variable = new WC_Product_Variable();
$variable->set_name( 'Deka' );
$variable->set_attributes( array( $attr ) );
$variable->set_category_ids( array( (int) $cat['term_id'] ) );
$variable->save();

$variation_ids = array();
foreach ( array( 'S' => '30', 'M' => '38' ) as $size => $price ) {
	$v = new WC_Product_Variation();
	$v->set_parent_id( $variable->get_id() );
	$v->set_attributes( array( sanitize_title( 'Veľkosť' ) => $size ) );
	$v->set_regular_price( $price );
	$v->save();
	$variation_ids[] = $v->get_id();
}
WC_Product_Variable::sync( $variable->get_id() );

$user_id = username_exists( 'zakaznik' ) ?: wp_create_user( 'zakaznik', wp_generate_password(), 'Zakaznik@Example.com' );
wp_update_user( array( 'ID' => $user_id, 'first_name' => 'Ján', 'last_name' => 'Novák' ) );

$ids = array(
	'simple'     => $simple->get_id(),
	'variable'   => $variable->get_id(),
	'variations' => $variation_ids,
	'category'   => (int) $cat['term_id'],
	'user'       => $user_id,
);
update_option( 'nwr_test_ids', $ids );
nwr_out( $ids );
