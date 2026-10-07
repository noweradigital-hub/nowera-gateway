<?php
// Stands in for Bricks 2.3 and Bricksforge 3.1.8.9 while fire.php sends a Pro
// Forms submission: Bricks\Helpers::get_element_data() with its return shape
// (element, elements, source_id) over a fixed page and footer template, and the
// Bricksforge action object the legacy bricks/form/custom_action hook receives.
namespace Bricks {
	if ( ! class_exists( '\Bricks\Helpers' ) ) {
		class Helpers {
			/** element id => source id (post or template) holding it. */
			public static array $data = array();

			public static function get_element_data( $post_id, $element_id ) {
				foreach ( self::$data as $source => $elements ) {
					foreach ( $elements as $element ) {
						if ( $element['id'] === (string) $element_id ) {
							return array( 'element' => $element, 'elements' => $elements, 'source_id' => $source );
						}
					}
				}
				return false;
			}
		}
	}
}

namespace Bricksforge\ProForms\Actions {
	if ( ! class_exists( '\Bricksforge\ProForms\Actions\Base' ) ) {
		class Base {
			public function __construct( private array $settings, private array $fields ) {}
			public function get_settings() { return $this->settings; }
			public function get_fields() { return $this->fields; }
		}
	}
}
