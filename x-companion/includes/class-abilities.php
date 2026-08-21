<?php
/**
 * Conditional WordPress Abilities API wrapper.
 *
 * REST routes are the primary, always-present interface. Abilities are a
 * strictly optional mirror: everything here is behind function_exists() and
 * this file must never fatal on an installation without the Abilities API
 * (WP < 6.9 / plugin absent).
 *
 * Registration signature verified against developer.wordpress.org for
 * wp_register_ability() / wp_register_ability_category():
 *
 *   wp_register_ability( string $name, array $args ): WP_Ability|null
 *     required args: label, description, category, execute_callback,
 *                    permission_callback
 *     optional args: input_schema, output_schema, meta, ability_class
 *     must run on the `wp_abilities_api_init` action.
 *
 *   wp_register_ability_category( string $slug, array $args ): ?WP_Ability_Category
 *     required args: label, description; optional: meta
 *     must run on the `wp_abilities_api_categories_init` action.
 *
 * Extend-tier abilities are never registered on a production-posture
 * instance, matching the route-level posture gate.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Abilities wrapper.
 */
final class X_Companion_Abilities {

	/**
	 * Ability category slug.
	 */
	const CATEGORY = 'x-companion';

	/**
	 * Register hooks, if and only if the Abilities API is present.
	 *
	 * @return void
	 */
	public static function init(): void {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}

		add_action( 'wp_abilities_api_categories_init', array( __CLASS__, 'register_category' ) );
		add_action( 'wp_abilities_api_init', array( __CLASS__, 'register_abilities' ) );
	}

	/**
	 * Register the x-companion ability category.
	 *
	 * @return void
	 */
	public static function register_category(): void {
		if ( ! function_exists( 'wp_register_ability_category' ) ) {
			return;
		}

		wp_register_ability_category(
			self::CATEGORY,
			array(
				'label'       => __( 'X Companion', 'x-companion' ),
				'description' => __( 'Introspect this instance block registry, validate agent-generated block trees, and compile them to canonical markup.', 'x-companion' ),
			)
		);
	}

	/**
	 * Register abilities.
	 *
	 * @return void
	 */
	public static function register_abilities(): void {
		if ( ! function_exists( 'wp_register_ability' ) ) {
			return;
		}

		/**
		 * Filters the abilities x-companion registers.
		 *
		 * Each entry is keyed by ability name (`x-companion/<slug>`) and holds
		 * the wp_register_ability() $args plus an extra `tier` key
		 * (`introspect`|`author`|`extend`). Entries whose tier is `extend` are
		 * dropped on a production-posture instance before registration.
		 *
		 * @param array $abilities Abilities, keyed by name.
		 */
		$abilities = apply_filters( 'x_companion_abilities', self::definitions() );

		foreach ( (array) $abilities as $name => $args ) {
			if ( ! is_array( $args ) ) {
				continue;
			}

			$tier = (string) ( $args['tier'] ?? 'introspect' );
			unset( $args['tier'] );

			if ( 'extend' === $tier && ! x_companion_extend_enabled() ) {
				continue;
			}

			if ( empty( $args['category'] ) ) {
				$args['category'] = self::CATEGORY;
			}

			wp_register_ability( (string) $name, $args );
		}
	}

	/**
	 * The built-in ability definitions.
	 *
	 * @return array
	 */
	private static function definitions(): array {
		$read = array( __CLASS__, 'can_read' );

		return array(
			'x-companion/get-fingerprint' => array(
				'tier'                => 'introspect',
				'label'               => __( 'Get registry fingerprint', 'x-companion' ),
				'description'         => __( 'Return the current registry epoch: a sha256 over the live block registry, active theme and active plugins. Cheap; call before every batch of work.', 'x-companion' ),
				'category'            => self::CATEGORY,
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(),
				),
				'output_schema'       => array(
					'type'       => 'object',
					'properties' => array(
						'fingerprint'        => array( 'type' => 'string' ),
						'posture'            => array( 'type' => 'string' ),
						'interfaces_version' => array( 'type' => 'string' ),
					),
				),
				'permission_callback' => $read,
				'execute_callback'    => array( __CLASS__, 'execute_fingerprint' ),
				'meta'                => array(
					'annotations' => array(
						'readonly'   => true,
						'idempotent' => true,
					),
				),
			),
			'x-companion/get-manifest'    => array(
				'tier'                => 'introspect',
				'label'               => __( 'Get block manifest', 'x-companion' ),
				'description'         => __( 'Return the machine-readable manifest of this instance: every registered block with its attributes, nesting rules and agent hints, plus patterns, theme tokens and detected block suites.', 'x-companion' ),
				'category'            => self::CATEGORY,
				'input_schema'        => array(
					'type'       => 'object',
					'properties' => array(
						'refresh' => array(
							'type'    => 'boolean',
							'default' => false,
						),
					),
				),
				'output_schema'       => self::schema( 'manifest.schema.json' ),
				'permission_callback' => $read,
				'execute_callback'    => array( __CLASS__, 'execute_manifest' ),
				'meta'                => array(
					'annotations' => array(
						'readonly'   => true,
						'idempotent' => true,
					),
				),
			),
			'x-companion/validate-tree'   => array(
				'tier'                => 'introspect',
				'label'               => __( 'Validate a block tree', 'x-companion' ),
				'description'         => __( 'Validate a Tree IR document against this instance live block registry and return Diagnostics: schema errors, unknown blocks, attribute type/enum violations, nesting violations and hint warnings.', 'x-companion' ),
				'category'            => self::CATEGORY,
				'input_schema'        => self::schema( 'tree-ir.schema.json' ),
				'output_schema'       => self::schema( 'diagnostics.schema.json' ),
				'permission_callback' => $read,
				'execute_callback'    => array( __CLASS__, 'execute_validate' ),
				'meta'                => array(
					'annotations' => array(
						'readonly'   => true,
						'idempotent' => true,
					),
				),
			),
		);
	}

	/**
	 * Load a vendored contract schema, or a permissive fallback.
	 *
	 * @param string $file Schema filename.
	 * @return array
	 */
	private static function schema( string $file ): array {
		if ( class_exists( 'X_Companion_Rest' ) ) {
			$schema = X_Companion_Rest::load_schema( $file );
			if ( is_array( $schema ) ) {
				return $schema;
			}
		}

		return array( 'type' => 'object' );
	}

	/*
	 * -------------------------------------------------------------------
	 * Callbacks
	 * -------------------------------------------------------------------
	 */

	/**
	 * Introspect-tier permission callback.
	 *
	 * @return bool
	 */
	public static function can_read(): bool {
		return current_user_can( 'x_companion_read' );
	}

	/**
	 * Extend-tier permission callback. Exposed for filtered abilities.
	 *
	 * @return bool
	 */
	public static function can_extend(): bool {
		return x_companion_extend_enabled() && current_user_can( 'x_companion_extend' );
	}

	/**
	 * Execute get-fingerprint.
	 *
	 * @return array
	 */
	public static function execute_fingerprint(): array {
		return array(
			'fingerprint'        => X_Companion_Manifest::fingerprint(),
			'posture'            => x_companion_posture(),
			'interfaces_version' => X_COMPANION_INTERFACES_VERSION,
		);
	}

	/**
	 * Execute get-manifest.
	 *
	 * @param array $input Ability input.
	 * @return array
	 */
	public static function execute_manifest( $input = array() ): array {
		$refresh = ! empty( ( (array) $input )['refresh'] );

		return X_Companion_Manifest::get_manifest( $refresh );
	}

	/**
	 * Execute validate-tree.
	 *
	 * @param array $input Tree IR.
	 * @return array
	 */
	public static function execute_validate( $input = array() ): array {
		return X_Companion_Validator::validate_request( is_array( $input ) ? $input : null );
	}
}
