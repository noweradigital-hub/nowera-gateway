<?php
/**
 * Plugin Name:  Nowera CAPI
 * Description:  Posiela serverové eventy z WooCommerce do Nowera Gateway (Meta CAPI + GA4) a zdieľa event_id s prehliadačovou vetvou.
 * Version:      1.1.0
 * Author:       Nowera
 * License:      GPL-2.0-or-later
 * Requires at least: 6.0
 * Requires PHP: 8.0
 * Update URI:   https://signals.nwra.sk/wp/nowera-capi
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

const NOWERA_CAPI_OPTION  = 'nowera_capi_settings';
const NOWERA_CAPI_VERSION = '1.1.0';

/**
 * Ed25519 public keys whose signature an update must carry. The private key
 * never leaves the release machine, so neither the gateway nor the repository
 * can push code to a site. Several keys allow rotating to a new one.
 */
const NOWERA_CAPI_RELEASE_KEYS = array( 'EkZtQ4CBqMWrwbFSAl5eS11cGNUku9GfX3cVczn9qZc=' );

/** Cloudflare's edge ranges: only from these is CF-Connecting-IP believed. */
const NOWERA_CAPI_CLOUDFLARE = array(
	'173.245.48.0/20', '103.21.244.0/22', '103.22.200.0/22', '103.31.4.0/22',
	'141.101.64.0/18', '108.162.192.0/18', '190.93.240.0/20', '188.114.96.0/20',
	'197.234.240.0/22', '198.41.128.0/17', '162.158.0.0/15', '104.16.0.0/13',
	'104.24.0.0/14', '172.64.0.0/13', '131.0.72.0/22',
	'2400:cb00::/32', '2606:4700::/32', '2803:f800::/32', '2405:b500::/32',
	'2405:8100::/32', '2a06:98c0::/29', '2c0f:f248::/32',
);

/** Contact fields kept, hashed, in the _nwr_ud cookie for returning customers. */
const NOWERA_CAPI_STORED_KEYS = array( 'em', 'ph', 'fn', 'ln', 'ct', 'st', 'zp', 'country' );

/**
 * Calling codes for the countries our shops sell to. Meta matches a phone number
 * only in its full international form, so one typed the national way
 * (0905 123 456) needs the country's code in front of it.
 */
const NOWERA_CAPI_CALLING_CODES = array(
	'SK' => '421', 'CZ' => '420', 'PL' => '48', 'HU' => '36', 'AT' => '43', 'DE' => '49',
	'CH' => '41', 'SI' => '386', 'HR' => '385', 'RO' => '40', 'UA' => '380', 'IT' => '39',
	'FR' => '33', 'GB' => '44', 'IE' => '353', 'NL' => '31', 'BE' => '32', 'ES' => '34',
);

/** What a national number starts with and the international form drops. Default '0'. */
const NOWERA_CAPI_TRUNK_PREFIXES = array( 'HU' => '06', 'IT' => '', 'ES' => '' );

/* -------------------------------------------------------------------------
 * Settings
 * ---------------------------------------------------------------------- */

function nowera_capi_settings(): array {
	$defaults = array(
		'collector_host' => '',
		'ingest_secret'  => '',
		'load_script'    => 1,
		'consent_mode'   => 'none',
		'consent_prefix' => 'cmplz_',
		'auto_update'    => 1,
		'ga4_tag'        => '',
	);
	return wp_parse_args( get_option( NOWERA_CAPI_OPTION, array() ), $defaults );
}

/** A pairing code from the gateway's dashboard: nwr1.<base64url of {"h": host, "k": key}>. */
function nowera_capi_read_pairing( string $code ): ?array {
	if ( ! preg_match( '/^nwr1\.([A-Za-z0-9_-]+)$/', trim( $code ), $m ) ) {
		return null;
	}
	$data = json_decode( (string) base64_decode( strtr( $m[1], '-_', '+/' ) ), true );
	if ( ! is_array( $data ) || ! is_string( $data['h'] ?? null ) || ! is_string( $data['k'] ?? null ) ) {
		return null;
	}
	if ( ! preg_match( '/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i', $data['h'] ) || ! preg_match( '/^[0-9a-f]{64}$/i', $data['k'] ) ) {
		return null;
	}
	return array( 'host' => strtolower( $data['h'] ), 'key' => $data['k'] );
}

// WooCommerce: the plugin reads orders only through the order API, and hooks the block checkout too.
add_action( 'before_woocommerce_init', function () {
	if ( class_exists( \Automattic\WooCommerce\Utilities\FeaturesUtil::class ) ) {
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'custom_order_tables', __FILE__, true );
		\Automattic\WooCommerce\Utilities\FeaturesUtil::declare_compatibility( 'cart_checkout_blocks', __FILE__, true );
	}
} );

add_action( 'admin_menu', function () {
	add_options_page( 'Nowera CAPI', 'Nowera CAPI', 'manage_options', 'nowera-capi', 'nowera_capi_render_settings' );
} );

add_action( 'admin_init', function () {
	register_setting( 'nowera_capi', NOWERA_CAPI_OPTION, array(
		'sanitize_callback' => function ( $input ) {
			$current = nowera_capi_settings();
			$host    = strtolower( preg_replace( '#^https?://|/.*$#i', '', sanitize_text_field( $input['collector_host'] ?? '' ) ) );
			// The key is never printed back into the form: an empty field keeps it.
			$key = sanitize_text_field( $input['ingest_secret'] ?? '' );
			$key = '' === $key ? $current['ingest_secret'] : $key;
			if ( ! empty( $input['pairing_code'] ) ) {
				$pair = nowera_capi_read_pairing( (string) $input['pairing_code'] );
				if ( $pair ) {
					$host = $pair['host'];
					$key  = $pair['key'];
				} else {
					add_settings_error( NOWERA_CAPI_OPTION, 'pairing', 'Párovací kód nie je platný — skopírujte ho z administrácie gatewaya celý.' );
				}
			}
			return array(
				'collector_host' => $host,
				'ingest_secret'  => $key,
				'auto_update'    => empty( $input['auto_update'] ) ? 0 : 1,
				'load_script'    => empty( $input['load_script'] ) ? 0 : 1,
				'consent_mode'   => in_array( $input['consent_mode'] ?? 'none', array( 'none', 'faz', 'cookiescript', 'complianz', 'custom' ), true )
					? $input['consent_mode']
					: 'none',
				'consent_prefix' => preg_replace( '/[^a-zA-Z0-9_\-]/', '', $input['consent_prefix'] ?? 'cmplz_' ) ?: 'cmplz_',
				'ga4_tag'        => preg_match( '/^G-[A-Z0-9]{4,20}$/', strtoupper( trim( (string) ( $input['ga4_tag'] ?? '' ) ) ) )
					? strtoupper( trim( (string) $input['ga4_tag'] ) )
					: '',
			);
		},
	) );
} );

function nowera_capi_render_settings(): void {
	$s      = nowera_capi_settings();
	$status = get_option( 'nowera_capi_status', array() );
	$status = is_array( $status ) ? $status : array();
	$test   = get_transient( 'nowera_capi_test_' . get_current_user_id() );
	if ( $test ) {
		delete_transient( 'nowera_capi_test_' . get_current_user_id() );
	}
	$ago = function ( $t ) {
		return $t ? sprintf( 'pred %s', human_time_diff( (int) $t ) ) : '—';
	};
	?>
	<div class="wrap">
		<h1>Nowera CAPI <span style="font-size:13px;color:#646970;font-weight:400"><?php echo esc_html( NOWERA_CAPI_VERSION ); ?></span></h1>
		<?php if ( is_array( $test ) ) : ?>
			<div class="notice notice-<?php echo $test['ok'] ? 'success' : 'error'; ?>"><p><?php echo esc_html( $test['message'] ); ?></p></div>
		<?php endif; ?>
		<?php if ( $s['collector_host'] && $s['ingest_secret'] ) : ?>
			<p>
				<?php if ( ! empty( $status['failing'] ) ) : ?>
					<strong style="color:#b32d2e">Posledné odoslanie zlyhalo</strong> <?php echo esc_html( $ago( $status['error_at'] ?? 0 ) ); ?>:
					<code><?php echo esc_html( $status['error'] ?? '' ); ?></code>
				<?php else : ?>
					Posledné doručenie do gatewaya: <strong><?php echo esc_html( $ago( $status['ok_at'] ?? 0 ) ); ?></strong>
				<?php endif; ?>
			</p>
			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin:0 0 12px">
				<input type="hidden" name="action" value="nowera_capi_test">
				<?php wp_nonce_field( 'nowera_capi_test' ); ?>
				<?php submit_button( 'Otestovať spojenie', 'secondary', 'submit', false ); ?>
				<span class="description">Overí, že gateway odpovedá a prijme podpis tohto webu. Nevytvorí žiadny event.</span>
			</form>
		<?php endif; ?>
		<form method="post" action="options.php">
			<?php settings_fields( 'nowera_capi' ); ?>
			<table class="form-table" role="presentation">
				<tr>
					<th scope="row"><label for="nwr_pairing">Párovací kód</label></th>
					<td>
						<input id="nwr_pairing" class="large-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[pairing_code]"
						       value="" placeholder="nwr1.…" autocomplete="off">
						<p class="description">Z administrácie gatewaya (Nový klient alebo Nastavenia → Vygenerovať kľúč). Vyplní collector host aj kľúč naraz.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_host">Collector host</label></th>
					<td>
						<input id="nwr_host" class="regular-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[collector_host]"
						       value="<?php echo esc_attr( $s['collector_host'] ); ?>" placeholder="t.klient.sk">
						<p class="description">Bez <code>https://</code>. Musí sedieť s hostom nastaveným v Gateway administrácii.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_secret">Kľúč</label></th>
					<td>
						<input id="nwr_secret" class="regular-text code" type="password" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[ingest_secret]"
						       value="" autocomplete="new-password" placeholder="<?php echo $s['ingest_secret'] ? esc_attr( 'uložený — nechajte prázdne' ) : ''; ?>">
						<p class="description">Kľúč tohto webu z administrácie gatewaya. Podpisuje serverové eventy. Prázdne pole ponechá uložený kľúč.</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Aktualizácie</th>
					<td>
						<label>
							<input type="checkbox" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[auto_update]" value="1" <?php checked( $s['auto_update'] ); ?>>
							Inštalovať nové verzie automaticky
						</label>
						<p class="description">Vydania prichádzajú z gatewaya a inštalujú sa, len ak ich podpis sedí s kľúčom zabudovaným v plugine.</p>
					</td>
				</tr>
				<tr>
					<th scope="row">Loader</th>
					<td>
						<label>
							<input type="checkbox" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[load_script]" value="1" <?php checked( $s['load_script'] ); ?>>
							Vložiť <code>px.js</code> do hlavičky
						</label>
						<p class="description">Vypnite, ak loader vkladáte cez GTM alebo ručne.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_consent">Súhlas s cookies</label></th>
					<td>
						<select id="nwr_consent" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[consent_mode]">
							<option value="none" <?php selected( $s['consent_mode'], 'none' ); ?>>Nekontrolovať (meria sa vždy)</option>
							<option value="faz" <?php selected( $s['consent_mode'], 'faz' ); ?>>FAZ Cookie Manager</option>
							<option value="cookiescript" <?php selected( $s['consent_mode'], 'cookiescript' ); ?>>CookieScript</option>
							<option value="complianz" <?php selected( $s['consent_mode'], 'complianz' ); ?>>Complianz</option>
							<option value="custom" <?php selected( $s['consent_mode'], 'custom' ); ?>>Iný nástroj (cookie s prefixom)</option>
						</select>
						<p class="description">
							Meta dostane eventy len so súhlasom <strong>marketing</strong>, GA4 so súhlasom <strong>statistics</strong>
							(vo FAZ kategórie <code>marketing</code> a <code>analytics</code>, v CookieScripte <code>targeting</code> a <code>performance</code>).
							Pri inom nástroji zavolajte po rozhodnutí návštevníka <code>nwr('consent')</code>.
						</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_prefix">Prefix súhlasových cookies</label></th>
					<td>
						<input id="nwr_prefix" class="regular-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[consent_prefix]"
						       value="<?php echo esc_attr( $s['consent_prefix'] ); ?>">
						<p class="description">Complianz predvolene <code>cmplz_</code> — cookie <code>cmplz_marketing=allow</code>.</p>
					</td>
				</tr>
				<tr>
					<th scope="row"><label for="nwr_ga4_tag">Google tag (GA4)</label></th>
					<td>
						<input id="nwr_ga4_tag" class="regular-text code" type="text" name="<?php echo esc_attr( NOWERA_CAPI_OPTION ); ?>[ga4_tag]"
						       value="<?php echo esc_attr( $s['ga4_tag'] ); ?>" placeholder="G-XXXXXXXXXX">
						<p class="description">
							Vloží do hlavičky len <code>gtag('config')</code>: page_view, relácie, cookies <code>_ga</code> a gclid pre Google Ads.
							E-commerce udalosti posiela signals (GA4 destinácia „Všetky okrem page_view“). Iný GA4 kód (GTM, Site Kit, ručný v hlavičke) odstráňte.
							Pri nástroji na súhlasy ho načíta <code>px.js</code> až po súhlase so štatistikou — pred súhlasom nejde do Google nič.
							Bez loadera <code>px.js</code> sa vloží len na webe bez nástroja na súhlasy.
						</p>
					</td>
				</tr>
			</table>
			<?php submit_button(); ?>
		</form>
	</div>
	<?php
}

/* -------------------------------------------------------------------------
 * Loader
 * ---------------------------------------------------------------------- */

add_action( 'wp_head', function () {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['load_script'] ) ) {
		return;
	}
	$config = array();

	if ( 'none' !== $s['consent_mode'] ) {
		$config[] = 'window.nwrConsent=' . wp_json_encode( array(
			'mode'   => $s['consent_mode'],
			'prefix' => $s['consent_prefix'],
		) ) . ';';
	}
	if ( $s['ga4_tag'] ) {
		$config[] = nowera_capi_gtag_stub( $s );
	}

	// What this page is. Identical for every visitor, so it is safe in cached HTML.
	$page = nowera_capi_page_context();
	if ( $page ) {
		$config[] = 'window.nwrPage=' . wp_json_encode( $page ) . ';';
	}

	// This site's own endpoint that re-sets our identifiers from its server,
	// which Safari keeps for 90 days instead of 7. Same for every visitor.
	$config[] = 'window.nwrKeep=' . wp_json_encode( plugins_url( 'keep.php', __FILE__ ) ) . ';';

	// Hashed identifiers only for signed-in customers, whose pages are never
	// served from the shared page cache. For a guest this line could be cached
	// and handed to every later visitor as if they were the same person; guest
	// identity reaches Meta through the server leg at checkout instead.
	if ( is_user_logged_in() ) {
		$identity = array();
		$current  = nowera_capi_current_user();
		unset( $current['account'] ); // the server events carry the account
		foreach ( $current as $key => $value ) {
			$digest = nowera_capi_hash( $key, $value, $current['country'] ?? null );
			if ( $digest !== null ) {
				$identity[ $key ] = $digest;
			}
		}
		if ( $identity ) {
			$config[] = 'window.nwrUser=' . wp_json_encode( $identity ) . ';';
		}
	}

	if ( $config ) {
		printf( '<script>%s</script>' . "\n", implode( '', $config ) );
	}

	printf(
		'<script async src="https://%s/px.js"></script>' . "\n",
		esc_attr( $s['collector_host'] )
	);
}, 1 );

/**
 * The Google tag, configuration only. It keeps what only a browser tag can do:
 * page views, sessions, the _ga cookies and gclid, which the server events then
 * join. Ecommerce events come from the gateway, so none are sent from here.
 *
 * With px.js on the page, the page only names the tag (window.nwrGtag, printed
 * before px.js so it is there whenever px.js runs) under a denied consent
 * default; px.js loads it once the visitor allows statistics, so nothing goes to
 * Google before that ("basic" consent mode). Cache-safe: the same for everyone.
 */
function nowera_capi_gtag_stub( array $s ): string {
	$js = 'window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}';
	if ( 'none' !== $s['consent_mode'] ) {
		// Google wants a consent default first; a consent tool's own one wins.
		$js .= 'if(!dataLayer.some(function(a){return a&&a[0]===\'consent\'&&a[1]===\'default\';}))'
			. 'gtag(\'consent\',\'default\',{ad_storage:\'denied\',ad_user_data:\'denied\',ad_personalization:\'denied\',analytics_storage:\'denied\'});';
	}
	return $js . 'window.nwrGtag=' . wp_json_encode( $s['ga4_tag'] ) . ';';
}

/**
 * Without px.js the tag can only run straight from the page — and only on a
 * site that does not ask for consent, since nothing here could wait for it.
 */
add_action( 'wp_head', function () {
	$s = nowera_capi_settings();
	if ( ! $s['ga4_tag'] || ( ! empty( $s['load_script'] ) && ! empty( $s['collector_host'] ) ) || 'none' !== $s['consent_mode'] ) {
		return;
	}
	printf(
		'<script async src="https://www.googletagmanager.com/gtag/js?id=%1$s"></script>' . "\n" .
		'<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag(\'js\',new Date());gtag(\'config\',%2$s);</script>' . "\n",
		esc_attr( $s['ga4_tag'] ),
		wp_json_encode( $s['ga4_tag'] )
	);
}, 20 );

/* -------------------------------------------------------------------------
 * Consent, catalog ids, page context
 * ---------------------------------------------------------------------- */

/**
 * Whether the visitor behind this request agreed to a consent category.
 * 'marketing' gates Meta, 'statistics' gates GA4.
 */
function nowera_capi_has_consent( string $category ): bool {
	$s = nowera_capi_settings();
	if ( 'none' === $s['consent_mode'] ) {
		return true;
	}

	if ( 'faz' === $s['consent_mode'] ) {
		$map = array( 'marketing' => 'marketing', 'statistics' => 'analytics' );
		$faz = nowera_capi_faz_consent();
		return isset( $map[ $category ] ) && 'yes' === ( $faz['action'] ?? '' ) && 'yes' === ( $faz[ $map[ $category ] ] ?? '' );
	}

	if ( 'cookiescript' === $s['consent_mode'] ) {
		$map = array( 'marketing' => 'targeting', 'statistics' => 'performance' );
		return isset( $map[ $category ] ) && in_array( $map[ $category ], nowera_capi_cookiescript_categories(), true );
	}

	// Complianz reports into the WP Consent API when that plugin is present.
	if ( 'complianz' === $s['consent_mode'] && function_exists( 'wp_has_consent' ) ) {
		return (bool) wp_has_consent( $category );
	}
	$name = $s['consent_prefix'] . $category;
	return isset( $_COOKIE[ $name ] ) && 'allow' === sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) );
}

/**
 * The visitor's FAZ Cookie Manager decision as key => value, e.g.
 *   array( 'action' => 'yes', 'analytics' => 'no', 'marketing' => 'yes', 'rev' => '1' ).
 * Read only through FAZ's own helpers, which also discard a decision made under
 * an older policy revision. Without FAZ there is no valid decision at all.
 */
function nowera_capi_faz_consent(): array {
	if ( ! function_exists( 'faz_get_valid_consent_cookie' ) || ! function_exists( 'faz_parse_consent_cookie' ) ) {
		return array();
	}
	$raw = faz_get_valid_consent_cookie();
	return '' === $raw ? array() : faz_parse_consent_cookie( $raw );
}

/**
 * Categories the visitor accepted in CookieScript. Its cookie is JSON whose
 * "categories" field is itself a JSON string, e.g.
 *   {"action":"accept","categories":"[\"targeting\",\"performance\"]"}
 * WordPress adds slashes to $_COOKIE, so it has to be unslashed before decoding.
 */
function nowera_capi_cookiescript_categories(): array {
	if ( empty( $_COOKIE['CookieScriptConsent'] ) || ! is_string( $_COOKIE['CookieScriptConsent'] ) ) {
		return array();
	}
	$data = json_decode( wp_unslash( $_COOKIE['CookieScriptConsent'] ), true );
	if ( ! is_array( $data ) ) {
		return array();
	}
	$categories = $data['categories'] ?? array();
	if ( is_string( $categories ) ) {
		$categories = json_decode( $categories, true );
	}
	return is_array( $categories ) ? array_values( array_filter( $categories, 'is_string' ) ) : array();
}

/**
 * The id Meta's catalog knows this product by. Meta for WooCommerce syncs the
 * catalog, so its own helper is the source of truth; the same filter is honoured
 * when that plugin is absent so a customised retailer id still matches.
 */
function nowera_capi_content_id( \WC_Product $product ): string {
	if ( class_exists( 'WC_Facebookcommerce_Utils' ) && is_callable( array( 'WC_Facebookcommerce_Utils', 'get_fb_retailer_id' ) ) ) {
		return (string) \WC_Facebookcommerce_Utils::get_fb_retailer_id( $product );
	}
	return (string) apply_filters( 'wc_facebook_fb_retailer_id', (string) $product->get_id(), $product );
}

function nowera_capi_product_price( \WC_Product $product ): float {
	return nowera_capi_product_prices( $product )[0];
}

/**
 * The product's price as the shop shows it (what Meta gets, comparable with an
 * order total that includes VAT) and without VAT (what GA4 counts as revenue).
 */
function nowera_capi_product_prices( \WC_Product $product ): array {
	$raw  = $product->is_type( 'variable' ) ? (float) $product->get_variation_price( 'min' ) : (float) $product->get_price();
	$args = array( 'qty' => 1, 'price' => $raw );
	return array( (float) wc_get_price_including_tax( $product, $args ), (float) wc_get_price_excluding_tax( $product, $args ) );
}

/**
 * One product as GA4 and Meta describe it: catalog id, the name without the
 * variation, category path, brand and variant. Meta gets the name, brand and
 * category under its own keys (the gateway maps them).
 */
function nowera_capi_item( \WC_Product $product, $quantity = 1, ?float $price = null, ?float $price_net = null ): array {
	$parent = $product->get_parent_id() ? wc_get_product( $product->get_parent_id() ) : null;
	$base   = $parent ?: $product;
	if ( null === $price ) {
		list( $price, $price_net ) = nowera_capi_product_prices( $product );
	}
	$decimals = wc_get_price_decimals();
	$item     = array(
		'id'         => nowera_capi_content_id( $product ),
		'item_name'  => wp_strip_all_tags( $base->get_name() ),
		'quantity'   => (int) $quantity,
		'item_price' => round( $price, $decimals ),
		// GA4 counts revenue without VAT; Meta never sees this field.
		'price_net'  => round( null === $price_net ? $price : $price_net, $decimals ),
	);
	foreach ( nowera_capi_category_path( $base->get_id() ) as $i => $name ) {
		$item[ 0 === $i ? 'item_category' : 'item_category' . ( $i + 1 ) ] = $name;
	}
	$brand = nowera_capi_brand( $base );
	if ( '' !== $brand ) {
		$item['item_brand'] = $brand;
	}
	if ( $product->is_type( 'variation' ) ) {
		$variant = wp_strip_all_tags( (string) wc_get_formatted_variation( $product, true, false, false ) );
		if ( '' !== $variant ) {
			$item['item_variant'] = $variant;
		}
	}
	return $item;
}

/** Category names from the top down to the product's deepest category, at most five. */
function nowera_capi_category_path( int $product_id ): array {
	static $cache = array();
	if ( isset( $cache[ $product_id ] ) ) {
		return $cache[ $product_id ];
	}
	$path  = array();
	$terms = get_the_terms( $product_id, 'product_cat' );
	if ( is_array( $terms ) && $terms ) {
		$best  = null;
		$depth = -1;
		foreach ( $terms as $term ) {
			$d = count( get_ancestors( $term->term_id, 'product_cat', 'taxonomy' ) );
			if ( $d > $depth ) {
				$best  = $term;
				$depth = $d;
			}
		}
		if ( $best && (int) $best->term_id !== (int) get_option( 'default_product_cat' ) ) {
			foreach ( array_reverse( get_ancestors( $best->term_id, 'product_cat', 'taxonomy' ) ) as $ancestor ) {
				$term = get_term( $ancestor, 'product_cat' );
				if ( $term && ! is_wp_error( $term ) ) {
					$path[] = wp_strip_all_tags( $term->name );
				}
			}
			$path[] = wp_strip_all_tags( $best->name );
		}
	}
	$path = (array) apply_filters( 'nowera_capi_item_categories', array_slice( $path, 0, 5 ), $product_id );
	return $cache[ $product_id ] = array_values( array_slice( $path, 0, 5 ) );
}

/** The product's brand from the common brand taxonomies or a brand attribute; filterable. */
function nowera_capi_brand( \WC_Product $product ): string {
	$brand = '';
	foreach ( array( 'product_brand', 'pwb-brand', 'yith_product_brand', 'berocket_brand', 'pa_brand', 'pa_znacka' ) as $taxonomy ) {
		if ( ! taxonomy_exists( $taxonomy ) ) {
			continue;
		}
		$terms = get_the_terms( $product->get_id(), $taxonomy );
		if ( is_array( $terms ) && $terms ) {
			$brand = $terms[0]->name;
			break;
		}
	}
	return (string) apply_filters( 'nowera_capi_item_brand', wp_strip_all_tags( $brand ), $product );
}

/** An order (or refund) line as an item; `$priced_by` is the refund for a refund line. */
function nowera_capi_order_item( \WC_Order_Item_Product $line, \WC_Abstract_Order $priced_by ): array {
	$product  = $line->get_product();
	$quantity = abs( (int) $line->get_quantity() );
	$price    = abs( (float) $priced_by->get_item_total( $line, true, true ) );
	$net      = abs( (float) $priced_by->get_item_total( $line, false, true ) );
	$item     = $product
		? nowera_capi_item( $product, $quantity, $price, $net )
		: array(
			'id'         => (string) ( $line->get_variation_id() ?: $line->get_product_id() ),
			'item_name'  => $line->get_name(),
			'quantity'   => $quantity,
			'item_price' => $price,
			'price_net'  => $net,
		);
	// A coupon's share per unit, without VAT like GA4's price, next to the discounted price.
	if ( $quantity && ! $priced_by instanceof \WC_Order_Refund ) {
		$discount = ( (float) $line->get_subtotal() - (float) $line->get_total() ) / $quantity;
		if ( $discount > 0.004 ) {
			$item['discount'] = round( $discount, wc_get_price_decimals() );
		}
	}
	return $item;
}

/** What is in the cart, as items. */
function nowera_capi_cart_items(): array {
	$items = array();
	if ( ! function_exists( 'WC' ) || ! WC()->cart ) {
		return $items;
	}
	foreach ( WC()->cart->get_cart() as $line ) {
		if ( empty( $line['data'] ) || ! $line['data'] instanceof \WC_Product ) {
			continue;
		}
		$quantity = max( 1, (int) $line['quantity'] );
		$items[]  = nowera_capi_item( $line['data'], $quantity, ( (float) $line['line_total'] + (float) $line['line_tax'] ) / $quantity, (float) $line['line_total'] / $quantity );
	}
	return $items;
}

/**
 * Describes the current shop page for the browser leg: a product, a category
 * or a search. Mirrors what Meta for WooCommerce used to send, so catalog
 * matching and audiences keep working after its own tracking is switched off.
 */
function nowera_capi_page_context(): ?array {
	if ( ! function_exists( 'is_product' ) ) {
		return null;
	}
	$currency = get_woocommerce_currency();

	if ( is_product() ) {
		$product = wc_get_product( get_queried_object_id() );
		if ( ! $product ) {
			return null;
		}
		$id    = nowera_capi_content_id( $product );
		$item  = nowera_capi_item( $product );
		$price = $item['item_price'];
		$cats  = wp_get_post_terms( $product->get_id(), 'product_cat', array( 'fields' => 'names' ) );
		return array(
			'type' => 'product',
			'data' => array(
				'content_name'     => wp_strip_all_tags( $product->get_name() ),
				'content_ids'      => array( $id ),
				'content_type'     => $product->is_type( array( 'variable', 'grouped' ) ) ? 'product_group' : 'product',
				'contents'         => array( $item ),
				'content_category' => is_array( $cats ) ? implode( ', ', $cats ) : '',
				'value'            => $price,
				'value_net'        => $item['price_net'],
				'currency'         => $currency,
			),
		);
	}

	global $wp_query;
	$listed = function ( string $list ) use ( $wp_query ) {
		$ids      = array();
		$contents = array();
		$group    = false;
		foreach ( array_slice( (array) $wp_query->posts, 0, 10 ) as $index => $post ) {
			$product = wc_get_product( $post );
			if ( ! $product ) {
				continue;
			}
			$item                   = nowera_capi_item( $product );
			$item['index']          = $index;
			$item['item_list_name'] = $list;
			$ids[]                  = $item['id'];
			$contents[]             = $item;
			$group                  = $group || $product->is_type( 'variable' );
		}
		return array( $ids, $contents, $group ? 'product_group' : 'product' );
	};

	if ( is_product_category() ) {
		$term = get_queried_object();
		list( $ids, $contents, $type ) = $listed( wp_strip_all_tags( $term->name ) );
		return array(
			'type' => 'category',
			'data' => array(
				'content_name'     => $term->name,
				'content_category' => $term->name,
				'item_list_name'   => wp_strip_all_tags( $term->name ),
				'content_ids'      => $ids,
				'content_type'     => $type,
				'contents'         => $contents,
				'currency'         => $currency,
			),
		);
	}

	if ( is_search() && '' !== get_search_query() && 'product' === get_query_var( 'post_type' ) ) {
		list( $ids, $contents, $type ) = $listed( 'search' );
		return array(
			'type' => 'search',
			'data' => array(
				'search_string' => get_search_query(),
				'item_list_name' => 'search',
				'content_ids'   => $ids,
				'content_type'  => $type,
				'contents'      => $contents,
				'currency'      => $currency,
			),
		);
	}

	return null;
}

/* -------------------------------------------------------------------------
 * Transport
 * ---------------------------------------------------------------------- */

/**
 * E-mail and phone hashed the way Google matches them, which is not Meta's way:
 * Gmail addresses without dots in the name, the phone in E.164 with its "+".
 * Values that arrive hashed already (a returning visitor's cookie) are Meta's
 * hashes and cannot be converted, so they are left out.
 */
function nowera_capi_google_user( array $user ): array {
	$out   = array();
	$email = strtolower( trim( (string) ( $user['em'] ?? '' ) ) );
	if ( '' !== $email && ! preg_match( '/^[a-f0-9]{64}$/', $email ) && is_email( $email ) ) {
		list( $name, $domain ) = explode( '@', $email, 2 );
		if ( in_array( $domain, array( 'gmail.com', 'googlemail.com' ), true ) ) {
			$name = str_replace( '.', '', $name );
		}
		$out['sha256_email_address'] = array( hash( 'sha256', $name . '@' . $domain ) );
	}
	$phone = (string) ( $user['ph'] ?? '' );
	if ( '' !== $phone && ! preg_match( '/^[a-f0-9]{64}$/i', $phone ) ) {
		$digits = nowera_capi_phone_digits( $phone, $user['country'] ?? null );
		if ( strlen( $digits ) >= 8 ) {
			$out['sha256_phone_number'] = array( hash( 'sha256', '+' . $digits ) );
		}
	}
	return $out;
}

/**
 * Meta's normalization rules, mirrored from the gateway's hash.js so a value
 * hashed here produces the same digest as one hashed there.
 */
function nowera_capi_hash( string $key, $value, ?string $country = null ): ?string {
	if ( $value === null || $value === '' ) {
		return null;
	}
	$value = (string) $value;
	if ( preg_match( '/^[a-f0-9]{64}$/i', $value ) ) {
		return strtolower( $value ); // already hashed upstream
	}

	$lower = mb_strtolower( trim( $value ), 'UTF-8' );
	switch ( $key ) {
		case 'em':
			$normalized = $lower;
			break;
		case 'ph':
			$normalized = nowera_capi_phone_digits( $value, $country );
			break;
		case 'fn':
		case 'ln':
		case 'ct':
			$normalized = preg_replace( '/[^\p{L}]/u', '', $lower );
			break;
		case 'st':
			$normalized = substr( preg_replace( '/[^\p{L}]/u', '', $lower ), 0, 2 );
			break;
		case 'zp':
			$normalized = preg_replace( '/\s/', '', $lower );
			break;
		case 'country':
			$normalized = substr( $lower, 0, 2 );
			break;
		default:
			$normalized = $lower;
	}

	return $normalized === '' ? null : hash( 'sha256', $normalized );
}

/**
 * A phone number as Meta keys it: digits only, country code first, no plus and
 * no trunk prefix. $country is the ISO code the number belongs to (the billing
 * country); without one the shop's own country is assumed.
 */
function nowera_capi_phone_digits( string $value, ?string $country ): string {
	$digits = preg_replace( '/\D/', '', $value );
	if ( '' === $digits ) {
		return '';
	}

	// Written internationally: +421…, 00421…, or the common +421 0905… slip.
	if ( str_starts_with( ltrim( $value ), '+' ) || str_starts_with( $digits, '00' ) ) {
		$digits = ltrim( $digits, '0' );
		$codes  = NOWERA_CAPI_CALLING_CODES;
		uasort( $codes, fn( $a, $b ) => strlen( $b ) <=> strlen( $a ) );
		foreach ( $codes as $iso => $code ) {
			if ( str_starts_with( $digits, $code ) ) {
				$trunk = NOWERA_CAPI_TRUNK_PREFIXES[ $iso ] ?? '0';
				$rest  = substr( $digits, strlen( $code ) );
				if ( '' !== $trunk && str_starts_with( $rest, $trunk ) ) {
					$digits = $code . substr( $rest, strlen( $trunk ) );
				}
				break;
			}
		}
		return $digits;
	}

	$country = strtoupper( (string) $country );
	if ( ! preg_match( '/^[A-Z]{2}$/', $country ) ) {
		$country = function_exists( 'WC' ) && WC()->countries ? (string) WC()->countries->get_base_country() : '';
	}
	$code = NOWERA_CAPI_CALLING_CODES[ $country ] ?? null;
	if ( null === $code ) {
		return ltrim( $digits, '0' ); // a country we have no rule for
	}

	// Typed with the country code but without the plus: 421905123456.
	if ( str_starts_with( $digits, $code ) && strlen( $digits ) >= strlen( $code ) + 8 ) {
		return $digits;
	}
	$trunk = NOWERA_CAPI_TRUNK_PREFIXES[ $country ] ?? '0';
	if ( '' !== $trunk && str_starts_with( $digits, $trunk ) ) {
		$digits = substr( $digits, strlen( $trunk ) );
	}
	return $code . $digits;
}

/**
 * GA4 joins a Measurement Protocol hit to the visitor's browser session by these
 * two ids. Without them the event lands as Direct and is useless for Ads import.
 */
/**
 * The session id inside a _ga_<stream> cookie, in either format GA4 writes:
 * GS2.1.s<session>$o<count>$g… (current) or GS1.1.<session>.<count>.… (older).
 */
function nowera_capi_ga_session( string $raw ): ?string {
	if ( preg_match( '/^GS2\.\d+\.(.*)$/', $raw, $m ) ) {
		return preg_match( '/(?:^|\$)s(\d+)/', $m[1], $s ) ? $s[1] : null;
	}
	$parts = explode( '.', $raw );
	return count( $parts ) >= 3 && ctype_digit( $parts[2] ) ? $parts[2] : null;
}

function nowera_capi_ga_ids(): array {
	$client_id = null;
	$session_id = null;

	if ( ! empty( $_COOKIE['_ga'] ) ) {
		$parts = explode( '.', sanitize_text_field( wp_unslash( $_COOKIE['_ga'] ) ) );
		if ( count( $parts ) >= 4 ) {
			$client_id = $parts[ count( $parts ) - 2 ] . '.' . $parts[ count( $parts ) - 1 ];
		}
	}

	// The session cookie is named after the stream id, which we do not configure
	// anywhere — find whichever _ga_* cookie this property set.
	foreach ( $_COOKIE as $name => $value ) {
		if ( strpos( $name, '_ga_' ) !== 0 ) {
			continue;
		}
		$session_id = nowera_capi_ga_session( sanitize_text_field( wp_unslash( $value ) ) );
		if ( null !== $session_id ) {
			break;
		}
	}

	return array( 'client_id' => $client_id, 'session_id' => $session_id );
}

/* -------------------------------------------------------------------------
 * Returning customers
 * ---------------------------------------------------------------------- */

/**
 * Hashed contact details stored after a purchase or a login. Read by px.js on
 * every later page (cached ones too) and by the server events below, so a
 * returning customer is recognised before they type anything.
 */
function nowera_capi_stored_user(): array {
	if ( empty( $_COOKIE['_nwr_ud'] ) || ! is_string( $_COOKIE['_nwr_ud'] ) ) {
		return array();
	}
	$data = json_decode( wp_unslash( $_COOKIE['_nwr_ud'] ), true );
	if ( ! is_array( $data ) ) {
		return array();
	}
	$out = array();
	foreach ( NOWERA_CAPI_STORED_KEYS as $key ) {
		if ( isset( $data[ $key ] ) && is_string( $data[ $key ] ) && preg_match( '/^[a-f0-9]{64}$/i', $data[ $key ] ) ) {
			$out[ $key ] = strtolower( $data[ $key ] );
		}
	}
	return $out;
}

/**
 * Store the hashed identity for later visits. Only with marketing consent, and
 * only when there is an email or a phone: a name alone identifies nobody.
 */
function nowera_capi_remember_user( array $raw ): void {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || headers_sent() || ! nowera_capi_has_consent( 'marketing' ) ) {
		return;
	}
	$hashed = array();
	foreach ( NOWERA_CAPI_STORED_KEYS as $key ) {
		$digest = isset( $raw[ $key ] ) ? nowera_capi_hash( $key, $raw[ $key ], $raw['country'] ?? null ) : null;
		if ( $digest !== null ) {
			$hashed[ $key ] = $digest;
		}
	}
	if ( empty( $hashed['em'] ) && empty( $hashed['ph'] ) ) {
		return;
	}

	// A response that sets a personal cookie must never be served from a page cache.
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	do_action( 'litespeed_control_set_nocache', 'nowera-capi: returning-customer cookie' );
	nocache_headers();

	$value = wp_json_encode( $hashed );
	setcookie( '_nwr_ud', $value, array(
		'expires'  => time() + 90 * DAY_IN_SECONDS,
		'path'     => '/',
		'secure'   => is_ssl(),
		'httponly' => false, // px.js reads it
		'samesite' => 'Lax',
	) );
	$_COOKIE['_nwr_ud'] = wp_slash( $value );
}

/**
 * A visitor arriving from a Meta ad carries ?fbclid=. The loader normally turns
 * it into the _fbc cookie; this is the fallback for when it cannot run — the
 * click id is what ties the later purchase back to the ad.
 */
function nowera_capi_capture_fbclid(): void {
	if ( empty( $_GET['fbclid'] ) || isset( $_COOKIE['_fbc'] ) || headers_sent() ) {
		return;
	}
	if ( ! nowera_capi_has_consent( 'marketing' ) ) {
		return;
	}
	$fbclid = sanitize_text_field( wp_unslash( $_GET['fbclid'] ) );
	if ( ! preg_match( '/^[A-Za-z0-9._-]{1,500}$/', $fbclid ) ) {
		return;
	}

	// Meta's own shape: fb.<subdomain index>.<created at, ms>.<click id>.
	$value  = 'fb.1.' . ( time() * 1000 ) . '.' . $fbclid;
	$host   = (string) wp_parse_url( home_url(), PHP_URL_HOST );
	$domain = ( defined( 'COOKIE_DOMAIN' ) && COOKIE_DOMAIN ) ? COOKIE_DOMAIN : '.' . preg_replace( '/^www\./', '', $host );

	// This response now carries one visitor's click id, so it must not be cached.
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	do_action( 'litespeed_control_set_nocache', 'nowera-capi: click id cookie' );
	nocache_headers();

	setcookie( '_fbc', $value, array(
		'expires'  => time() + 90 * DAY_IN_SECONDS,
		'path'     => '/',
		'domain'   => $domain,
		'secure'   => is_ssl(),
		'httponly' => false, // the Meta pixel reads it too
		'samesite' => 'Lax',
	) );
	$_COOKIE['_fbc'] = $value;
}

// The thank-you page of a fresh order: the buyer's own contact details. The order
// key proves the link came from checkout, the age check keeps an old forwarded
// link from tagging somebody else's browser.
add_action( 'template_redirect', function () {
	nowera_capi_capture_fbclid();

	if ( ! function_exists( 'is_order_received_page' ) || ! is_order_received_page() ) {
		return;
	}
	$order_id = absint( get_query_var( 'order-received' ) );
	$key      = isset( $_GET['key'] ) ? wc_clean( wp_unslash( $_GET['key'] ) ) : '';
	$order    = $order_id ? wc_get_order( $order_id ) : false;
	if ( ! $order || '' === $key || ! hash_equals( $order->get_order_key(), (string) $key ) ) {
		return;
	}
	$created = $order->get_date_created();
	if ( ! $created || $created->getTimestamp() < time() - DAY_IN_SECONDS ) {
		return;
	}
	nowera_capi_remember_user( nowera_capi_user_from_order( $order ) );
}, 5 );

// A login: the account's billing details, which are usually the ones ads know.
add_action( 'wp_login', function ( $login, $user ) {
	if ( ! $user instanceof \WP_User ) {
		return;
	}
	$raw = array(
		'em' => $user->user_email,
		'fn' => $user->first_name,
		'ln' => $user->last_name,
	);
	if ( class_exists( 'WC_Customer' ) ) {
		try {
			$customer = new \WC_Customer( $user->ID );
			$raw      = array_merge( $raw, array_filter( array(
				'em'      => $customer->get_billing_email(),
				'ph'      => $customer->get_billing_phone(),
				'fn'      => $customer->get_billing_first_name(),
				'ln'      => $customer->get_billing_last_name(),
				'ct'      => $customer->get_billing_city(),
				'zp'      => $customer->get_billing_postcode(),
				'country' => $customer->get_billing_country(),
			) ) );
		} catch ( \Exception $e ) {
			// No customer record: the account fields above are still useful.
		}
	}
	nowera_capi_remember_user( $raw );
}, 10, 2 );

/** First-party visitor id set by the gateway; often a guest's only stable identifier. */
function nowera_capi_visitor_id(): ?string {
	return empty( $_COOKIE['_nwr_id'] )
		? null
		: sanitize_text_field( wp_unslash( $_COOKIE['_nwr_id'] ) );
}

/** Whether an address lies in a CIDR range, IPv4 or IPv6. */
function nowera_capi_ip_in( string $ip, string $cidr ): bool {
	[ $net, $bits ] = array_pad( explode( '/', $cidr, 2 ), 2, null );
	$a = @inet_pton( $ip );
	$b = @inet_pton( (string) $net );
	if ( false === $a || false === $b || strlen( $a ) !== strlen( $b ) ) {
		return false;
	}
	$bits  = (int) $bits;
	$bytes = intdiv( $bits, 8 );
	if ( substr( $a, 0, $bytes ) !== substr( $b, 0, $bytes ) ) {
		return false;
	}
	$rest = $bits % 8;
	if ( 0 === $rest ) {
		return true;
	}
	$mask = ( 0xff << ( 8 - $rest ) ) & 0xff;
	return ( ord( $a[ $bytes ] ) & $mask ) === ( ord( $b[ $bytes ] ) & $mask );
}

/**
 * The visitor's address. CF-Connecting-IP and X-Forwarded-For are believed only
 * when the request came through Cloudflare or a proxy on the hosting's own
 * network; from anywhere else they are whatever the sender typed.
 */
function nowera_capi_client_ip(): string {
	$remote = isset( $_SERVER['REMOTE_ADDR'] ) ? trim( sanitize_text_field( wp_unslash( $_SERVER['REMOTE_ADDR'] ) ) ) : '';
	$remote = filter_var( $remote, FILTER_VALIDATE_IP ) ? $remote : '';
	$proxied = '' === $remote
		|| ! filter_var( $remote, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE );
	foreach ( NOWERA_CAPI_CLOUDFLARE as $range ) {
		if ( $proxied ) {
			break;
		}
		$proxied = nowera_capi_ip_in( $remote, $range );
	}
	if ( $proxied ) {
		foreach ( array( 'HTTP_CF_CONNECTING_IP', 'HTTP_X_FORWARDED_FOR' ) as $key ) {
			if ( ! empty( $_SERVER[ $key ] ) ) {
				$ip = trim( explode( ',', sanitize_text_field( wp_unslash( $_SERVER[ $key ] ) ) )[0] );
				if ( filter_var( $ip, FILTER_VALIDATE_IP ) ) {
					return $ip;
				}
			}
		}
	}
	return $remote;
}

/**
 * The referrer of the page this request renders, for events fired during a
 * full page load (checkout, thank-you page). An AJAX or REST call's referrer is
 * the page itself, not the one before it, so those get none. Query string and
 * fragment are dropped: on a same-site referrer they can hold order keys.
 */
function nowera_capi_page_referrer( ?string $event_url ): ?string {
	if ( empty( $_SERVER['HTTP_REFERER'] ) || wp_doing_ajax() || wp_doing_cron() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
		return null;
	}
	$parts = wp_parse_url( esc_url_raw( wp_unslash( $_SERVER['HTTP_REFERER'] ) ) );
	if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) || ! in_array( $parts['scheme'], array( 'http', 'https' ), true ) ) {
		return null;
	}
	$referrer = $parts['scheme'] . '://' . $parts['host'] . ( isset( $parts['port'] ) ? ':' . $parts['port'] : '' ) . ( $parts['path'] ?? '/' );
	if ( $event_url && strtok( $event_url, '?#' ) === $referrer ) {
		return null; // the page referring to itself, e.g. a form posted back
	}
	return $referrer;
}

/**
 * Whether the buyer has ordered before: an earlier order under the same account
 * or billing email that was not abandoned, failed or cancelled. Custom statuses
 * (shipped, delivered…) count, since they come after payment.
 */
function nowera_capi_customer_segment( \WC_Order $order ): ?string {
	$email       = (string) $order->get_billing_email();
	$customer_id = (int) $order->get_customer_id();
	if ( '' === $email && ! $customer_id ) {
		return null;
	}

	$skip     = array( 'wc-pending', 'wc-failed', 'wc-cancelled', 'wc-checkout-draft' );
	$statuses = array_values( array_diff( array_keys( wc_get_order_statuses() ), $skip ) );
	$args     = array(
		'type'    => 'shop_order',
		'status'  => $statuses,
		'exclude' => array( $order->get_id() ),
		'limit'   => 1,
		'return'  => 'ids',
	);
	$created = $order->get_date_created();
	if ( $created ) {
		$args['date_created'] = '<' . $created->getTimestamp();
	}

	$lookups = array();
	if ( $customer_id ) {
		$lookups[] = array( 'customer_id' => $customer_id );
	}
	if ( '' !== $email ) {
		$lookups[] = array( 'billing_email' => $email );
		if ( strtolower( $email ) !== $email ) {
			$lookups[] = array( 'billing_email' => strtolower( $email ) );
		}
	}
	foreach ( $lookups as $lookup ) {
		if ( wc_get_orders( array_merge( $args, $lookup ) ) ) {
			return 'existing_customer_to_business';
		}
	}
	return 'new_customer_to_business';
}

/**
 * What the current request tells us about the visitor: consent, and the
 * identifiers that may travel with it. An event built later, when the visitor
 * is gone (a payment confirmed by the gateway), passes a stored copy instead.
 */
function nowera_capi_request_context(): array {
	$marketing  = nowera_capi_has_consent( 'marketing' );
	$statistics = nowera_capi_has_consent( 'statistics' );
	$ga         = nowera_capi_ga_ids();
	$cookie     = function ( string $name ) use ( $marketing ) {
		return ( $marketing && isset( $_COOKIE[ $name ] ) ) ? sanitize_text_field( wp_unslash( $_COOKIE[ $name ] ) ) : null;
	};
	return array(
		'marketing'     => $marketing,
		'statistics'    => $statistics,
		'fbp'           => $cookie( '_fbp' ),
		'fbc'           => $cookie( '_fbc' ),
		// No cookie yet on the very landing page the ad click opened.
		'fbclid'        => ( $marketing && ! empty( $_GET['fbclid'] ) ) ? sanitize_text_field( wp_unslash( $_GET['fbclid'] ) ) : null,
		'ga_client_id'  => $ga['client_id'],
		'ga_session_id' => $ga['session_id'],
		'ip'            => nowera_capi_client_ip(),
		'ua'            => isset( $_SERVER['HTTP_USER_AGENT'] ) ? sanitize_text_field( wp_unslash( $_SERVER['HTTP_USER_AGENT'] ) ) : '',
	);
}

/**
 * Queue one event for the gateway; it leaves after the page has been sent to
 * the visitor (see nowera_capi_flush_outbox). Returns what happened, so a caller
 * can record it on the order: 'marketing' (Meta will get it), 'statistics' (only
 * GA4 may), 'none' (the visitor gave no consent) or 'not_configured'. A Purchase
 * passes its order, so a failed delivery is retried from the order.
 */
function nowera_capi_send( string $event_name, string $event_id, array $user, array $props, ?string $url = null, ?array $ctx = null, ?int $order_id = null ): string {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['ingest_secret'] ) ) {
		return 'not_configured';
	}

	$ctx        = $ctx ?? nowera_capi_request_context();
	$marketing  = ! empty( $ctx['marketing'] );
	$statistics = ! empty( $ctx['statistics'] );
	if ( ! $marketing && ! $statistics ) {
		return 'none'; // nobody may receive this event
	}
	// A customer account: GA4's user_id, the same person on every device. Hashed
	// with the site's address, so it is no WordPress user number in the clear.
	$account = ! empty( $user['account'] ) ? hash( 'sha256', 'nwr-account|' . home_url( '/' ) . '|' . $user['account'] ) : null;
	unset( $user['account'] );
	// Contact data under Google's normalisation, for GA4 user-provided data and
	// Google Ads enhanced conversions. Advertising use: marketing consent only.
	$google_user = $marketing ? nowera_capi_google_user( $user ) : array();
	if ( ! $marketing ) {
		// Contact details and the visitor id are only for advertising use.
		$user = array_intersect_key( $user, array( 'country' => true ) );
	}

	$hashed = array();
	foreach ( $user as $key => $value ) {
		$digest = nowera_capi_hash( $key, $value, $user['country'] ?? null );
		if ( $digest !== null ) {
			$hashed[ $key ] = $digest;
		}
	}

	$source_url = $url ?: home_url( add_query_arg( array() ) );

	$payload = array(
		'event_name'        => $event_name,
		'event_id'          => $event_id,
		'event_time'        => isset( $ctx['event_time'] ) ? (int) $ctx['event_time'] : time(),
		'ga_client_id'      => $ctx['ga_client_id'] ?? null,
		'ga_session_id'     => $ctx['ga_session_id'] ?? null,
		'event_source_url'  => $source_url,
		'referrer_url'      => array_key_exists( 'referrer_url', $ctx ) ? $ctx['referrer_url'] : nowera_capi_page_referrer( $source_url ),
		'action_source'     => 'website',
		'user_data'         => $hashed,
		'account_id'        => $account,
		'google_user'       => $google_user ?: null,
		'custom_data'       => $props,
		'fbp'               => $marketing ? ( $ctx['fbp'] ?? null ) : null,
		'fbc'               => $marketing ? ( $ctx['fbc'] ?? null ) : null,
		'fbclid'            => $marketing ? ( $ctx['fbclid'] ?? null ) : null,
		'client_ip_address' => $ctx['ip'] ?? '',
		'client_user_agent' => $ctx['ua'] ?? '',
	);
	if ( 'none' !== $s['consent_mode'] ) {
		$payload['consent'] = array( 'marketing' => $marketing, 'statistics' => $statistics );
	}
	// No page ever showed this event (a refund, a purchase paid without a return
	// to the site): an analytics tag in the browser cannot have reported it.
	if ( ! empty( $ctx['browserless'] ) ) {
		$payload['browserless'] = true;
	}
	nowera_capi_outbox( array(
		'event'    => $event_name,
		'body'     => wp_json_encode( $payload ),
		'order_id' => $order_id,
	) );

	return $marketing ? 'marketing' : 'statistics';
}

/* -------------------------------------------------------------------------
 * Delivery, after the page has gone to the visitor
 * ---------------------------------------------------------------------- */

/**
 * Events of this request wait here. Called with an event, adds it (and makes
 * sure the queue is flushed at shutdown); called without, hands the queue over
 * and empties it.
 */
function nowera_capi_outbox( ?array $item = null ): array {
	static $queue  = array();
	static $hooked = false;
	if ( null === $item ) {
		$out   = $queue;
		$queue = array();
		return $out;
	}
	$queue[] = $item;
	if ( ! $hooked ) {
		// Late: after WordPress has flushed the page and WooCommerce saved its session.
		add_action( 'shutdown', 'nowera_capi_flush_outbox', 1000 );
		$hooked = true;
	}
	return $queue;
}

/**
 * Send what this request queued. First the response is finished for the
 * browser (LiteSpeed and PHP-FPM can do that), so the visitor never waits for
 * the gateway; then each event goes with a short timeout. While the gateway is
 * down, nothing is tried for a minute, so an outage cannot tie up the site's PHP
 * workers. A Purchase that did not arrive is retried from its order.
 */
function nowera_capi_flush_outbox( bool $finish = true ): void {
	$queue = nowera_capi_outbox();
	if ( ! $queue ) {
		return;
	}
	if ( $finish ) {
		if ( function_exists( 'litespeed_finish_request' ) ) {
			litespeed_finish_request();
		} elseif ( function_exists( 'fastcgi_finish_request' ) ) {
			fastcgi_finish_request();
		}
	}
	foreach ( $queue as $item ) {
		$error = nowera_capi_deliver( $item['body'] );
		if ( null === $error ) {
			continue;
		}
		if ( ! empty( $item['order_id'] ) ) {
			nowera_capi_purchase_failed( (int) $item['order_id'], $error );
		} elseif ( nowera_capi_gateway_paused() ) {
			// An outage, not this site's mistake: keep the event and try again.
			nowera_capi_retry_later( $item['body'], 1 );
		}
	}
}

/**
 * An event that met a gateway outage waits and goes again with its original
 * time. The event itself is kept in an option (a rich cart outgrows Action
 * Scheduler's argument limit); the scheduled action only carries its key.
 * Should the first try have arrived after all, the gateway keeps one GA4 copy
 * per event id and Meta collapses its two by the same id.
 */
function nowera_capi_retry_later( string $body, int $attempt, ?string $key = null ): void {
	$delays = array( 2, 10, 30, 120, 360 ); // minutes
	$key    = $key ?: 'nowera_capi_retry_' . wp_generate_uuid4();
	if ( $attempt > count( $delays ) || ! function_exists( 'as_schedule_single_action' ) ) {
		delete_option( $key );
		error_log( '[nowera-capi] event dropped after ' . ( $attempt - 1 ) . ' retries' );
		return;
	}
	update_option( $key, $body, false );
	as_schedule_single_action( time() + $delays[ $attempt - 1 ] * MINUTE_IN_SECONDS, 'nowera_capi_retry_event', array( $key, $attempt ), 'nowera-capi' );
}

add_action( 'nowera_capi_retry_event', function ( $key, $attempt = 1 ) {
	$key = (string) $key;
	if ( 0 !== strpos( $key, 'nowera_capi_retry_' ) ) {
		return;
	}
	$body = get_option( $key );
	$data = is_string( $body ) ? json_decode( $body, true ) : null;
	// GA4 takes events up to 72 hours back; past two days a retry is not worth it.
	if ( ! is_array( $data ) || (int) ( $data['event_time'] ?? 0 ) < time() - 2 * DAY_IN_SECONDS ) {
		delete_option( $key );
		return;
	}
	$error = nowera_capi_deliver( $body );
	if ( null !== $error && nowera_capi_gateway_paused() ) {
		nowera_capi_retry_later( $body, (int) $attempt + 1, $key );
		return;
	}
	delete_option( $key );
}, 10, 2 );

/** Whether a recent failure paused sending. */
function nowera_capi_gateway_paused(): bool {
	return (int) get_transient( 'nowera_capi_pause' ) > time();
}

/** POST one event body to the gateway, signed. Null when it arrived, otherwise why not. */
function nowera_capi_deliver( string $body ): ?string {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) || empty( $s['ingest_secret'] ) ) {
		return 'plugin nemá vyplnený collector alebo kľúč';
	}
	if ( nowera_capi_gateway_paused() ) {
		return 'gateway nedávno neodpovedal, odosielanie je na minútu pozastavené';
	}
	// The time is signed with the body, so a captured request cannot be sent again later.
	$timestamp = (string) time();
	$response  = wp_remote_post( 'https://' . $s['collector_host'] . '/s', array(
		'timeout'     => 3,
		'redirection' => 0,
		'headers'     => array(
			'Content-Type'    => 'application/json',
			'X-NWR-Timestamp' => $timestamp,
			'X-NWR-Signature' => hash_hmac( 'sha256', $timestamp . '.' . $body, $s['ingest_secret'] ),
			'X-NWR-Plugin'    => NOWERA_CAPI_VERSION,
		),
		'body'        => $body,
	) );
	$code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
	if ( $code >= 200 && $code < 300 ) {
		nowera_capi_note_status( null );
		return null;
	}
	$error = is_wp_error( $response )
		? $response->get_error_message()
		: 'HTTP ' . $code . ' ' . substr( wp_strip_all_tags( (string) wp_remote_retrieve_body( $response ) ), 0, 160 );
	// No answer, a server error or throttling: an outage, so pause. A 4xx is this
	// site's own problem (key, settings) and pausing would not fix it.
	if ( 0 === $code || $code >= 500 || 429 === $code ) {
		set_transient( 'nowera_capi_pause', time() + MINUTE_IN_SECONDS, MINUTE_IN_SECONDS );
	}
	nowera_capi_note_status( $error );
	error_log( '[nowera-capi] ' . $error );
	return $error;
}

/**
 * Remember how delivery goes, for the settings page. A success is written at
 * most every five minutes, so a busy shop does not write an option per event.
 */
function nowera_capi_note_status( ?string $error ): void {
	$status = get_option( 'nowera_capi_status', array() );
	$status = is_array( $status ) ? $status : array();
	if ( null === $error ) {
		if ( empty( $status['failing'] ) && ! empty( $status['ok_at'] ) && $status['ok_at'] > time() - 5 * MINUTE_IN_SECONDS ) {
			return;
		}
		$status['ok_at']   = time();
		$status['failing'] = false;
	} else {
		$status['error']    = $error;
		$status['error_at'] = time();
		$status['failing']  = true;
	}
	update_option( 'nowera_capi_status', $status, false );
}

/**
 * A Purchase the gateway did not take: the order forgets it was sent and the
 * after-payment job tries again from the order, later each time.
 */
function nowera_capi_purchase_failed( int $order_id, string $error ): void {
	$order = wc_get_order( $order_id );
	if ( ! $order ) {
		return;
	}
	$attempt = (int) $order->get_meta( '_nowera_capi_purchase_retry' ) + 1;
	$delays  = array( 2, 10, 30, 60, 180 ); // minutes
	$order->delete_meta_data( '_nowera_capi_purchase_sent' );
	$order->update_meta_data( '_nowera_capi_purchase_retry', $attempt );
	$args = array( $order_id );
	if ( $attempt <= count( $delays ) && function_exists( 'as_schedule_single_action' ) && $order->get_meta( '_nowera_capi_ctx' ) ) {
		as_unschedule_action( 'nowera_capi_purchase_fallback', $args, 'nowera-capi' );
		as_schedule_single_action( time() + $delays[ $attempt - 1 ] * MINUTE_IN_SECONDS, 'nowera_capi_purchase_fallback', $args, 'nowera-capi' );
		$order->add_order_note( sprintf( 'Nowera CAPI: gateway Purchase neprijal (%s), skúsi sa znova o %d min.', $error, $delays[ $attempt - 1 ] ) );
	} else {
		$order->add_order_note( 'Nowera CAPI: Purchase sa nepodarilo doručiť ani po opakovaní: ' . $error );
	}
	$order->save();
}

/** Plain-language outcome of a Purchase, written to the order so it can be checked later. */
function nowera_capi_record_outcome( \WC_Order $order, string $outcome, bool $after_payment = false ): void {
	$notes = array(
		'marketing'      => 'Purchase odoslaný do Mety aj GA4 (súhlas: marketing).',
		'statistics'     => 'Purchase odoslaný len pre štatistiku — bez marketingového súhlasu ho Meta nedostane.',
		'none'           => 'Purchase neodoslaný — návštevník nedal súhlas s cookies.',
		'not_configured' => 'Purchase neodoslaný — plugin nemá vyplnený collector alebo kľúč.',
	);
	$note = $notes[ $outcome ] ?? $outcome;
	if ( $after_payment ) {
		$note = 'Po potvrdení platby (zákazník sa nevrátil na web): ' . $note;
	}
	// A reloaded thank-you page without consent would write the same note again.
	$same = $order->get_meta( '_nowera_capi_purchase_consent' ) === $outcome && ! $after_payment;
	$order->update_meta_data( '_nowera_capi_purchase_consent', $outcome );
	if ( ! $same ) {
		$order->add_order_note( 'Nowera CAPI: ' . $note );
	}
}

/**
 * Keep what the checkout request knew about the buyer. When the payment gateway
 * confirms the order later and the buyer never returns to the thank-you page,
 * that confirmation arrives without the buyer's cookies — this is all we have.
 * Marketing identifiers are kept only if the buyer allowed marketing.
 */
function nowera_capi_remember_checkout_context( \WC_Order $order ): void {
	if ( $order->get_meta( '_nowera_capi_ctx' ) ) {
		return;
	}
	$ctx  = nowera_capi_request_context();
	$keep = array(
		'marketing'     => (bool) $ctx['marketing'],
		'statistics'    => (bool) $ctx['statistics'],
		'ga_client_id'  => $ctx['ga_client_id'],
		'ga_session_id' => $ctx['ga_session_id'],
	);
	if ( $ctx['marketing'] ) {
		$keep['fbp']     = $ctx['fbp'];
		$keep['fbc']     = $ctx['fbc'];
		$keep['visitor'] = nowera_capi_visitor_id();
	}
	$order->update_meta_data( '_nowera_capi_ctx', $keep );
}

/** Purchase custom_data, shared by the thank-you page and the after-payment path. */
/** The items' worth without VAT and shipping, after discounts: GA4's purchase value. */
function nowera_capi_order_net( \WC_Order $order ): float {
	return round( (float) $order->get_subtotal() - (float) $order->get_discount_total(), wc_get_price_decimals() );
}

/** The share of an amount paid on this order that GA4 counts (its items, no VAT, no shipping). */
function nowera_capi_net_share( \WC_Order $order, float $amount ): float {
	$total = (float) $order->get_total();
	return $total > 0 ? round( $amount * nowera_capi_order_net( $order ) / $total, wc_get_price_decimals() ) : $amount;
}

/** The order's lines as items. */
function nowera_capi_order_items( \WC_Order $order ): array {
	$items = array();
	foreach ( $order->get_items() as $line ) {
		if ( $line instanceof \WC_Order_Item_Product ) {
			$items[] = nowera_capi_order_item( $line, $order );
		}
	}
	return $items;
}

function nowera_capi_purchase_data( \WC_Order $order ): array {
	$contents = nowera_capi_order_items( $order );

	// value is what the customer paid, VAT and shipping included (Meta, and the
	// shop's own reports); GA4 counts value_net — the items without VAT and
	// shipping, as Google defines it — with tax and shipping on their own.
	$custom_data = array(
		'value'        => (float) $order->get_total(),
		'value_net'    => nowera_capi_order_net( $order ),
		'currency'     => $order->get_currency(),
		'order_id'     => $order->get_id(),
		'content_ids'  => array_column( $contents, 'id' ),
		'contents'     => $contents,
		'content_type' => 'product',
		'num_items'    => $order->get_item_count(),
		'tax'          => round( (float) $order->get_total_tax(), wc_get_price_decimals() ),
		'shipping'     => round( (float) $order->get_shipping_total(), wc_get_price_decimals() ),
	);
	if ( $order->get_coupon_codes() ) {
		$custom_data['coupon'] = implode( ',', $order->get_coupon_codes() );
	}
	// New or returning buyer, for campaigns that optimise for new customers.
	$segment = nowera_capi_customer_segment( $order );
	if ( $segment ) {
		$custom_data['customer_segmentation'] = $segment;
	}
	return $custom_data;
}

/**
 * The browser half of a server event: same event_id and same products, so Meta
 * collapses the two into one conversion and the pixel's own identifiers (fbp,
 * fbc, user agent) count towards the match.
 */
function nowera_capi_browser_leg( string $event_name, string $event_id, array $custom_data ): void {
	add_action( 'wp_footer', function () use ( $event_name, $event_id, $custom_data ) {
		printf(
			'<script>window.nwr=window.nwr||function(){(window.nwr.q=window.nwr.q||[]).push(arguments)};' .
			'window.nwr("track",%s,%s,{eventID:%s});</script>' . "\n",
			wp_json_encode( $event_name ),
			wp_json_encode( $custom_data ),
			wp_json_encode( $event_id )
		);
	} );
}

/** Identity fields we can read from the logged-in user or a Woo order. */
function nowera_capi_user_from_order( \WC_Order $order ): array {
	return array_filter( array(
		'em'          => $order->get_billing_email(),
		'ph'          => $order->get_billing_phone(),
		'fn'          => $order->get_billing_first_name(),
		'ln'          => $order->get_billing_last_name(),
		'ct'          => $order->get_billing_city(),
		'zp'          => $order->get_billing_postcode(),
		'country'     => $order->get_billing_country(),
		'external_id' => $order->get_customer_id()
			? (string) $order->get_customer_id()
			: (string) nowera_capi_visitor_id(),
		'account'     => $order->get_customer_id() ? (string) $order->get_customer_id() : '',
	) );
}

/* -------------------------------------------------------------------------
 * WooCommerce events
 * ---------------------------------------------------------------------- */

add_action( 'woocommerce_thankyou', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order ) {
		return;
	}
	// WooCommerce shows this page for a failed or still unpaid order too. Such an
	// order is reported once its payment is confirmed (see the fallback below);
	// no tag on this page reported it, so that report is the only copy.
	if ( ! nowera_capi_purchase_ready( $order ) ) {
		if ( ! $order->get_meta( '_nowera_capi_thankyou_unpaid' ) ) {
			$order->update_meta_data( '_nowera_capi_thankyou_unpaid', time() );
			$order->save_meta_data();
		}
		return;
	}
	// The page loaded for a real purchase, so the site's own tags (GTM, gtag) had
	// their chance to report it; a later retry is no longer the only copy.
	if ( ! $order->get_meta( '_nowera_capi_thankyou' ) ) {
		$order->update_meta_data( '_nowera_capi_thankyou', time() );
		$order->save_meta_data();
	}
	// The thank-you page is refreshed and bookmarked; send Purchase exactly once.
	if ( $order->get_meta( '_nowera_capi_purchase_sent' ) ) {
		return;
	}

	$event_id    = 'ord-' . $order->get_id();
	$custom_data = nowera_capi_purchase_data( $order );

	$outcome = nowera_capi_send(
		'Purchase',
		$event_id,
		nowera_capi_user_from_order( $order ),
		$custom_data,
		nowera_capi_order_url( $order ),
		null,
		$order->get_id()
	);

	nowera_capi_record_outcome( $order, $outcome );
	// Only a delivered event closes the order for good. Without consent the
	// visitor may still accept the banner on this very page, and then a reload
	// (or the browser leg waiting in the loader) still reports the purchase.
	if ( 'marketing' === $outcome || 'statistics' === $outcome ) {
		$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
		// Reported from the page: the payment confirmation has nothing left to do.
		if ( function_exists( 'as_unschedule_action' ) ) {
			as_unschedule_action( 'nowera_capi_purchase_fallback', array( (int) $order->get_id() ), 'nowera-capi' );
		}
	}
	$order->save();

	nowera_capi_browser_leg( 'Purchase', $event_id, $custom_data );
}, 10, 1 );

/**
 * The thank-you page's address without its query string: the order key in it
 * opens the order, and must not travel to Meta or Google.
 */
function nowera_capi_order_url( \WC_Order $order ): string {
	return strtok( $order->get_checkout_order_received_url(), '?' );
}

/**
 * Whether an order counts as a purchase yet. Paid orders do, and so do orders
 * paid on delivery or by bank transfer (processing or on-hold) — those are
 * counted when placed and taken back with a refund if cancelled. Failed,
 * cancelled and still unpaid orders do not.
 */
function nowera_capi_purchase_ready( \WC_Order $order ): bool {
	$ready = ! $order->has_status( array( 'failed', 'cancelled', 'pending', 'checkout-draft', 'refunded', 'trash' ) );
	return (bool) apply_filters( 'nowera_capi_purchase_ready', $ready, $order );
}

/**
 * A paid order whose buyer never came back to the thank-you page (common with
 * 24pay's redirect) would never be reported. Wait half an hour first: if the
 * thank-you page does load, it reports the purchase with fresher consent.
 */
function nowera_capi_schedule_purchase_fallback( $order_id ): void {
	$order = wc_get_order( $order_id );
	if ( ! $order || ! function_exists( 'as_schedule_single_action' ) ) {
		return;
	}
	if ( $order->get_meta( '_nowera_capi_purchase_sent' ) || $order->get_meta( '_nowera_capi_purchase_consent' ) || ! $order->get_meta( '_nowera_capi_ctx' ) ) {
		return; // already reported, already decided, or never went through our checkout
	}
	$args = array( (int) $order->get_id() );
	// The thank-you page already came and went (the order was not paid yet then):
	// nothing to wait for any more.
	$delay = $order->get_meta( '_nowera_capi_thankyou_unpaid' ) ? MINUTE_IN_SECONDS : 30 * MINUTE_IN_SECONDS;
	if ( ! as_next_scheduled_action( 'nowera_capi_purchase_fallback', $args, 'nowera-capi' ) ) {
		as_schedule_single_action( time() + $delay, 'nowera_capi_purchase_fallback', $args, 'nowera-capi' );
	}
}
add_action( 'woocommerce_payment_complete', 'nowera_capi_schedule_purchase_fallback' );
add_action( 'woocommerce_order_status_on-hold', 'nowera_capi_schedule_purchase_fallback' );
add_action( 'woocommerce_order_status_processing', 'nowera_capi_schedule_purchase_fallback' );
add_action( 'woocommerce_order_status_completed', 'nowera_capi_schedule_purchase_fallback' );

add_action( 'nowera_capi_purchase_fallback', function ( $order_id ) {
	$order = wc_get_order( $order_id );
	if ( ! $order || $order->get_meta( '_nowera_capi_purchase_sent' ) ) {
		return; // reported already
	}
	if ( ! nowera_capi_purchase_ready( $order ) ) {
		return; // a later payment confirmation schedules this again
	}
	// The thank-you page decided (e.g. no consent) — unless its delivery failed and this is the retry.
	$retry = (int) $order->get_meta( '_nowera_capi_purchase_retry' ) > 0;
	if ( ! $retry && $order->get_meta( '_nowera_capi_purchase_consent' ) ) {
		return;
	}
	$stored = $order->get_meta( '_nowera_capi_ctx' );
	if ( ! is_array( $stored ) ) {
		return;
	}

	// Consent and identifiers as they were at checkout; address and browser as
	// WooCommerce stored them with the order; the time of the payment itself.
	$paid = $order->get_date_paid() ?: $order->get_date_created();
	$ctx  = array(
		'marketing'     => ! empty( $stored['marketing'] ),
		'statistics'    => ! empty( $stored['statistics'] ),
		'fbp'           => $stored['fbp'] ?? null,
		'fbc'           => $stored['fbc'] ?? null,
		'fbclid'        => null,
		'ga_client_id'  => $stored['ga_client_id'] ?? null,
		'ga_session_id' => $stored['ga_session_id'] ?? null,
		'ip'            => (string) $order->get_customer_ip_address(),
		'ua'            => (string) $order->get_customer_user_agent(),
		'event_time'    => $paid ? $paid->getTimestamp() : time(),
		'referrer_url'  => null,
		'browserless'   => ! $order->get_meta( '_nowera_capi_thankyou' ),
	);
	$user = nowera_capi_user_from_order( $order );
	if ( ! $order->get_customer_id() && ! empty( $stored['visitor'] ) ) {
		$user['external_id'] = (string) $stored['visitor']; // no visitor cookie in this request
	}

	$outcome = nowera_capi_send( 'Purchase', 'ord-' . $order->get_id(), $user, nowera_capi_purchase_data( $order ), nowera_capi_order_url( $order ), $ctx, $order->get_id() );
	if ( ! $retry ) {
		nowera_capi_record_outcome( $order, $outcome, true );
	}
	if ( 'marketing' === $outcome || 'statistics' === $outcome ) {
		$order->update_meta_data( '_nowera_capi_purchase_sent', time() );
	}
	$order->save();
} );

/** The AddToCart this request sent, for the browser to report under the same id. */
function nowera_capi_atc_leg( ?array $leg = null ): ?array {
	static $current = null;
	if ( null !== $leg ) {
		$current = $leg;
	}
	return $current;
}

add_action( 'woocommerce_add_to_cart', function ( $cart_item_key, $product_id, $quantity, $variation_id = 0 ) {
	$product = wc_get_product( $variation_id ?: $product_id );
	if ( ! $product ) {
		return;
	}
	$item        = nowera_capi_item( $product, (int) $quantity );
	$event_id    = wp_generate_uuid4();
	$custom_data = array(
		'value'        => round( $item['item_price'] * (int) $quantity, wc_get_price_decimals() ),
		'value_net'    => round( $item['price_net'] * (int) $quantity, wc_get_price_decimals() ),
		'currency'     => get_woocommerce_currency(),
		'content_ids'  => array( $item['id'] ),
		'contents'     => array( $item ),
		'content_name' => $product->get_name(),
		'content_type' => 'product',
	);
	nowera_capi_send( 'AddToCart', $event_id, nowera_capi_current_user(), $custom_data, get_permalink( $product_id ) );

	// The browser half: an AJAX add to cart hands it over in the cart fragments;
	// a plain form post shows it on the next page this visitor loads.
	nowera_capi_atc_leg( array( 'event_id' => $event_id, 'data' => $custom_data ) );
	if ( ! wp_doing_ajax() && ! ( defined( 'REST_REQUEST' ) && REST_REQUEST ) && WC()->session ) {
		$pending   = (array) WC()->session->get( 'nowera_capi_legs', array() );
		$pending[] = array( 'AddToCart', $event_id, $custom_data );
		WC()->session->set( 'nowera_capi_legs', array_slice( $pending, -5 ) );
	}
}, 10, 4 );

// A string, not an object: themes loop over fragments expecting HTML strings.
add_filter( 'woocommerce_add_to_cart_fragments', function ( $fragments ) {
	$leg = nowera_capi_atc_leg();
	if ( $leg && is_array( $fragments ) ) {
		$fragments['nwr_atc'] = wp_json_encode( $leg );
	}
	return $fragments;
} );

/** Browser legs waiting since a plain add-to-cart form post. Such a page belongs to one visitor: never cached. */
function nowera_capi_pending_legs(): void {
	if ( ! function_exists( 'WC' ) || ! WC()->session || wp_doing_ajax() ) {
		return;
	}
	$pending = WC()->session->get( 'nowera_capi_legs' );
	if ( ! $pending || ! is_array( $pending ) ) {
		return;
	}
	WC()->session->set( 'nowera_capi_legs', null );
	if ( ! defined( 'DONOTCACHEPAGE' ) ) {
		define( 'DONOTCACHEPAGE', true );
	}
	do_action( 'litespeed_control_set_nocache', 'nowera-capi: browser event for this visitor' );
	nocache_headers();
	foreach ( $pending as $leg ) {
		if ( is_array( $leg ) && 3 === count( $leg ) ) {
			nowera_capi_browser_leg( (string) $leg[0], (string) $leg[1], (array) $leg[2] );
		}
	}
}
add_action( 'template_redirect', 'nowera_capi_pending_legs', 6 );

// The AJAX half is picked up by px.js, which WooCommerce's added_to_cart hands the
// fragments to; px.js comes fresh from the gateway even on pages cached long ago.

/**
 * InitiateCheckout when the checkout page opens, classic or built from blocks.
 * Once per cart: reloading the checkout or coming back from the payment page
 * is not a new checkout.
 */
function nowera_capi_maybe_initiate_checkout(): void {
	if ( ! function_exists( 'is_checkout' ) || ! is_checkout() || is_order_received_page()
		|| ( function_exists( 'is_checkout_pay_page' ) && is_checkout_pay_page() ) ) {
		return;
	}
	if ( ! WC()->cart || WC()->cart->is_empty() ) {
		return;
	}
	$hash = WC()->cart->get_cart_hash();
	$seen = WC()->session ? WC()->session->get( 'nowera_capi_ic' ) : null;
	if ( is_array( $seen ) && ( $seen['hash'] ?? '' ) === $hash && (int) ( $seen['at'] ?? 0 ) > time() - HOUR_IN_SECONDS ) {
		return;
	}
	$items       = nowera_capi_cart_items();
	$event_id    = wp_generate_uuid4();
	$custom_data = array(
		'value'        => (float) WC()->cart->get_total( 'edit' ),
		'value_net'    => round( (float) WC()->cart->get_subtotal() - (float) WC()->cart->get_discount_total(), wc_get_price_decimals() ),
		'currency'     => get_woocommerce_currency(),
		'num_items'    => WC()->cart->get_cart_contents_count(),
		'content_ids'  => array_values( array_unique( array_column( $items, 'id' ) ) ),
		'contents'     => $items,
		'content_type' => 'product',
	);
	$coupons = WC()->cart->get_applied_coupons();
	if ( $coupons ) {
		$custom_data['coupon'] = implode( ',', $coupons );
	}

	nowera_capi_send( 'InitiateCheckout', $event_id, nowera_capi_current_user(), $custom_data, wc_get_checkout_url() );
	// The checkout page is never cached, so the browser leg can share this id.
	nowera_capi_browser_leg( 'InitiateCheckout', $event_id, $custom_data );
	if ( WC()->session ) {
		WC()->session->set( 'nowera_capi_ic', array( 'hash' => $hash, 'at' => time() ) );
	}
}
add_action( 'template_redirect', 'nowera_capi_maybe_initiate_checkout', 20 );

/**
 * A refund, partial or full, made in the administration or by the payment
 * gateway. No browser sees it, so it goes from here, marked as browserless: GA4
 * subtracts it from the purchase it recorded under the same transaction id. Only
 * for orders whose buyer allowed statistics at checkout, the ones GA4 can have
 * counted; Meta has no refund event and the gateway does not pass it there.
 */
function nowera_capi_refund( $order_id, $refund_id ): void {
	$order  = wc_get_order( $order_id );
	$refund = wc_get_order( $refund_id );
	if ( ! $order || ! $refund instanceof \WC_Order_Refund ) {
		return;
	}
	$stored = $order->get_meta( '_nowera_capi_ctx' );
	$stored = is_array( $stored ) ? $stored : array();
	// Only what GA4 counted can be taken back: a Purchase reported (with consent,
	// at checkout or later on the thank-you page) or consent stored at checkout.
	if ( ! $order->get_meta( '_nowera_capi_purchase_sent' ) && empty( $stored['statistics'] ) ) {
		return;
	}
	// A cancellation already took back everything that was left.
	if ( $order->get_meta( '_nowera_capi_cancel_sent' ) ) {
		return;
	}

	$contents = array();
	foreach ( $refund->get_items() as $item ) {
		if ( $item instanceof \WC_Order_Item_Product && abs( (int) $item->get_quantity() ) ) {
			$contents[] = nowera_capi_order_item( $item, $refund );
		}
	}
	$amount = abs( (float) $refund->get_amount() );
	if ( $contents ) {
		$net = array_sum( array_map( function ( $i ) { return $i['price_net'] * $i['quantity']; }, $contents ) );
	} elseif ( $refund->get_items( array( 'shipping', 'fee', 'tax' ) ) ) {
		// No products, only shipping, fees or tax given back: no item revenue.
		$net = max( 0, $amount - abs( (float) $refund->get_total_tax() ) - abs( (float) $refund->get_shipping_total() ) );
	} else {
		$net = nowera_capi_net_share( $order, $amount ); // an amount without lines
	}
	$net = round( $net, wc_get_price_decimals() );
	$props  = array(
		'order_id'  => $order->get_id(),
		'value'     => $amount,
		'value_net' => $net,
		'currency'  => $order->get_currency(),
	);
	// What GA4 has been told back so far, so a later cancellation takes only the rest.
	$order->update_meta_data( '_nowera_capi_refunded_net', round( (float) $order->get_meta( '_nowera_capi_refunded_net' ) + $net, wc_get_price_decimals() ) );
	$order->save_meta_data();
	// Without items GA4 takes it as a refund of the whole order.
	if ( $contents ) {
		$props['contents'] = $contents;
	}

	nowera_capi_send( 'Refund', 'refund-' . $refund->get_id(), array(), $props, nowera_capi_order_url( $order ), array(
		'marketing'     => ! empty( $stored['marketing'] ),
		'statistics'    => true,
		'fbp'           => null,
		'fbc'           => null,
		'fbclid'        => null,
		'ga_client_id'  => $stored['ga_client_id'] ?? null, // the buyer, as GA4 knows them
		'ga_session_id' => null,
		'ip'            => (string) $order->get_customer_ip_address(),
		'ua'            => (string) $order->get_customer_user_agent(),
		'event_time'    => time(),
		'referrer_url'  => null,
		'browserless'   => true,
	) );
}
add_action( 'woocommerce_order_refunded', 'nowera_capi_refund', 10, 2 );

/**
 * An order counted as a purchase and then cancelled without a refund (a bank
 * transfer never paid, a parcel on delivery refused): GA4 takes the rest of its
 * value back, as a refund of the whole order.
 */
function nowera_capi_cancelled( $order_id ): void {
	$order = wc_get_order( $order_id );
	if ( ! $order || ! $order->get_meta( '_nowera_capi_purchase_sent' ) || $order->get_meta( '_nowera_capi_cancel_sent' ) ) {
		return;
	}
	$stored = $order->get_meta( '_nowera_capi_ctx' );
	$stored = is_array( $stored ) ? $stored : array();
	$left = round( (float) $order->get_total() - (float) $order->get_total_refunded(), wc_get_price_decimals() );
	if ( $left <= 0 ) {
		return;
	}
	$outcome = nowera_capi_send( 'Refund', 'cancel-' . $order->get_id(), array(), array(
		'order_id'  => $order->get_id(),
		'value'     => $left,
		'value_net' => max( 0, round( nowera_capi_order_net( $order ) - (float) $order->get_meta( '_nowera_capi_refunded_net' ), wc_get_price_decimals() ) ),
		'currency'  => $order->get_currency(),
	), nowera_capi_order_url( $order ), array(
		'marketing'     => ! empty( $stored['marketing'] ),
		'statistics'    => true,
		'fbp'           => null,
		'fbc'           => null,
		'fbclid'        => null,
		'ga_client_id'  => $stored['ga_client_id'] ?? null,
		'ga_session_id' => null,
		'ip'            => (string) $order->get_customer_ip_address(),
		'ua'            => (string) $order->get_customer_user_agent(),
		'event_time'    => time(),
		'referrer_url'  => null,
		'browserless'   => true,
	) );
	if ( 'none' !== $outcome && 'not_configured' !== $outcome ) {
		$order->update_meta_data( '_nowera_capi_cancel_sent', time() );
		$order->add_order_note( 'Nowera CAPI: objednávka zrušená, GA4 dostal refund celej sumy.' );
		$order->save();
	}
}
add_action( 'woocommerce_order_status_cancelled', 'nowera_capi_cancelled' );
add_action( 'woocommerce_order_status_failed', 'nowera_capi_cancelled' );

/**
 * Best identity available before an order exists. Most checkouts are guests, so
 * falling back to what they typed into the cart/checkout session is what keeps
 * Event Match Quality off the floor.
 */
function nowera_capi_current_user(): array {
	$data = array();

	if ( function_exists( 'WC' ) && WC()->customer ) {
		$customer = WC()->customer;
		$data = array_filter( array(
			'em'      => $customer->get_billing_email(),
			'ph'      => $customer->get_billing_phone(),
			'fn'      => $customer->get_billing_first_name(),
			'ln'      => $customer->get_billing_last_name(),
			'ct'      => $customer->get_billing_city(),
			'zp'      => $customer->get_billing_postcode(),
			'country' => $customer->get_billing_country(),
		) );
	}

	// A signed-in customer: the account's own e-mail and name win, the billing
	// details fill in the phone and address the account does not hold.
	if ( is_user_logged_in() ) {
		$user = wp_get_current_user();
		$data = array_merge( $data, array_filter( array(
			'em'          => $user->user_email,
			'fn'          => $user->first_name,
			'ln'          => $user->last_name,
			'external_id' => (string) $user->ID,
			'account'     => (string) $user->ID,
		) ) );
	}

	// A returning customer: what this session knows wins, the stored identity
	// fills the gaps (usually everything, for a guest who has not typed yet).
	$data = array_merge( nowera_capi_stored_user(), array_filter( $data ) );

	if ( empty( $data['external_id'] ) ) {
		$visitor = nowera_capi_visitor_id();
		if ( $visitor ) {
			$data['external_id'] = $visitor;
		}
	}

	return array_filter( $data );
}

/**
 * AddPaymentInfo when the checkout is submitted and the order exists, just
 * before the customer is sent to pay. It carries the full billing identity, so
 * it is also the strongest match signal before the purchase itself.
 */
function nowera_capi_add_payment_info( $order ): void {
	$order = $order instanceof \WC_Order ? $order : wc_get_order( $order );
	if ( ! $order ) {
		return;
	}
	// The last moment the buyer is certainly on the site: keep what we know.
	nowera_capi_remember_checkout_context( $order );
	if ( $order->get_meta( '_nowera_capi_payment_info_sent' ) ) {
		$order->save_meta_data();
		return;
	}

	$items = nowera_capi_order_items( $order );
	$data  = array(
		'value'        => (float) $order->get_total(),
		'value_net'    => nowera_capi_order_net( $order ),
		'currency'     => $order->get_currency(),
		'content_ids'  => array_values( array_unique( array_column( $items, 'id' ) ) ),
		'contents'     => $items,
		'content_type' => 'product',
		'payment_type' => wp_strip_all_tags( $order->get_payment_method_title() ),
	);
	if ( $order->get_coupon_codes() ) {
		$data['coupon'] = implode( ',', $order->get_coupon_codes() );
	}

	nowera_capi_send( 'AddPaymentInfo', 'pay-' . $order->get_id(), nowera_capi_user_from_order( $order ), $data, wc_get_checkout_url() );

	$order->update_meta_data( '_nowera_capi_payment_info_sent', time() );
	$order->save_meta_data();
}

// Classic checkout passes the id first; the block checkout passes the order.
add_action( 'woocommerce_checkout_order_processed', function ( $order_id, $posted = array(), $order = null ) {
	nowera_capi_add_payment_info( $order ?: $order_id );
}, 20, 3 );
add_action( 'woocommerce_store_api_checkout_order_processed', 'nowera_capi_add_payment_info', 20, 1 );

/* -------------------------------------------------------------------------
 * Connection test
 * ---------------------------------------------------------------------- */

/**
 * A signed, empty event: the gateway checks the signature before the content,
 * so "event_name is required" means host and key are right, and nothing is
 * recorded anywhere.
 */
add_action( 'admin_post_nowera_capi_test', function () {
	if ( ! current_user_can( 'manage_options' ) || ! check_admin_referer( 'nowera_capi_test' ) ) {
		wp_die( 'Nemáte oprávnenie.' );
	}
	$s = nowera_capi_settings();
	$result = array( 'ok' => false, 'message' => 'Najprv vyplňte collector host a kľúč.' );
	if ( $s['collector_host'] && $s['ingest_secret'] ) {
		$timestamp = (string) time();
		$body      = '{}';
		$response  = wp_remote_post( 'https://' . $s['collector_host'] . '/s', array(
			'timeout'     => 8,
			'redirection' => 0,
			'headers'     => array(
				'Content-Type'    => 'application/json',
				'X-NWR-Timestamp' => $timestamp,
				'X-NWR-Signature' => hash_hmac( 'sha256', $timestamp . '.' . $body, $s['ingest_secret'] ),
				'X-NWR-Plugin'    => NOWERA_CAPI_VERSION,
			),
			'body'        => $body,
		) );
		$code = is_wp_error( $response ) ? 0 : (int) wp_remote_retrieve_response_code( $response );
		$text = is_wp_error( $response ) ? $response->get_error_message() : (string) wp_remote_retrieve_body( $response );
		if ( 400 === $code && false !== strpos( $text, 'event_name' ) ) {
			$result = array( 'ok' => true, 'message' => 'Spojenie funguje: gateway odpovedá a prijal podpis tohto webu.' );
			delete_transient( 'nowera_capi_pause' );
		} elseif ( 401 === $code ) {
			$result['message'] = 'Gateway odpovedá, ale kľúč nesedí (' . wp_strip_all_tags( $text ) . '). Vložte nový párovací kód.';
		} elseif ( 404 === $code ) {
			$result['message'] = 'Gateway tento host nepozná. Skontrolujte collector host.';
		} else {
			$result['message'] = 'Gateway neodpovedá: ' . ( $code ? 'HTTP ' . $code : $text );
		}
	}
	set_transient( 'nowera_capi_test_' . get_current_user_id(), $result, MINUTE_IN_SECONDS );
	wp_safe_redirect( admin_url( 'options-general.php?page=nowera-capi' ) );
	exit;
} );

/* -------------------------------------------------------------------------
 * Updates from the gateway, signed
 * ---------------------------------------------------------------------- */

/**
 * The newest release as the gateway describes it, cached for six hours (an hour
 * after a failure). Null when there is none or the gateway cannot be reached.
 */
function nowera_capi_release_info( bool $fresh = false ): ?array {
	$s = nowera_capi_settings();
	if ( empty( $s['collector_host'] ) ) {
		return null;
	}
	$cached = get_site_transient( 'nowera_capi_release' );
	if ( ! $fresh && is_array( $cached ) && array_key_exists( 'info', $cached ) ) {
		return $cached['info'];
	}
	$info     = null;
	$base     = 'https://' . $s['collector_host'] . '/wp/nowera-capi/';
	$response = wp_remote_get( $base . 'info.json', array( 'timeout' => 5, 'redirection' => 0 ) );
	if ( ! is_wp_error( $response ) && 200 === (int) wp_remote_retrieve_response_code( $response ) ) {
		$data = json_decode( (string) wp_remote_retrieve_body( $response ), true );
		// Only a package on the same gateway; its signature is checked before install anyway.
		if ( is_array( $data ) && ! empty( $data['version'] ) && ! empty( $data['signature'] )
			&& is_string( $data['download_url'] ?? null ) && 0 === strpos( $data['download_url'], $base ) ) {
			$info = $data;
		}
	}
	set_site_transient( 'nowera_capi_release', array( 'info' => $info ), $info ? 6 * HOUR_IN_SECONDS : HOUR_IN_SECONDS );
	return $info;
}

/** Whether a release ZIP carries a valid signature by one of the built-in keys. */
function nowera_capi_verify_release( string $zip, string $signature, string $sha256 = '' ): bool {
	if ( '' !== $sha256 && ! hash_equals( strtolower( $sha256 ), hash( 'sha256', $zip ) ) ) {
		return false;
	}
	$sig = base64_decode( $signature, true );
	if ( false === $sig || 64 !== strlen( $sig ) || ! function_exists( 'sodium_crypto_sign_verify_detached' ) ) {
		return false;
	}
	foreach ( NOWERA_CAPI_RELEASE_KEYS as $encoded ) {
		$key = base64_decode( $encoded, true );
		if ( false === $key || 32 !== strlen( $key ) ) {
			continue;
		}
		try {
			if ( sodium_crypto_sign_verify_detached( $sig, $zip, $key ) ) {
				return true;
			}
		} catch ( \Throwable $e ) {
			continue;
		}
	}
	return false;
}

// "Update URI" in the header sends WordPress here instead of wordpress.org.
add_filter( 'update_plugins_signals.nwra.sk', function ( $update, $plugin_data, $plugin_file ) {
	if ( plugin_basename( __FILE__ ) !== $plugin_file ) {
		return $update;
	}
	$info = nowera_capi_release_info();
	if ( ! $info ) {
		return $update;
	}
	return array(
		'slug'         => 'nowera-capi',
		'version'      => $info['version'],
		'url'          => 'https://nowera.sk',
		'package'      => $info['download_url'],
		'requires_php' => $info['requires_php'] ?? '8.0',
		'tested'       => $info['tested'] ?? '',
		'autoupdate'   => ! empty( nowera_capi_settings()['auto_update'] ),
	);
}, 10, 3 );

add_filter( 'plugins_api', function ( $result, $action, $args ) {
	if ( 'plugin_information' !== $action || 'nowera-capi' !== ( $args->slug ?? '' ) ) {
		return $result;
	}
	$info = nowera_capi_release_info();
	return (object) array(
		'name'          => 'Nowera CAPI',
		'slug'          => 'nowera-capi',
		'version'       => $info['version'] ?? NOWERA_CAPI_VERSION,
		'author'        => 'Nowera',
		'homepage'      => 'https://nowera.sk',
		'requires_php'  => $info['requires_php'] ?? '8.0',
		'last_updated'  => $info['released_at'] ?? '',
		'download_link' => $info['download_url'] ?? '',
		'sections'      => array(
			'description' => 'Serverové eventy z WooCommerce do Nowera Gateway (Meta Conversions API a GA4).',
			'changelog'   => nl2br( esc_html( (string) ( $info['notes'] ?? '' ) ) ),
		),
	);
}, 10, 3 );

// On unless the site turned it off, or the gateway paused updates for everyone.
add_filter( 'auto_update_plugin', function ( $update, $item ) {
	if ( plugin_basename( __FILE__ ) !== ( $item->plugin ?? '' ) ) {
		return $update;
	}
	$info = nowera_capi_release_info();
	if ( is_array( $info ) && array_key_exists( 'auto_update', $info ) && false === $info['auto_update'] ) {
		return false;
	}
	return ! empty( nowera_capi_settings()['auto_update'] );
}, 10, 2 );

/**
 * Download our package ourselves and refuse it unless the signature matches a
 * built-in key. WordPress, MainWP and automatic updates all pass through here.
 */
add_filter( 'upgrader_pre_download', function ( $reply, $package, $upgrader = null, $hook_extra = array() ) {
	if ( false !== $reply || ! is_string( $package ) || ! preg_match( '#/wp/nowera-capi/(nowera-capi-[0-9][0-9A-Za-z.-]*\.zip)$#', $package, $m ) ) {
		return $reply;
	}
	$info = nowera_capi_release_info( true );
	if ( ! $info || basename( (string) wp_parse_url( $info['download_url'], PHP_URL_PATH ) ) !== $m[1] ) {
		return new \WP_Error( 'nowera_capi_release', 'Nowera CAPI: toto vydanie gateway neponúka.' );
	}
	if ( ! function_exists( 'download_url' ) ) {
		require_once ABSPATH . 'wp-admin/includes/file.php';
	}
	$file = download_url( $info['download_url'], 60 );
	if ( is_wp_error( $file ) ) {
		return $file;
	}
	if ( ! nowera_capi_verify_release( (string) file_get_contents( $file ), (string) $info['signature'], (string) ( $info['sha256'] ?? '' ) ) ) {
		wp_delete_file( $file );
		return new \WP_Error( 'nowera_capi_signature', 'Nowera CAPI: aktualizácia nemá platný podpis, neinštaluje sa.' );
	}
	return $file;
}, 10, 4 );
