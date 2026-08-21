<?php
/**
 * REST route registration, auth, tier + posture gating, schema enforcement.
 *
 * All thirteen contract v1 routes are registered here and nowhere else. Every
 * handler runs in the pinned order: capability check -> input schema
 * validation -> work. The posture gate is part of the capability check for
 * extend-tier routes, so a `production` instance answers 403
 * {code:"posture_forbidden"} before the request body is ever parsed.
 *
 * -----------------------------------------------------------------------
 * EXTENSION POINT for routes implemented elsewhere in the plugin
 * -----------------------------------------------------------------------
 *
 * Routes whose implementation lives in another class dispatch through a
 * filter, so that class never has to edit this file:
 *
 *     $result = apply_filters( 'x_companion_route_' . $route_id, null, $request );
 *
 * Filter signature:
 *
 *     mixed x_companion_route_{$route_id}( null $result, WP_REST_Request $request )
 *
 * Return anything other than null to take the route over. The return value is
 * passed straight to rest_ensure_response(), so an array, a WP_REST_Response
 * or a WP_Error all work. Returning null (i.e. not hooking) leaves the route
 * answering 501 {code:"not_implemented"}. A handler that streams its own
 * output (the harness page, the snapshot zip) should send headers, echo and
 * exit; it never returns.
 *
 * Route ids, and the route each one backs:
 *
 *   harness          GET    /harness                              introspect
 *   blocks_install   POST   /blocks/install                       extend
 *   blocks_library   GET    /blocks/library                       extend
 *   blocks_rollback  POST   /blocks/library/{slug}/rollback       extend
 *   blocks_delete    DELETE /blocks/library/{slug}                extend
 *   theme_tokens     POST   /theme/tokens                         extend
 *   snapshot_export  POST   /snapshot/export                      extend
 *
 * By the time the filter fires the capability + posture gate has already
 * passed, and for `blocks_rollback` / `blocks_delete` the `slug` URL param has
 * been pattern-checked and sanitised. For `theme_tokens` the body has already
 * been validated against fixtures/schemas/design-tokens.schema.json.
 * Everything else -- multipart parsing, zip policy, streaming -- belongs to
 * the implementing class.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * REST controller.
 */
final class X_Companion_Rest {

	/**
	 * REST namespace, pinned by contract v1.
	 */
	const REST_NAMESPACE = 'x-companion/v1';

	/**
	 * Route ids that dispatch through the x_companion_route_{id} filter.
	 *
	 * @var string[]
	 */
	const DISPATCHED_ROUTES = array(
		'harness',
		'blocks_install',
		'blocks_library',
		'blocks_rollback',
		'blocks_delete',
		'theme_tokens',
		'snapshot_export',
		'placeholder',
	);

	/**
	 * Register hooks.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_action( 'rest_api_init', array( __CLASS__, 'register_routes' ) );
	}

	/**
	 * The namespace, for other classes that need to build URLs.
	 *
	 * @return string
	 */
	public static function namespace_string(): string {
		return self::REST_NAMESPACE;
	}

	/*
	 * -------------------------------------------------------------------
	 * Permission callbacks
	 * -------------------------------------------------------------------
	 */

	/**
	 * Authentication + capability gate.
	 *
	 * @param string $capability Required capability.
	 * @return true|WP_Error
	 */
	private static function require_capability( string $capability ) {
		if ( ! is_user_logged_in() ) {
			return new WP_Error(
				'rest_forbidden',
				__( 'Authentication required. Send an Application Password over HTTP Basic auth.', 'x-companion' ),
				array( 'status' => 401 )
			);
		}

		if ( ! current_user_can( $capability ) ) {
			return new WP_Error(
				'rest_forbidden_capability',
				sprintf(
					/* translators: %s: capability name. */
					__( 'Your user lacks the "%s" capability.', 'x-companion' ),
					$capability
				),
				array( 'status' => 403 )
			);
		}

		return true;
	}

	/**
	 * Introspect tier.
	 *
	 * @return true|WP_Error
	 */
	public static function permission_read() {
		return self::require_capability( 'x_companion_read' );
	}

	/**
	 * Author tier. Reserved; no v1 route uses it yet.
	 *
	 * @return true|WP_Error
	 */
	public static function permission_author() {
		return self::require_capability( 'x_companion_author' );
	}

	/**
	 * Extend tier: authentication, then posture, then capability.
	 *
	 * The posture check sits ahead of the capability check on purpose. A
	 * production instance must answer posture_forbidden even to an
	 * administrator who holds x_companion_extend -- the tier is hard-disabled
	 * in code, not merely ungranted.
	 *
	 * @return true|WP_Error
	 */
	public static function permission_extend() {
		if ( ! is_user_logged_in() ) {
			return new WP_Error(
				'rest_forbidden',
				__( 'Authentication required. Send an Application Password over HTTP Basic auth.', 'x-companion' ),
				array( 'status' => 401 )
			);
		}

		if ( ! x_companion_extend_enabled() ) {
			return new WP_Error(
				'posture_forbidden',
				__( 'The extend tier is disabled on a production-posture instance. Run the toolchain on a disposable sandbox and promote artifacts instead.', 'x-companion' ),
				array( 'status' => 403 )
			);
		}

		return self::require_capability( 'x_companion_extend' );
	}

	/*
	 * -------------------------------------------------------------------
	 * Route registration
	 * -------------------------------------------------------------------
	 */

	/**
	 * Register all fourteen v1 routes (thirteen from the contract, plus /placeholder).
	 *
	 * @return void
	 */
	public static function register_routes(): void {
		$ns   = self::REST_NAMESPACE;
		$read = array( __CLASS__, 'permission_read' );
		$ext  = array( __CLASS__, 'permission_extend' );

		$markup_args = array(
			'markup' => array(
				'type'        => 'string',
				'required'    => true,
				'description' => __( 'Serialized block markup.', 'x-companion' ),
			),
		);

		$slug_args = array(
			'slug' => array(
				'type'              => 'string',
				'required'          => true,
				'pattern'           => '^[a-z0-9-]+$',
				'validate_callback' => 'rest_validate_request_arg',
				'sanitize_callback' => 'sanitize_key',
				'description'       => __( 'Installed agent block slug.', 'x-companion' ),
			),
		);

		// 1. GET /fingerprint
		register_rest_route(
			$ns,
			'/fingerprint',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'route_fingerprint' ),
				'permission_callback' => $read,
			)
		);

		// 2. GET /manifest
		register_rest_route(
			$ns,
			'/manifest',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'route_manifest' ),
				'permission_callback' => $read,
				'args'                => array(
					'refresh' => array(
						'type'        => 'boolean',
						'default'     => false,
						'description' => __( 'Bypass the manifest transient.', 'x-companion' ),
					),
				),
			)
		);

		// 3. POST /validate
		register_rest_route(
			$ns,
			'/validate',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_validate' ),
				'permission_callback' => $read,
			)
		);

		// 4. POST /parse
		register_rest_route(
			$ns,
			'/parse',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_parse' ),
				'permission_callback' => $read,
				'args'                => $markup_args,
			)
		);

		// 5. POST /render
		register_rest_route(
			$ns,
			'/render',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_render' ),
				'permission_callback' => $read,
				'args'                => $markup_args,
			)
		);

		// 6. GET /patterns
		register_rest_route(
			$ns,
			'/patterns',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'route_patterns' ),
				'permission_callback' => $read,
			)
		);

		// 7. GET /harness  -> dispatched (X_Companion_Harness)
		register_rest_route(
			$ns,
			'/harness',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'route_harness' ),
				'permission_callback' => $read,
			)
		);

		// 8. POST /blocks/install  -> dispatched (X_Companion_Block_Library)
		register_rest_route(
			$ns,
			'/blocks/install',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_blocks_install' ),
				'permission_callback' => $ext,
			)
		);

		// 9. GET /blocks/library  -> dispatched
		register_rest_route(
			$ns,
			'/blocks/library',
			array(
				'methods'             => WP_REST_Server::READABLE,
				'callback'            => array( __CLASS__, 'route_blocks_library' ),
				'permission_callback' => $ext,
			)
		);

		// 10. POST /blocks/library/{slug}/rollback  -> dispatched
		register_rest_route(
			$ns,
			'/blocks/library/(?P<slug>[a-z0-9-]+)/rollback',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_blocks_rollback' ),
				'permission_callback' => $ext,
				'args'                => $slug_args,
			)
		);

		// 11. DELETE /blocks/library/{slug}  -> dispatched
		register_rest_route(
			$ns,
			'/blocks/library/(?P<slug>[a-z0-9-]+)',
			array(
				'methods'             => WP_REST_Server::DELETABLE,
				'callback'            => array( __CLASS__, 'route_blocks_delete' ),
				'permission_callback' => $ext,
				'args'                => $slug_args,
			)
		);

		// 12. POST /theme/tokens  -> dispatched (X_Companion_Theme_Tokens)
		register_rest_route(
			$ns,
			'/theme/tokens',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_theme_tokens' ),
				'permission_callback' => $ext,
			)
		);

		// 13. POST /snapshot/export  -> dispatched
		register_rest_route(
			$ns,
			'/snapshot/export',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_snapshot_export' ),
				'permission_callback' => $ext,
			)
		);

		// 14. POST /placeholder  -> dispatched (X_Companion_Placeholders)
		register_rest_route(
			$ns,
			'/placeholder',
			array(
				'methods'             => WP_REST_Server::CREATABLE,
				'callback'            => array( __CLASS__, 'route_placeholder' ),
				'permission_callback' => $ext,
				'args'                => array(
					'color' => array(
						'type'        => 'string',
						'required'    => true,
						'description' => __( 'A #rrggbb value or a palette slug from this instance.', 'x-companion' ),
					),
				),
			)
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Dispatcher
	 * -------------------------------------------------------------------
	 */

	/**
	 * Hand a route to whichever class implements it.
	 *
	 * @param string          $route_id Route id, see the class PHPDoc.
	 * @param WP_REST_Request $request  Request.
	 * @return mixed|WP_Error
	 */
	private static function dispatch( string $route_id, WP_REST_Request $request ) {
		$result = apply_filters( 'x_companion_route_' . $route_id, null, $request );

		if ( null === $result ) {
			return new WP_Error(
				'not_implemented',
				sprintf(
					/* translators: %s: route id. */
					__( 'Route "%s" is registered but has no implementation on this installation.', 'x-companion' ),
					$route_id
				),
				array( 'status' => 501 )
			);
		}

		return $result;
	}

	/*
	 * -------------------------------------------------------------------
	 * Handlers implemented here
	 * -------------------------------------------------------------------
	 */

	/**
	 * GET /fingerprint.
	 *
	 * @return WP_REST_Response
	 */
	public static function route_fingerprint() {
		return rest_ensure_response(
			array(
				'fingerprint'        => X_Companion_Manifest::fingerprint(),
				'posture'            => x_companion_posture(),
				'interfaces_version' => X_COMPANION_INTERFACES_VERSION,
			)
		);
	}

	/**
	 * GET /manifest.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_manifest( WP_REST_Request $request ) {
		return rest_ensure_response( X_Companion_Manifest::get_manifest( (bool) $request->get_param( 'refresh' ) ) );
	}

	/**
	 * POST /validate.
	 *
	 * The TreeIR schema is deliberately NOT enforced by the route args: a
	 * malformed tree is the agent's primary feedback channel and must come
	 * back as Diagnostics with E_TREE_SCHEMA, not as a bare 400.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_validate( WP_REST_Request $request ) {
		// Decoded with objects preserved so that `{}` and `[]` stay
		// distinguishable: BlockNode.attributes must be an object and
		// TreeIR.blocks must be an array, and json_decode( $body, true )
		// collapses both empties to the same PHP value.
		$tree = json_decode( (string) $request->get_body() );

		if ( JSON_ERROR_NONE !== json_last_error() ) {
			$tree = $request->get_json_params();
		}

		return rest_ensure_response( X_Companion_Validator::validate_request( $tree ) );
	}

	/**
	 * POST /parse.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_parse( WP_REST_Request $request ) {
		$markup = (string) $request->get_param( 'markup' );

		return rest_ensure_response( array( 'blocks' => parse_blocks( $markup ) ) );
	}

	/**
	 * POST /render.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return WP_REST_Response
	 */
	public static function route_render( WP_REST_Request $request ) {
		$markup = (string) $request->get_param( 'markup' );

		$styles_before = self::enqueued_style_handles();

		// Faux main-query guard: several dynamic blocks assert against the
		// main query, and the REST request has none.
		global $wp_query, $wp_the_query, $post;
		$saved_query = $wp_query;
		$saved_post  = $post;

		if ( $wp_the_query instanceof WP_Query ) {
			$wp_query = $wp_the_query; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		}

		$html = '';
		try {
			$html = do_blocks( $markup );
		} finally {
			$wp_query = $saved_query; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
			$post     = $saved_post;  // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		}

		$styles_after = self::enqueued_style_handles();
		$new_handles  = array_values( array_diff( $styles_after, $styles_before ) );

		return rest_ensure_response(
			array(
				'html'            => $html,
				'enqueued_styles' => self::resolve_style_urls( $new_handles ),
			)
		);
	}

	/**
	 * GET /patterns.
	 *
	 * @return WP_REST_Response
	 */
	public static function route_patterns() {
		$patterns = array();

		if ( class_exists( 'WP_Block_Patterns_Registry' ) ) {
			foreach ( WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $pattern ) {
				$content    = (string) ( $pattern['content'] ?? '' );
				$patterns[] = array(
					'name'       => (string) ( $pattern['name'] ?? '' ),
					'title'      => (string) ( $pattern['title'] ?? '' ),
					'categories' => array_values( array_map( 'strval', (array) ( $pattern['categories'] ?? array() ) ) ),
					'content'    => $content,
					'parsed'     => parse_blocks( $content ),
				);
			}
		}

		usort(
			$patterns,
			static function ( $a, $b ) {
				return strcmp( $a['name'], $b['name'] );
			}
		);

		return rest_ensure_response( $patterns );
	}

	/*
	 * -------------------------------------------------------------------
	 * Dispatched handlers
	 * -------------------------------------------------------------------
	 */

	/**
	 * GET /harness.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_harness( WP_REST_Request $request ) {
		return self::dispatch( 'harness', $request );
	}

	/**
	 * POST /blocks/install.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_blocks_install( WP_REST_Request $request ) {
		return self::dispatch( 'blocks_install', $request );
	}

	/**
	 * GET /blocks/library.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_blocks_library( WP_REST_Request $request ) {
		return self::dispatch( 'blocks_library', $request );
	}

	/**
	 * POST /blocks/library/{slug}/rollback.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_blocks_rollback( WP_REST_Request $request ) {
		return self::dispatch( 'blocks_rollback', $request );
	}

	/**
	 * DELETE /blocks/library/{slug}.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_blocks_delete( WP_REST_Request $request ) {
		return self::dispatch( 'blocks_delete', $request );
	}

	/**
	 * POST /theme/tokens.
	 *
	 * Capability -> schema -> work: the DesignTokens body is validated against
	 * the vendored schema here, before the implementing class sees it.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_theme_tokens( WP_REST_Request $request ) {
		$schema = self::load_schema( 'design-tokens.schema.json' );

		if ( is_array( $schema ) ) {
			$valid = self::validate_body_against_schema( $request->get_json_params(), $schema );
			if ( is_wp_error( $valid ) ) {
				return $valid;
			}
		}

		return self::dispatch( 'theme_tokens', $request );
	}

	/**
	 * POST /snapshot/export.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed
	 */
	public static function route_snapshot_export( WP_REST_Request $request ) {
		return self::dispatch( 'snapshot_export', $request );
	}

	/**
	 * POST /placeholder -> dispatched.
	 *
	 * @param WP_REST_Request $request Request.
	 * @return mixed|WP_Error
	 */
	public static function route_placeholder( WP_REST_Request $request ) {
		return self::dispatch( 'placeholder', $request );
	}

	/*
	 * -------------------------------------------------------------------
	 * Schema helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * Load a vendored contract schema.
	 *
	 * @param string $file Schema filename.
	 * @return array|null
	 */
	public static function load_schema( string $file ): ?array {
		$path = X_COMPANION_DIR . 'fixtures/schemas/' . basename( $file );

		if ( ! file_exists( $path ) ) {
			return null;
		}

		$decoded = json_decode( (string) file_get_contents( $path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents

		return is_array( $decoded ) ? $decoded : null;
	}

	/**
	 * Validate a decoded body against a contract schema.
	 *
	 * Types, enums, patterns, items and additionalProperties come from core's
	 * rest_validate_value_from_schema(); nested `required` arrays do not, so
	 * they are walked here.
	 *
	 * @param mixed $body   Decoded body.
	 * @param array $schema JSON Schema.
	 * @return true|WP_Error
	 */
	public static function validate_body_against_schema( $body, array $schema ) {
		if ( ! is_array( $body ) ) {
			return new WP_Error(
				'rest_invalid_param',
				__( 'Request body must be a JSON object.', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		$missing = self::collect_missing_required( $body, $schema, '' );
		if ( ! empty( $missing ) ) {
			return new WP_Error(
				'rest_invalid_param',
				sprintf(
					/* translators: %s: comma separated list of JSON pointers. */
					__( 'Missing required properties: %s', 'x-companion' ),
					implode( ', ', $missing )
				),
				array(
					'status'  => 400,
					'missing' => $missing,
				)
			);
		}

		$result = rest_validate_value_from_schema( $body, $schema, 'body' );

		if ( is_wp_error( $result ) ) {
			return new WP_Error(
				'rest_invalid_param',
				$result->get_error_message(),
				array( 'status' => 400 )
			);
		}

		return true;
	}

	/**
	 * Walk `required` arrays alongside the data.
	 *
	 * @param mixed  $value  Data.
	 * @param array  $schema Schema node.
	 * @param string $path   Pointer prefix.
	 * @return string[] Pointers of missing properties.
	 */
	private static function collect_missing_required( $value, array $schema, string $path ): array {
		$missing = array();

		if ( isset( $schema['properties'] ) && is_array( $schema['properties'] ) && is_array( $value ) ) {
			foreach ( (array) ( $schema['required'] ?? array() ) as $key ) {
				if ( ! array_key_exists( $key, $value ) ) {
					$missing[] = $path . '/' . $key;
				}
			}

			foreach ( $schema['properties'] as $key => $subschema ) {
				if ( is_array( $subschema ) && array_key_exists( $key, $value ) ) {
					$missing = array_merge( $missing, self::collect_missing_required( $value[ $key ], $subschema, $path . '/' . $key ) );
				}
			}
		}

		if ( isset( $schema['items'] ) && is_array( $schema['items'] ) && is_array( $value ) && array_is_list( $value ) ) {
			foreach ( $value as $index => $item ) {
				$missing = array_merge( $missing, self::collect_missing_required( $item, $schema['items'], $path . '/' . $index ) );
			}
		}

		return $missing;
	}

	/*
	 * -------------------------------------------------------------------
	 * Style capture helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * Currently enqueued style handles.
	 *
	 * @return string[]
	 */
	private static function enqueued_style_handles(): array {
		if ( ! function_exists( 'wp_styles' ) ) {
			return array();
		}

		$styles = wp_styles();

		return is_array( $styles->queue ?? null ) ? array_values( array_map( 'strval', $styles->queue ) ) : array();
	}

	/**
	 * Resolve style handles to absolute URLs.
	 *
	 * @param string[] $handles Handles.
	 * @return string[] Absolute URLs, best effort.
	 */
	private static function resolve_style_urls( array $handles ): array {
		if ( ! function_exists( 'wp_styles' ) || empty( $handles ) ) {
			return array();
		}

		$styles = wp_styles();
		$urls   = array();

		foreach ( $handles as $handle ) {
			$registered = $styles->registered[ $handle ] ?? null;
			if ( ! $registered || empty( $registered->src ) || ! is_string( $registered->src ) ) {
				continue;
			}

			$src = $registered->src;

			if ( method_exists( $styles, '_css_href' ) ) {
				$src = (string) $styles->_css_href( $registered->src, (string) ( $registered->ver ?? '' ), (string) $handle );
			} elseif ( 0 !== strpos( $src, 'http' ) && 0 !== strpos( $src, '//' ) ) {
				$src = rtrim( (string) ( $styles->base_url ?? site_url() ), '/' ) . '/' . ltrim( $src, '/' );
			}

			if ( '' !== $src ) {
				$urls[] = $src;
			}
		}

		return array_values( array_unique( $urls ) );
	}
}
