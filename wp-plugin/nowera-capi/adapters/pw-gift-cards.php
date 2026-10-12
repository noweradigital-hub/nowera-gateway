<?php
/**
 * PW WooCommerce Gift Cards. Selling a gift card is a sale of its own kind.
 * Paying with one is not a discount: the card appears on the order as a line of
 * type pw_gift_card and lowers the order's total. That amount is tender — the
 * money for it was counted when the card was sold.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

add_filter( 'nowera_capi_line_kind', function ( $kind, $line ) {
	// The line holds one of the card's amounts, a variation of the gift-card product.
	$product = wc_get_product( $line->get_product_id() );
	return $product && 'pw-gift-card' === $product->get_type() ? 'gift_card' : $kind;
}, 10, 2 );

add_filter( 'nowera_capi_order_tender', function ( $tender, $order ) {
	foreach ( $order->get_items( 'pw_gift_card' ) as $card ) {
		if ( is_callable( array( $card, 'get_amount' ) ) ) {
			$tender += abs( (float) $card->get_amount() );
		}
	}
	return $tender;
}, 10, 2 );
