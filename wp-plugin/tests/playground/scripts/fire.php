<?php
/**
 * Fires one server-side event the way WooCommerce would, with the visitor's
 * cookies taken from the query string, and returns what reached the gateway.
 *   ?event=add_to_cart|add_to_cart_variation|checkout|payment_info|purchase
 *   &cookies=cmplz_marketing:allow,_fbp:fb.1.1.2
 *   &ud=<json>   the stored returning-customer cookie (its JSON has commas)
 *   ?event=order_url|order_url_old  only create an order and return its thank-you URL
 *   ?event=login                    run wp_login for the test customer
 *   &ref=<url>   the request's HTTP referer;  &ajax=1  pretend it is an AJAX call
 *   &email=<address>&prior=<status>  purchase: buyer email, and an earlier order in that status
 *   ?event=paid_no_return|paid_with_return  checkout, then the gateway confirms the payment
 *   &as_user=1   act as the signed-in test customer
 */
require __DIR__ . '/_bootstrap.php';
delete_option( 'nwr_test_captured' );

$cookies = array();
foreach ( array_filter( explode( ',', (string) ( $_GET['cookies'] ?? '' ) ) ) as $pair ) {
	[ $k, $v ] = array_pad( explode( ':', $pair, 2 ), 2, '' );
	$cookies[ $k ] = $v;
}
// ?cs=targeting|performance builds a CookieScript decision; ?cs=reject a rejection.
if ( isset( $_GET['cs'] ) ) {
	$cs = sanitize_text_field( wp_unslash( $_GET['cs'] ) );
	$cookies['CookieScriptConsent'] = 'reject' === $cs
		? nwr_cookiescript( array( 'strict' ), 'reject' )
		: nwr_cookiescript( array_merge( array( 'strict' ), array_filter( explode( '|', $cs ) ) ) );
}
if ( isset( $_GET['cs_raw'] ) ) {
	$cookies['CookieScriptConsent'] = wp_unslash( $_GET['cs_raw'] );
}
if ( isset( $_GET['ud'] ) ) {
	$cookies['_nwr_ud'] = wp_unslash( $_GET['ud'] );
}
// FAZ Cookie Manager: &faz=marketing|analytics accepts those; &faz=none decides
// against everything; &faz_undecided=1 writes a cookie without a decision.
if ( isset( $_GET['faz'] ) ) {
	$accepted = array_filter( explode( '|', (string) $_GET['faz'] ) );
	$action   = empty( $_GET['faz_undecided'] ) ? 'yes' : 'no';
	$pairs    = array( 'consentid:t1', "consent:$action", "action:$action", 'necessary:yes' );
	foreach ( array( 'functional', 'analytics', 'performance', 'marketing' ) as $cat ) {
		$pairs[] = $cat . ':' . ( in_array( $cat, $accepted, true ) ? 'yes' : 'no' );
	}
	$pairs[]                       = 'rev:1';
	$cookies['fazcookie-consent'] = implode( ',', $pairs );
}
nwr_cookies( $cookies );

if ( isset( $_GET['ref'] ) ) {
	$_SERVER['HTTP_REFERER'] = wp_unslash( $_GET['ref'] );
}
if ( ! empty( $_GET['ajax'] ) ) {
	add_filter( 'wp_doing_ajax', '__return_true' );
}

$ids = get_option( 'nwr_test_ids' );
$event = sanitize_key( $_GET['event'] ?? '' );

// &as_user=1: the request comes from the signed-in test customer, whose billing
// details hold a national phone number and an address.
if ( ! empty( $_GET['as_user'] ) ) {
	wp_set_current_user( $ids['user'] );
	$customer = new WC_Customer( $ids['user'] );
	$customer->set_billing_phone( '0903 123 456' );
	$customer->set_billing_city( 'Žilina' );
	$customer->set_billing_postcode( '010 01' );
	$customer->save();
	WC()->customer = $customer;
}

if ( ! did_action( 'woocommerce_load_cart_from_session' ) && function_exists( 'wc_load_cart' ) ) {
	wc_load_cart();
}

/** Drops every queued event retry, so a test counts only its own. */
function nwr_cancel_retries(): void {
	foreach ( as_get_scheduled_actions( array( 'hook' => 'nowera_capi_retry_event', 'status' => ActionScheduler_Store::STATUS_PENDING, 'per_page' => -1 ), 'ids' ) as $id ) {
		ActionScheduler::store()->cancel_action( $id );
	}
}

function nwr_order( array $ids, string $email = 'Jan.Novak@Example.com' ): WC_Order {
	$order = wc_create_order();
	$order->add_product( wc_get_product( $ids['simple'] ), 2 );
	$order->add_product( wc_get_product( $ids['variations'][1] ), 1 );
	$order->set_address( array(
		'first_name' => 'Ján', 'last_name' => 'Novák', 'email' => $email,
		'phone' => '+421 903 123 456', 'city' => 'Banská Bystrica', 'postcode' => '974 01', 'country' => 'SK',
	), 'billing' );
	$order->calculate_totals();
	$order->save();
	return $order;
}

$footer = '';
switch ( $event ) {
	case 'add_to_cart':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 3 );
		break;
	case 'add_to_cart_variation':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['variable'], 1, $ids['variations'][0] );
		break;
	case 'checkout':
	case 'checkout_twice':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 1 );
		WC()->cart->add_to_cart( $ids['variable'], 1, $ids['variations'][1] );
		nwr_flush();
		delete_option( 'nwr_test_captured' ); // only the checkout event, not the add_to_cart ones
		remove_all_actions( 'wp_footer' ); // keep only the browser leg this page queues
		nwr_on_checkout_page();
		nowera_capi_maybe_initiate_checkout();
		if ( 'checkout_twice' === $event ) {
			nowera_capi_maybe_initiate_checkout(); // a reload of the same checkout
		}
		ob_start();
		do_action( 'wp_footer' );
		$footer = ob_get_clean();
		break;
	case 'refund_partial':
	case 'refund_full':
	case 'refund_shipping':
	case 'refund_then_cancel':
		// The buyer checks out (consent recorded with the order), pays, then the shop refunds.
		$order = nwr_order( $ids );
		$ship  = new WC_Order_Item_Shipping();
		$ship->set_method_title( 'Kuriér' );
		$ship->set_total( '3.90' );
		$order->add_item( $ship );
		$order->calculate_totals();
		$order->save();
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		$order = wc_get_order( $order->get_id() );
		$order->set_status( 'processing' );
		$order->save();
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		if ( 'refund_shipping' === $event ) {
			$shipping = $order->get_items( 'shipping' );
			$sid      = array_key_first( $shipping );
			wc_create_refund( array(
				'order_id'   => $order->get_id(),
				'amount'     => 3.9,
				'reason'     => 'test',
				'line_items' => array( $sid => array( 'qty' => 0, 'refund_total' => 3.9 ) ),
			) );
		} elseif ( 'refund_partial' === $event || 'refund_then_cancel' === $event ) {
			$items = $order->get_items();
			$first = array_key_first( $items );
			$line  = $items[ $first ];
			$unit  = $order->get_item_total( $line, false, true );
			wc_create_refund( array(
				'order_id'   => $order->get_id(),
				'amount'     => $unit,
				'reason'     => 'test',
				'line_items' => array( $first => array( 'qty' => 1, 'refund_total' => $unit ) ),
			) );
			if ( 'refund_then_cancel' === $event ) {
				$order = wc_get_order( $order->get_id() );
				$order->update_meta_data( '_nowera_capi_purchase_sent', time() ); // it had been counted
				$order->save();
				$order->update_status( 'cancelled' );
			}
		} else {
			$order->update_status( 'refunded' );
		}
		$purchase = array( 'order' => $order->get_id(), 'total' => (float) $order->get_total() );
		break;
	case 'queued':
		// Nothing leaves while the page is still being built.
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 1 );
		$purchase = array( 'before_flush' => count( nwr_captured() ) );
		break;
	case 'atc_ajax':
		// An AJAX add to cart: the fragments of the response carry the browser leg.
		add_filter( 'wp_doing_ajax', '__return_true' );
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 2 );
		$fragments = apply_filters( 'woocommerce_add_to_cart_fragments', array( 'div.widget_shopping_cart_content' => '<div></div>' ) );
		$purchase  = array( 'fragment' => $fragments['nwr_atc'] ?? null, 'pending' => WC()->session->get( 'nowera_capi_legs' ) );
		break;
	case 'atc_form':
		// A plain form post: nothing in fragments, the leg waits for the next page.
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 1 );
		remove_all_actions( 'wp_footer' );
		nowera_capi_pending_legs();
		ob_start();
		do_action( 'wp_footer' );
		$footer   = ob_get_clean();
		$purchase = array( 'nocache' => defined( 'DONOTCACHEPAGE' ), 'left' => WC()->session->get( 'nowera_capi_legs' ) );
		break;
	case 'purchase_gateway_down':
		// The gateway times out while the thank-you page reports the purchase.
		$order = nwr_order( $ids );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		$order = wc_get_order( $order->get_id() );
		$order->set_status( 'processing' );
		$order->save();
		nwr_cancel_retries();
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		delete_transient( 'nowera_capi_pause' );
		update_option( 'nwr_test_attempts', 0, false );
		update_option( 'nwr_test_fail', 'down', false );
		ob_start();
		do_action( 'woocommerce_thankyou', $order->get_id() );
		ob_end_clean();
		WC()->cart->add_to_cart( $ids['simple'], 1 ); // one more event in the same request
		nwr_flush();
		$after_fail = wc_get_order( $order->get_id() );
		$state      = array(
			'attempts'  => (int) get_option( 'nwr_test_attempts' ),
			'paused'    => nowera_capi_gateway_paused(),
			'sent'      => (bool) $after_fail->get_meta( '_nowera_capi_purchase_sent' ),
			'retry'     => (int) $after_fail->get_meta( '_nowera_capi_purchase_retry' ),
			'scheduled' => (bool) as_next_scheduled_action( 'nowera_capi_purchase_fallback', array( (int) $order->get_id() ), 'nowera-capi' ),
			'status'    => get_option( 'nowera_capi_status' ),
			'queued'    => count( as_get_scheduled_actions( array( 'hook' => 'nowera_capi_retry_event', 'status' => ActionScheduler_Store::STATUS_PENDING ), 'ids' ) ),
		);
		// The gateway is back; the scheduled retries run.
		delete_option( 'nwr_test_fail' );
		delete_transient( 'nowera_capi_pause' );
		do_action( 'nowera_capi_purchase_fallback', $order->get_id() );
		foreach ( as_get_scheduled_actions( array( 'hook' => 'nowera_capi_retry_event', 'status' => ActionScheduler_Store::STATUS_PENDING ) ) as $action ) {
			do_action_ref_array( 'nowera_capi_retry_event', $action->get_args() );
		}
		nwr_cancel_retries();
		nwr_flush();
		$fresh    = wc_get_order( $order->get_id() );
		$purchase = array_merge( $state, array(
			'order'      => $fresh->get_id(),
			'sent_after' => (bool) $fresh->get_meta( '_nowera_capi_purchase_sent' ),
			'notes'      => array_map( function ( $n ) { return $n->content; }, wc_get_order_notes( array( 'order_id' => $fresh->get_id(), 'limit' => 5 ) ) ),
		) );
		break;
	case 'payment_info':
		$order = nwr_order( $ids );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order ); // retry must not resend
		break;
	case 'payment_info_block':
		$order = nwr_order( $ids );
		do_action( 'woocommerce_store_api_checkout_order_processed', $order );
		break;
	case 'order_url':
	case 'order_url_old':
		$order = nwr_order( $ids );
		if ( 'order_url_old' === $event ) {
			$order->set_date_created( time() - 3 * DAY_IN_SECONDS );
			$order->save();
		}
		nwr_out( array( 'order' => $order->get_id(), 'received_url' => $order->get_checkout_order_received_url() ) );
		exit;
	case 'login':
		$customer = new WC_Customer( $ids['user'] );
		$customer->set_billing_email( 'Fakturacia@Example.com' );
		$customer->set_billing_phone( '0903 123 456' );
		$customer->save();
		$user = get_user_by( 'id', $ids['user'] );
		do_action( 'wp_login', $user->user_login, $user );
		break;
	case 'purchase':
		$email = isset( $_GET['email'] ) ? sanitize_email( wp_unslash( $_GET['email'] ) ) : 'Jan.Novak@Example.com';
		if ( ! empty( $_GET['prior'] ) ) {
			// An earlier order by the same buyer, stored with the email in lower case.
			$prior = nwr_order( $ids, strtolower( $email ) );
			$prior->set_status( sanitize_key( $_GET['prior'] ) );
			$prior->set_date_created( time() - HOUR_IN_SECONDS );
			$prior->save();
		}
		$order = ! empty( $_GET['reuse'] ) ? wc_get_order( absint( $_GET['reuse'] ) ) : nwr_order( $ids, $email );
		if ( empty( $_GET['reuse'] ) ) {
			// Paid by default; &status=failed|pending|on-hold for the other cases.
			$order->set_status( sanitize_key( $_GET['status'] ?? 'processing' ) );
			if ( ! empty( $_GET['as_user'] ) ) {
				$order->set_customer_id( $ids['user'] );
			}
			$order->save();
		}
		remove_all_actions( 'wp_footer' ); // keep only the browser leg the thank-you hook queues
		ob_start();
		do_action( 'woocommerce_thankyou', $order->get_id() );
		do_action( 'woocommerce_thankyou', $order->get_id() ); // refresh of the thank-you page
		ob_end_clean();
		ob_start();
		do_action( 'wp_footer' );
		$footer = ob_get_clean();
		$fresh    = wc_get_order( $order->get_id() ); // what the plugin wrote to it
		$purchase = array(
			'order'   => $fresh->get_id(),
			'consent' => $fresh->get_meta( '_nowera_capi_purchase_consent' ),
			'sent'    => (bool) $fresh->get_meta( '_nowera_capi_purchase_sent' ),
			'notes'   => array_map(
				function ( $n ) { return $n->content; },
				wc_get_order_notes( array( 'order_id' => $fresh->get_id(), 'limit' => 3 ) )
			),
		);
		break;
	case 'paid_no_return':
	case 'paid_with_return':
	case 'unpaid_return_then_paid':
		$order = nwr_order( $ids );
		$order->set_customer_ip_address( '203.0.113.9' );
		$order->set_customer_user_agent( 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) TestSafari' );
		$order->save();
		// The buyer submits the checkout: this request still carries their cookies.
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		if ( 'unpaid_return_then_paid' === $event ) {
			// Back on the thank-you page before the payment gateway confirmed.
			ob_start();
			do_action( 'woocommerce_thankyou', $order->get_id() );
			ob_end_clean();
		}
		if ( 'paid_with_return' === $event ) {
			// The usual order: the gateway confirms, then the buyer lands on the thank-you page.
			wc_get_order( $order->get_id() )->payment_complete( 'TX-TEST' );
			ob_start();
			do_action( 'woocommerce_thankyou', $order->get_id() );
			ob_end_clean();
		}
		// The payment gateway's confirmation arrives later, without those cookies.
		nwr_cookies( array() );
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		$order = wc_get_order( $order->get_id() );
		if ( 'paid_with_return' !== $event ) {
			$order->payment_complete( 'TX-TEST' );
		}
		$next      = as_next_scheduled_action( 'nowera_capi_purchase_fallback', array( (int) $order->get_id() ), 'nowera-capi' );
		$scheduled = (bool) $next;
		$delay     = is_int( $next ) ? $next - time() : null;
		do_action( 'nowera_capi_purchase_fallback', $order->get_id() ); // now instead of in 30 minutes
		$fresh    = wc_get_order( $order->get_id() );
		$purchase = array(
			'order'     => $fresh->get_id(),
			'scheduled' => $scheduled,
			'delay'     => $delay,
			'consent'   => $fresh->get_meta( '_nowera_capi_purchase_consent' ),
			'sent'      => (bool) $fresh->get_meta( '_nowera_capi_purchase_sent' ),
			'notes'     => array_map(
				function ( $n ) { return $n->content; },
				wc_get_order_notes( array( 'order_id' => $fresh->get_id(), 'limit' => 5 ) )
			),
		);
		break;
	case 'cancel_after_purchase':
	case 'cancel_unpaid':
		$order = nwr_order( $ids );
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		$order = wc_get_order( $order->get_id() );
		if ( 'cancel_after_purchase' === $event ) {
			$order->set_status( 'on-hold' ); // a bank transfer, counted when placed
			$order->save();
			ob_start();
			do_action( 'woocommerce_thankyou', $order->get_id() );
			ob_end_clean();
		}
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		$order = wc_get_order( $order->get_id() );
		$order->update_status( 'cancelled' );
		$order = wc_get_order( $order->get_id() );
		$order->update_status( 'cancelled' ); // saved again: still one refund
		if ( ! empty( $_GET['refund_after'] ) ) {
			// The shop also records a refund in WooCommerce afterwards.
			wc_create_refund( array( 'order_id' => $order->get_id(), 'amount' => $order->get_total(), 'reason' => 'test' ) );
		}
		$purchase = array( 'order' => $order->get_id() );
		break;
	case 'audit':
		// Today's orders: one paid with consent, one failed, one by the admin.
		$paid = nwr_order( $ids );
		do_action( 'woocommerce_checkout_order_processed', $paid->get_id(), array(), $paid );
		$paid = wc_get_order( $paid->get_id() );
		$paid->set_status( 'processing' );
		$paid->save();
		ob_start();
		do_action( 'woocommerce_thankyou', $paid->get_id() );
		ob_end_clean();
		$failed = nwr_order( $ids );
		$failed->set_status( 'failed' );
		$failed->save();
		$admin = nwr_order( $ids );
		$admin->set_created_via( 'admin' );
		$admin->set_status( 'processing' );
		$admin->save();
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		$days     = nowera_capi_send_audit( 1 );
		$purchase = array( 'days' => $days, 'paid' => $paid->get_id(), 'failed' => $failed->get_id(), 'admin' => $admin->get_id(),
			'scheduled' => (bool) as_has_scheduled_action( 'nowera_capi_audit', array(), 'nowera-capi' ) );
		break;
	case 'remove_from_cart':
		WC()->cart->empty_cart();
		$key = WC()->cart->add_to_cart( $ids['simple'], 3 );
		nwr_flush();
		delete_option( 'nwr_test_captured' );
		WC()->cart->set_quantity( $key, 2 );   // one fewer
		WC()->cart->remove_cart_item( $key );  // the rest
		break;
	case 'shipping_info':
		$order = nwr_order( $ids );
		$ship  = new WC_Order_Item_Shipping();
		$ship->set_method_title( 'Kuriér' );
		$ship->set_total( '3.90' );
		$order->add_item( $ship );
		$order->calculate_totals();
		$order->save();
		do_action( 'woocommerce_checkout_order_processed', $order->get_id(), array(), $order );
		break;
	case 'register':
		$email = 'novy.' . wp_generate_password( 6, false ) . '@example.com';
		$id    = wc_create_new_customer( $email, '', wp_generate_password() );
		do_action( 'woocommerce_created_customer', $id, array( 'user_email' => $email ) ); // a second plugin firing it again
		$purchase = array( 'user' => $id, 'email' => $email );
		break;
	case 'form':
		// &role=lead|newsletter|none: how the settings classify this form.
		$role = sanitize_key( $_GET['role'] ?? 'none' );
		nwr_settings( array( 'forms' => 'none' === $role ? array() : array( 'cf7:42' => $role ) ) );
		delete_option( 'nowera_capi_forms_seen' );
		nowera_capi_form_sent( 'cf7', '42', 'Kontakt', array( 'your-name' => 'Ján', 'your-email' => 'Dopyt@Example.com', 'your-phone' => '0903 123 456', 'msg' => 'Dobrý deň' ) );
		$purchase = array( 'seen' => get_option( 'nowera_capi_forms_seen' ) );
		break;
	case 'bricksforge':
		// A Bricksforge Pro Forms submission as its REST handler sends it.
		// &role=lead|newsletter|none for this form; &variant=contact (a page form
		// inside a query loop, with a "Custom" action) | footer (a footer template
		// form) | error (an action reported an error) | nostub (no Bricks helpers)
		// | native (a plain Bricks form's custom action, no Bricksforge) | forged
		// (the page form sent with the footer form as its fallback id; &role then
		// classifies the footer form) | emptymail (no e-mail typed, an address in
		// the message).
		$role    = sanitize_key( $_GET['role'] ?? 'none' );
		$variant = sanitize_key( $_GET['variant'] ?? 'contact' );
		$page_id = (int) $ids['simple'];
		if ( 'nostub' !== $variant ) {
			require_once __DIR__ . '/bricksforge-stub.php';
			\Bricks\Helpers::$data = array(
				$page_id => array(
					array( 'id' => 'cnt001', 'name' => 'brf-pro-forms', 'label' => 'Kontaktný formulár', 'children' => array( 'hd0001', 'tx0001', 'em0002', 'tl0001', 'ta0001' ), 'settings' => array( 'actions' => array( 'email', 'custom' ) ) ),
					array( 'id' => 'hd0001', 'name' => 'brf-pro-forms-field-hidden', 'parent' => 'cnt001', 'settings' => array() ),
					array( 'id' => 'tx0001', 'name' => 'brf-pro-forms-field-text', 'parent' => 'cnt001', 'settings' => array() ),
					array( 'id' => 'em0002', 'name' => 'brf-pro-forms-field-email', 'parent' => 'cnt001', 'settings' => array() ),
					array( 'id' => 'tl0001', 'name' => 'brf-pro-forms-field-tel', 'parent' => 'cnt001', 'settings' => array() ),
					array( 'id' => 'ta0001', 'name' => 'brf-pro-forms-field-textarea', 'parent' => 'cnt001', 'settings' => array() ),
				),
				77 => array(
					array( 'id' => 'nlf001', 'name' => 'brf-pro-forms', 'label' => 'Form', 'settings' => array( 'submission_form_title' => 'Newsletter v pätičke', 'actions' => array( 'create_submission' ) ) ),
					array( 'id' => 'em0001', 'name' => 'brf-pro-forms-field-email', 'parent' => 'nlf001', 'settings' => array( 'id' => 'mail' ) ),
				),
			);
		}
		if ( 'native' === $variant ) {
			nwr_settings( array( 'forms' => array() ) );
			delete_option( 'nowera_capi_forms_seen' );
			$native = new class() {
				public function get_settings() { return array( 'formName' => 'Bricks kontakt' ); }
				public function get_fields() { return array( 'formId' => 'brx001', 'form-field-abc' => 'x@example.com' ); }
			};
			do_action( 'bricks/form/custom_action', $native );
			$purchase = array( 'seen' => get_option( 'nowera_capi_forms_seen' ) );
			break;
		}
		$footer_form = 'footer' === $variant;
		$key         = 'bricksforge:' . ( $footer_form ? 77 : $page_id ) . '-' . ( $footer_form ? 'nlf001' : 'cnt001' );
		$classified  = 'forged' === $variant ? 'bricksforge:77-nlf001' : $key;
		nwr_settings( array( 'forms' => 'none' === $role ? array() : array( $classified => $role ) ) );
		delete_option( 'nowera_capi_forms_seen' );
		$form_data = $footer_form
			? array( 'form-field-mail' => 'News@Example.com' )
			: array(
				'form-field-hd0001' => 'office@example.com',
				'form-field-tx0001' => 'Ján',
				'form-field-em0002' => 'Dopyt@Example.com',
				'form-field-tl0001' => '0903 123 456',
				'form-field-ta0001' => 'Dobrý deň, volajte na 0911 222 333',
			);
		if ( 'emptymail' === $variant ) {
			$form_data['form-field-em0002'] = '';
			$form_data['form-field-ta0001'] = 'jan.novak@example.com';
		}
		$form_data += array(
			'postId'         => (string) $page_id,
			'formId'         => $footer_form ? 'nlf001' : ( 'forged' === $variant ? 'cnt001' : 'q7x9z2' ), // random inside a query loop
			'formIdFallback' => $footer_form || 'forged' === $variant ? 'nlf001' : 'cnt001',
			'referrer'       => home_url( '/kontakt/?utm_source=x' ),
			'fieldIds'       => '{}',
			'fieldLabels'    => '{"em0002":"E-mail"}',
			'hiddenFields'   => '[]',
		);
		$results = 'error' === $variant
			? array( 'results' => array( 'error' => array( array( 'action' => 'email', 'type' => 'error', 'message' => 'Mail failed' ) ) ) )
			: array( 'results' => array( 'success' => array( array( 'action' => 'email', 'type' => 'success' ) ) ) );
		do_action( 'bricksforge/pro_forms/before_submit', $form_data );
		if ( class_exists( '\Bricksforge\ProForms\Actions\Base' ) ) {
			// Its "Custom" action fires the legacy Bricks hook with its own object.
			do_action( 'bricks/form/custom_action', new \Bricksforge\ProForms\Actions\Base( array(), $form_data ) );
		}
		do_action( 'bricksforge/pro_forms/after_submit', $form_data, $results );
		do_action( 'bricksforge/pro_forms/after_submit', $form_data, $results ); // a second listener re-firing it
		$purchase = array( 'seen' => get_option( 'nowera_capi_forms_seen' ), 'key' => $key );
		break;
	case 'cart_page':
		WC()->cart->empty_cart();
		WC()->cart->add_to_cart( $ids['simple'], 2 );
		define( 'WOOCOMMERCE_CART', true );
		$purchase = array( 'page' => nowera_capi_page_context() );
		break;
	default:
		http_response_code( 400 );
		nwr_out( array( 'error' => 'unknown event' ) );
		exit;
}

nwr_flush();
$captured = nwr_captured();
foreach ( $captured as &$c ) {
	// Signed as the gateway checks it: the timestamp, a dot, the body; and recent.
	$c['signature_valid'] = null !== $c['timestamp']
		&& abs( time() - (int) $c['timestamp'] ) < 300
		&& hash_equals( hash_hmac( 'sha256', $c['timestamp'] . '.' . $c['raw'], NWR_TEST_SECRET ), (string) $c['signature'] );
	unset( $c['raw'] );
}
nwr_out( array( 'event' => $event, 'sent' => $captured, 'footer' => $footer, 'purchase' => $purchase ?? null ) );
