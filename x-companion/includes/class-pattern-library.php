<?php
/**
 * POST /patterns — the instance's own pattern corpus, grown by the agent.
 *
 * A page is an assembly of sections, and most sections begin as patterns.
 * This route lets the agent save a section it composed — compiled, canonical
 * markup from the harness — as a registered block pattern, so the next page
 * assembles from it and future sessions inherit it as vocabulary. Patterns
 * land in the `agent/` namespace, are stored in an option, and are
 * re-registered on every init alongside the theme's corpus, which means
 * GET /patterns and the manifest list them with no further plumbing.
 *
 * Saving a pattern moves the fingerprint (see X_Companion_Manifest — the
 * stored corpus is a fingerprint input), so manifest and pattern caches keyed
 * by epoch invalidate exactly like they do for token writes.
 *
 * Extend tier: it mutates the instance, and corpus-growing belongs on a
 * toolchain sandbox; production receives patterns inside snapshots.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Agent-saved block patterns.
 */
class X_Companion_Pattern_Library {

	/**
	 * Option holding the stored patterns, keyed by slug.
	 */
	const OPTION = 'x_companion_patterns';

	/**
	 * Pattern category all agent patterns carry.
	 */
	const CATEGORY = 'x-agent';

	/**
	 * Hook registration + the dispatched route.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_action( 'init', array( __CLASS__, 'register_stored' ), 15 );
		add_filter( 'x_companion_route_patterns_save', array( __CLASS__, 'route_save' ), 10, 2 );
	}

	/**
	 * Register every stored pattern with core's registry.
	 *
	 * @return void
	 */
	public static function register_stored(): void {
		if ( ! function_exists( 'register_block_pattern' ) ) {
			return;
		}

		$stored = self::stored();

		if ( array() === $stored ) {
			return;
		}

		if ( function_exists( 'register_block_pattern_category' ) && class_exists( 'WP_Block_Pattern_Categories_Registry' ) && ! WP_Block_Pattern_Categories_Registry::get_instance()->is_registered( self::CATEGORY ) ) {
			register_block_pattern_category( self::CATEGORY, array( 'label' => __( 'Agent patterns', 'x-companion' ) ) );
		}

		foreach ( $stored as $slug => $pattern ) {
			register_block_pattern(
				$slug,
				array(
					'title'       => (string) ( $pattern['title'] ?? $slug ),
					'content'     => (string) ( $pattern['content'] ?? '' ),
					'description' => (string) ( $pattern['description'] ?? '' ),
					'categories'  => array_values( array_unique( array_merge( array( self::CATEGORY ), (array) ( $pattern['categories'] ?? array() ) ) ) ),
				)
			);
		}
	}

	/**
	 * The stored corpus.
	 *
	 * @return array<string,array>
	 */
	public static function stored(): array {
		$stored = get_option( self::OPTION, array() );

		return is_array( $stored ) ? $stored : array();
	}

	/**
	 * A stamp of the stored corpus, for the fingerprint.
	 *
	 * @return string sha256 hex, or '' when no patterns are stored.
	 */
	public static function stamp(): string {
		$stored = self::stored();

		if ( array() === $stored ) {
			return '';
		}

		ksort( $stored );

		return hash( 'sha256', (string) wp_json_encode( $stored ) );
	}

	/**
	 * POST /patterns.
	 *
	 * Input:  { slug: "agent/...", title, content, categories?, description? }
	 * Output: { saved, replaced, total, fingerprint }
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_save( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$slug    = (string) $request->get_param( 'slug' );
		$title   = trim( (string) $request->get_param( 'title' ) );
		$content = (string) $request->get_param( 'content' );

		if ( ! preg_match( '/^agent\/[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/', $slug ) ) {
			return new WP_Error(
				'pattern_policy',
				__( 'Pattern slugs must live in the agent/ namespace: agent/[a-z0-9-]+.', 'x-companion' ),
				array( 'status' => 422 )
			);
		}

		if ( '' === $title ) {
			return new WP_Error(
				'pattern_policy',
				__( 'A pattern needs a human-readable title.', 'x-companion' ),
				array( 'status' => 422 )
			);
		}

		$parsed = parse_blocks( $content );
		$real   = 0;
		foreach ( $parsed as $block ) {
			if ( ! empty( $block['blockName'] ) ) {
				++$real;
			}
		}

		if ( 0 === $real ) {
			return new WP_Error(
				'pattern_policy',
				__( 'Pattern content contains no blocks. Send serialized markup produced by the harness compile.', 'x-companion' ),
				array(
					'status' => 422,
					'hint'   => __( 'The content must be wp_compile output, never hand-written markup.', 'x-companion' ),
				)
			);
		}

		$categories = array();
		foreach ( (array) $request->get_param( 'categories' ) as $category ) {
			$key = sanitize_key( (string) $category );
			if ( '' !== $key ) {
				$categories[] = $key;
			}
		}

		$stored   = self::stored();
		$replaced = isset( $stored[ $slug ] );

		$stored[ $slug ] = array(
			'title'       => $title,
			'content'     => $content,
			'description' => trim( (string) $request->get_param( 'description' ) ),
			'categories'  => $categories,
			'saved_at'    => gmdate( 'c' ),
		);

		update_option( self::OPTION, $stored, false );

		// Register (or re-register) immediately so this very request's manifest
		// and pattern reads already see the new corpus.
		if ( function_exists( 'unregister_block_pattern' ) && class_exists( 'WP_Block_Patterns_Registry' ) && WP_Block_Patterns_Registry::get_instance()->is_registered( $slug ) ) {
			unregister_block_pattern( $slug );
		}
		self::register_stored();

		X_Companion_Manifest::bust_cache();

		return array(
			'saved'       => $slug,
			'replaced'    => $replaced,
			'total'       => count( $stored ),
			'fingerprint' => X_Companion_Manifest::fingerprint( true ),
		);
	}
}
