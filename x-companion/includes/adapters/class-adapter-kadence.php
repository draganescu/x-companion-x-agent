<?php
/**
 * Kadence Blocks token adapter.
 *
 * A suite adapter is a plain class with two methods:
 *
 *     public function supports(): bool                 is this suite active?
 *     public function apply( array $tokens ): string[] change notes
 *
 * Adding Spectra or GenerateBlocks later is one more file in this directory —
 * X_Companion_Theme_Tokens discovers `X_Companion_Adapter_*` classes on its own.
 *
 * -----------------------------------------------------------------------
 * NOTE FORMAT — asserted by tests/test-tokens.php, treat as wire
 * -----------------------------------------------------------------------
 *
 *     {adapter}:{target}:{status}:{detail}
 *
 *     adapter  the adapter id, `kadence`
 *     target   the option (or other artefact) the note is about
 *     status   applied | noop | skipped
 *     detail   a colon-free machine-readable fragment, e.g.
 *              `palette_colors=8` or `unrecognized_option_shape(found=integer)`
 *
 * `noop` means "this adapter recognised the target but refused to guess at its
 * shape"; `skipped` means "the token set had nothing for this target". Every
 * `noop` is also written to the error log, because a silent no-op on a write
 * route is the failure mode that wastes the most time downstream.
 *
 * Why so defensive: Kadence stores its palette as a **JSON string** in a single
 * option, and the schema of that string is Kadence's business, not ours. The
 * adapter reads the existing value, and only writes when what it finds is
 * something it actually understands.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Kadence Blocks adapter.
 */
final class X_Companion_Adapter_Kadence {

	/** Adapter id, as it appears in `adapters_applied`. */
	const ID = 'kadence';

	/** JSON-string option holding Kadence's global colour palette. */
	const PALETTE_OPTION = 'kadence_blocks_colors';

	/** JSON-string option holding Kadence's global block defaults. */
	const GLOBAL_OPTION = 'kadence_blocks_global';

	/**
	 * Is Kadence Blocks active on this instance?
	 *
	 * @return bool
	 */
	public function supports(): bool {
		return defined( 'KADENCE_BLOCKS_VERSION' ) || class_exists( 'Kadence_Blocks_Frontend' );
	}

	/**
	 * Push what maps, note what does not.
	 *
	 * @param array $tokens DesignTokens.
	 * @return string[] Change notes.
	 */
	public function apply( array $tokens ): array {
		return array_merge(
			$this->apply_palette( $tokens ),
			$this->apply_spacing( $tokens )
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Palette
	 * -------------------------------------------------------------------
	 */

	/**
	 * Map the token palette into Kadence's global palette option.
	 *
	 * @param array $tokens DesignTokens.
	 * @return string[]
	 */
	private function apply_palette( array $tokens ): array {
		$colors = array();

		foreach ( (array) ( $tokens['palette'] ?? array() ) as $entry ) {
			if ( ! is_array( $entry ) || empty( $entry['slug'] ) || empty( $entry['color'] ) ) {
				continue;
			}

			$colors[] = array(
				'color' => (string) $entry['color'],
				'name'  => (string) ( $entry['name'] ?? $entry['slug'] ),
				'slug'  => (string) $entry['slug'],
			);
		}

		if ( empty( $colors ) ) {
			return array( $this->note( self::PALETTE_OPTION, 'skipped', 'no_palette_in_tokens' ) );
		}

		$config = $this->read_json_option( self::PALETTE_OPTION );

		if ( is_string( $config ) ) {
			// read_json_option() returns a string only to describe what it found.
			return array( $this->note( self::PALETTE_OPTION, 'noop', $config ) );
		}

		if ( array_key_exists( 'palette', $config ) && ! is_array( $config['palette'] ) ) {
			return array(
				$this->note(
					self::PALETTE_OPTION,
					'noop',
					sprintf( 'unrecognized_palette_shape(found=%s)', gettype( $config['palette'] ) )
				),
			);
		}

		if ( isset( $config['palette'] ) && ! array_is_list( $config['palette'] ) ) {
			return array( $this->note( self::PALETTE_OPTION, 'noop', 'unrecognized_palette_shape(found=map)' ) );
		}

		// Everything Kadence reads out of this option — `palette`, `override`,
		// `second-palette`, `active` — is preserved except the list we own.
		$config['palette'] = $colors;

		if ( ! array_key_exists( 'override', $config ) ) {
			$config['override'] = false;
		}

		$encoded = wp_json_encode( $config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		if ( ! is_string( $encoded ) ) {
			return array( $this->note( self::PALETTE_OPTION, 'noop', 'encode_failed' ) );
		}

		update_option( self::PALETTE_OPTION, $encoded );

		return array( $this->note( self::PALETTE_OPTION, 'applied', sprintf( 'palette_colors=%d', count( $colors ) ) ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * Spacing
	 * -------------------------------------------------------------------
	 */

	/**
	 * Map the spacing scale into Kadence's global defaults, if it has a slot for one.
	 *
	 * As of Kadence Blocks 3.7.x the global option carries per-block defaults
	 * and no spacing scale, so on a stock install this is the documented no-op
	 * rather than an invented option shape. If a future version grows a
	 * `spacing` key, this starts writing to it without a code change.
	 *
	 * @param array $tokens DesignTokens.
	 * @return string[]
	 */
	private function apply_spacing( array $tokens ): array {
		$steps = array();

		foreach ( (array) ( $tokens['spacing']['steps'] ?? array() ) as $step ) {
			if ( ! is_array( $step ) || empty( $step['slug'] ) || ! isset( $step['size'] ) ) {
				continue;
			}

			$steps[ (string) $step['slug'] ] = (string) $step['size'];
		}

		if ( empty( $steps ) ) {
			return array( $this->note( self::GLOBAL_OPTION, 'skipped', 'no_spacing_steps_in_tokens' ) );
		}

		$config = $this->read_json_option( self::GLOBAL_OPTION );

		if ( is_string( $config ) ) {
			return array( $this->note( self::GLOBAL_OPTION, 'noop', $config ) );
		}

		if ( ! isset( $config['spacing'] ) || ! is_array( $config['spacing'] ) ) {
			return array( $this->note( self::GLOBAL_OPTION, 'noop', 'no_spacing_target_in_option_shape' ) );
		}

		$config['spacing'] = array_merge( $config['spacing'], $steps );

		$encoded = wp_json_encode( $config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		if ( ! is_string( $encoded ) ) {
			return array( $this->note( self::GLOBAL_OPTION, 'noop', 'encode_failed' ) );
		}

		update_option( self::GLOBAL_OPTION, $encoded );

		return array( $this->note( self::GLOBAL_OPTION, 'applied', sprintf( 'spacing_steps=%d', count( $steps ) ) ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * Introspection
	 * -------------------------------------------------------------------
	 */

	/**
	 * Read a Kadence JSON-string option without guessing.
	 *
	 * @param string $option Option name.
	 * @return array|string The decoded config, or a colon-free reason string
	 *                      describing why the value was not usable.
	 */
	private function read_json_option( string $option ) {
		$declared = $this->declared_setting( $option );

		$raw = get_option( $option, null );

		if ( null === $raw || '' === $raw || false === $raw ) {
			// Never written. Only proceed when Kadence itself has declared the
			// setting, which tells us the option is a string it owns.
			if ( null === $declared ) {
				return 'unregistered_option(no_declaration,no_value)';
			}

			if ( 'string' !== ( $declared['type'] ?? 'string' ) ) {
				return sprintf( 'unexpected_declared_type(found=%s)', (string) $declared['type'] );
			}

			return array();
		}

		if ( ! is_string( $raw ) ) {
			return sprintf( 'unrecognized_option_shape(found=%s)', gettype( $raw ) );
		}

		$decoded = json_decode( $raw, true );

		if ( ! is_array( $decoded ) ) {
			return sprintf( 'unrecognized_option_shape(found=%s)', 'string_that_is_not_json_object' );
		}

		if ( array_is_list( $decoded ) ) {
			return 'unrecognized_option_shape(found=json_list)';
		}

		return $decoded;
	}

	/**
	 * What register_setting() says about this option, if anything.
	 *
	 * @param string $option Option name.
	 * @return array|null
	 */
	private function declared_setting( string $option ): ?array {
		if ( ! function_exists( 'get_registered_settings' ) ) {
			return null;
		}

		$registered = get_registered_settings();

		return ( is_array( $registered ) && isset( $registered[ $option ] ) && is_array( $registered[ $option ] ) )
			? $registered[ $option ]
			: null;
	}

	/*
	 * -------------------------------------------------------------------
	 * Notes
	 * -------------------------------------------------------------------
	 */

	/**
	 * Build — and, for a no-op, log — one structured note.
	 *
	 * @param string $target Option name.
	 * @param string $status applied|noop|skipped.
	 * @param string $detail Colon-free detail.
	 * @return string
	 */
	private function note( string $target, string $status, string $detail ): string {
		$note = sprintf( '%s:%s:%s:%s', self::ID, $target, $status, str_replace( ':', '_', $detail ) );

		if ( 'noop' === $status && function_exists( 'error_log' ) ) {
			error_log( 'x-companion token adapter no-op: ' . $note ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}

		return $note;
	}
}
