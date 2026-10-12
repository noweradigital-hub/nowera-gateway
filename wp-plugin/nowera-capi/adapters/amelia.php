<?php
/**
 * Amelia (booking). With its WooCommerce payment, a booking made on the site is
 * an order line that carries the booking in its `ameliabooking` meta: such a
 * line is a booking, named after the service or the event booked. The order
 * list also takes the bookings from Amelia's own tables, so those the staff
 * enter by hand (no order exists for them) are in the reports too.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/** What Amelia stored on an order line, or null for any other line. */
function nowera_capi_amelia_booking( \WC_Order_Item_Product $line ): ?array {
	$booking = $line->get_meta( 'ameliabooking' );
	return is_array( $booking ) && $booking ? $booking : null;
}

add_filter( 'nowera_capi_line_kind', function ( $kind, $line ) {
	return nowera_capi_amelia_booking( $line ) ? 'booking' : $kind;
}, 10, 2 );

add_filter( 'nowera_capi_line_name', function ( $name, $line ) {
	$booking = nowera_capi_amelia_booking( $line );
	// The line itself is always called after the one product Amelia sells through.
	return $booking && ! empty( $booking['name'] ) && is_string( $booking['name'] ) ? $booking['name'] : $name;
}, 10, 2 );

add_filter( 'nowera_capi_ledger_bookings', function ( $rows, $since, $offset = 0 ) {
	global $wpdb;
	$p = $wpdb->prefix . 'amelia_';
	if ( $wpdb->get_var( $wpdb->prepare( 'SHOW TABLES LIKE %s', $p . 'customer_bookings' ) ) !== $p . 'customer_bookings' ) {
		return $rows;
	}
	// Amelia keeps its times in UTC. A booking filled in on the site has `info`
	// (the form's data); one entered in the administration has none. Amelia does
	// not note when a booking changed, so besides the new ones every booking that
	// is still ahead (or took place in the last three days) goes again: those are
	// the ones that get cancelled or moved.
	// phpcs:ignore WordPress.DB.PreparedSQL.InterpolatedNotPrepared -- table names only.
	$found = $wpdb->get_results( $wpdb->prepare(
		"SELECT cb.id, cb.status, cb.price, cb.persons, cb.created, ( cb.info IS NOT NULL ) AS web,
		        a.bookingStart AS starts, a.serviceId AS service_id, s.name AS service,
		        MIN( ev.id ) AS event_id, MIN( ev.name ) AS event, MIN( ep.periodStart ) AS event_starts,
		        MIN( pm.gateway ) AS gateway, MAX( pm.wcOrderId ) AS order_id
		   FROM {$p}customer_bookings cb
		   LEFT JOIN {$p}appointments a ON a.id = cb.appointmentId
		   LEFT JOIN {$p}services s ON s.id = a.serviceId
		   LEFT JOIN {$p}customer_bookings_to_events_periods bp ON bp.customerBookingId = cb.id
		   LEFT JOIN {$p}events_periods ep ON ep.id = bp.eventPeriodId
		   LEFT JOIN {$p}events ev ON ev.id = ep.eventId
		   LEFT JOIN {$p}payments pm ON pm.customerBookingId = cb.id
		  WHERE cb.created >= %s OR a.bookingStart >= %s OR ep.periodStart >= %s
		  GROUP BY cb.id
		  ORDER BY cb.id DESC
		  LIMIT 500 OFFSET %d",
		gmdate( 'Y-m-d H:i:s', (int) $since ),
		gmdate( 'Y-m-d H:i:s', time() - 3 * DAY_IN_SECONDS ),
		gmdate( 'Y-m-d H:i:s', time() - 3 * DAY_IN_SECONDS ),
		max( 0, (int) $offset )
	), ARRAY_A );
	$utc = function ( $value ) {
		$time = $value ? strtotime( $value . ' UTC' ) : false;
		return $time ? (int) $time : null;
	};
	foreach ( (array) $found as $row ) {
		$event  = ! empty( $row['event_id'] );
		$rows[] = array(
			'id'       => 'amelia-' . (int) $row['id'],
			'source'   => $row['web'] ? 'web' : 'staff',
			'type'     => $event ? 'event' : 'appointment',
			'item'     => $event ? 'event-' . (int) $row['event_id'] : 'service-' . (int) $row['service_id'],
			'name'     => mb_substr( (string) ( $event ? $row['event'] : $row['service'] ), 0, 120 ),
			'status'   => (string) $row['status'],
			'created'  => $utc( $row['created'] ),
			'starts'   => $utc( $event ? $row['event_starts'] : $row['starts'] ),
			'price'    => (float) $row['price'] * max( 1, (int) $row['persons'] ),
			'currency' => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : '',
			'order_id' => $row['order_id'] ? (int) $row['order_id'] : null,
		);
	}
	return $rows;
}, 10, 3 );
