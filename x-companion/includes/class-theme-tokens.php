<?php
/**
 * POST /theme/tokens and POST /snapshot/export — milestone M6, "tokens and export".
 *
 * The two routes live together because they are two halves of the same story:
 * one writes the design system into the instance, the other packages the
 * instance up so a production site can receive it as an artifact.
 *
 * The primary write path for tokens is the **user-origin global styles CPT**
 * (`wp_global_styles`), not the theme's theme.json file. That is deliberate:
 * the CPT works on a read-only theme directory, survives theme updates, and is
 * the same origin the site editor writes to, so what the agent applies is what
 * a human would see in Styles. Writing the theme's own theme.json is available
 * as a secondary path, off by default, and only when the directory is writable.
 *
 * Suite adapters are duck-typed. A class named `X_Companion_Adapter_*` under
 * includes/adapters/ with
 *
 *     public function supports(): bool
 *     public function apply( array $tokens ): string[]   // change notes
 *
 * is discovered automatically — adding Spectra or GenerateBlocks later is one
 * file and no edits here.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Design tokens compiler + snapshot exporter.
 */
final class X_Companion_Theme_Tokens {

	/**
	 * Prefix every adapter class shares.
	 */
	const ADAPTER_PREFIX = 'X_Companion_Adapter_';

	/**
	 * The five top-level entries a snapshot zip contains, and nothing else.
	 *
	 * @var string[]
	 */
	const SNAPSHOT_ENTRIES = array( 'theme/', 'agent-blocks/', 'patterns.json', 'content.xml', 'manifest.json' );

	/**
	 * Hook the two dispatched routes.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_theme_tokens', array( __CLASS__, 'route_tokens' ), 10, 2 );
		add_filter( 'x_companion_route_snapshot_export', array( __CLASS__, 'route_export' ), 10, 2 );
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /theme/tokens
	 * -------------------------------------------------------------------
	 */

	/**
	 * Compile DesignTokens into global styles, then run the suite adapters.
	 *
	 * The body has already been validated against the vendored DesignTokens
	 * schema by the REST layer.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_tokens( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$tokens = $request->get_json_params();

		if ( ! is_array( $tokens ) ) {
			return new WP_Error(
				'rest_invalid_param',
				__( 'The request body must be a DesignTokens object.', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		$settings = self::compile( $tokens );
		$css      = self::compile_css( $tokens );
		$written  = self::write_global_styles( $settings, $css['styles'] );
		$file     = self::maybe_write_theme_file( $settings );

		$applied = array();
		$notes   = array();

		foreach ( self::adapters() as $class ) {
			try {
				$adapter = new $class();

				if ( ! method_exists( $adapter, 'supports' ) || ! $adapter->supports() ) {
					continue;
				}

				$applied[] = self::adapter_id( $class );

				foreach ( (array) $adapter->apply( $tokens ) as $note ) {
					$notes[] = (string) $note;
				}
			} catch ( Throwable $e ) {
				$notes[] = sprintf( '%s:adapter:noop:threw(%s)', self::adapter_id( $class ), str_replace( ':', '_', get_class( $e ) ) );
			}
		}

		// The manifest body carries theme_tokens, so it is now stale.
		X_Companion_Manifest::bust_cache();

		return array(
			'theme_json_written' => $written,
			'adapters_applied'   => $applied,
			'fingerprint'        => X_Companion_Manifest::fingerprint( true ),
			'adapter_notes'      => $notes,
			'theme_file_written' => $file,
			'settings'           => $settings,
			'css_written'        => array() !== $css['styles'],
			'css_rejected'       => $css['rejected'],
		);
	}

	/**
	 * DesignTokens `css` section -> a theme.json `styles` fragment.
	 *
	 * The expression ladder's rung 5: custom css written into global styles
	 * (styles.css global, styles.blocks[name].css per block) — canon's own
	 * escape hatch, theme-update-safe. Validation mirrors core's
	 * WP_REST_Global_Styles_Controller::validate_custom_css (markup in a css
	 * string is rejected); an unknown block name is rejected too. Every
	 * rejection is itemized — never silently dropped.
	 *
	 * @param array $tokens DesignTokens (may carry `css`).
	 * @return array{styles:array,rejected:array<int,array{target:string,reason:string}>}
	 */
	public static function compile_css( array $tokens ): array {
		$css = $tokens['css'] ?? null;
		if ( ! is_array( $css ) ) {
			return array(
				'styles'   => array(),
				'rejected' => array(),
			);
		}

		$styles   = array();
		$rejected = array();

		$validate = static function ( string $value ): ?string {
			// Core's validate_custom_css: markup inside a css payload.
			if ( preg_match( '#</?\w+#', $value ) ) {
				return 'markup is not allowed in css';
			}

			return null;
		};

		$global = $css['global'] ?? null;
		if ( is_string( $global ) && '' !== trim( $global ) ) {
			$reason = $validate( $global );
			if ( null === $reason ) {
				$styles['css'] = $global;
			} else {
				$rejected[] = array(
					'target' => 'global',
					'reason' => $reason,
				);
			}
		}

		$registry = class_exists( 'WP_Block_Type_Registry' ) ? WP_Block_Type_Registry::get_instance() : null;
		if ( $registry && ! method_exists( $registry, 'is_registered' ) ) {
			$registry = null;
		}

		foreach ( (array) ( $css['blocks'] ?? array() ) as $block_name => $value ) {
			$block_name = (string) $block_name;

			if ( ! is_string( $value ) || '' === trim( $value ) ) {
				continue;
			}

			if ( $registry && ! $registry->is_registered( $block_name ) ) {
				$rejected[] = array(
					'target' => $block_name,
					'reason' => 'block is not registered on this instance',
				);
				continue;
			}

			$reason = $validate( $value );
			if ( null !== $reason ) {
				$rejected[] = array(
					'target' => $block_name,
					'reason' => $reason,
				);
				continue;
			}

			$styles['blocks'][ $block_name ] = array( 'css' => $value );
		}

		return array(
			'styles'   => $styles,
			'rejected' => $rejected,
		);
	}

	/**
	 * DesignTokens -> a theme.json `settings` object.
	 *
	 * Only the groups the contract names are emitted. Everything else in the
	 * target document is left alone by the merge.
	 *
	 * @param array $tokens DesignTokens.
	 * @return array theme.json settings fragment.
	 */
	public static function compile( array $tokens ): array {
		$settings = array();

		$palette = array();
		foreach ( (array) ( $tokens['palette'] ?? array() ) as $entry ) {
			if ( ! is_array( $entry ) || empty( $entry['slug'] ) || empty( $entry['color'] ) ) {
				continue;
			}

			$palette[] = array(
				'slug'  => (string) $entry['slug'],
				'name'  => (string) ( $entry['name'] ?? $entry['slug'] ),
				'color' => (string) $entry['color'],
			);
		}

		if ( ! empty( $palette ) ) {
			$settings['color'] = array( 'palette' => $palette );
		}

		$sizes = array();
		foreach ( (array) ( $tokens['spacing']['steps'] ?? array() ) as $step ) {
			if ( ! is_array( $step ) || empty( $step['slug'] ) || ! isset( $step['size'] ) ) {
				continue;
			}

			$sizes[] = array(
				'size' => (string) $step['size'],
				'slug' => (string) $step['slug'],
				'name' => (string) ( $step['name'] ?? $step['slug'] ),
			);
		}

		if ( ! empty( $sizes ) ) {
			$settings['spacing'] = array(
				'spacingSizes' => $sizes,
				// A spacingSizes array and a generated spacingScale fight each
				// other; turning the generator off is what the site editor does
				// when a custom set is present.
				'spacingScale' => array( 'steps' => 0 ),
			);
		}

		$font_sizes = array();
		foreach ( (array) ( $tokens['typography']['sizes'] ?? array() ) as $size ) {
			if ( ! is_array( $size ) || empty( $size['slug'] ) || ! isset( $size['size'] ) ) {
				continue;
			}

			$entry = array(
				'size' => (string) $size['size'],
				'slug' => (string) $size['slug'],
				'name' => (string) ( $size['name'] ?? $size['slug'] ),
			);

			if ( array_key_exists( 'fluid', $size ) ) {
				$entry['fluid'] = is_array( $size['fluid'] ) ? $size['fluid'] : (bool) $size['fluid'];
			}

			$font_sizes[] = $entry;
		}

		$families = array();
		foreach ( (array) ( $tokens['typography']['families'] ?? array() ) as $family ) {
			if ( ! is_array( $family ) || empty( $family['slug'] ) || empty( $family['fontFamily'] ) ) {
				continue;
			}

			$entry = array(
				'fontFamily' => (string) $family['fontFamily'],
				'slug'       => (string) $family['slug'],
				'name'       => (string) ( $family['name'] ?? $family['slug'] ),
			);

			// The widened tokens contract (theme-factory font lane): fontFace
			// is the Font Library ACTIVATION payload — sanitized srcs pointing
			// at files core REST already placed under uploads/fonts. Writing it
			// into the user global styles is what makes wp_print_font_faces
			// emit @font-face; a family without it stays a stack, exactly as
			// before. `source` (the agent-side download instruction) is
			// deliberately ignored here — the instance never calls out.
			if ( isset( $family['fontFace'] ) && is_array( $family['fontFace'] ) ) {
				$faces = array();

				foreach ( $family['fontFace'] as $face ) {
					if ( ! is_array( $face ) || empty( $face['fontFamily'] ) || empty( $face['src'] ) ) {
						continue;
					}

					$src = array();
					foreach ( (array) $face['src'] as $url ) {
						$clean = esc_url_raw( (string) $url );
						if ( '' !== $clean ) {
							$src[] = $clean;
						}
					}

					if ( empty( $src ) ) {
						continue;
					}

					$faces[] = array(
						'fontFamily' => (string) $face['fontFamily'],
						'fontStyle'  => (string) ( $face['fontStyle'] ?? 'normal' ),
						'fontWeight' => (string) ( $face['fontWeight'] ?? '400' ),
						'src'        => $src,
					);
				}

				if ( ! empty( $faces ) ) {
					$entry['fontFace'] = $faces;
				}
			}

			$families[] = $entry;
		}

		if ( ! empty( $font_sizes ) || ! empty( $families ) ) {
			$settings['typography'] = array();

			if ( ! empty( $font_sizes ) ) {
				$settings['typography']['fontSizes'] = $font_sizes;
			}

			if ( ! empty( $families ) ) {
				$settings['typography']['fontFamilies'] = $families;
			}
		}

		$layout = array();
		foreach ( array( 'contentSize', 'wideSize' ) as $key ) {
			if ( isset( $tokens['layout'][ $key ] ) && '' !== $tokens['layout'][ $key ] ) {
				$layout[ $key ] = (string) $tokens['layout'][ $key ];
			}
		}

		if ( ! empty( $layout ) ) {
			$settings['layout'] = $layout;
		}

		return $settings;
	}

	/**
	 * The plugin's WP_Filesystem handle, or null when it needs credentials.
	 *
	 * Borrowed from X_Companion_Block_Library, which owns the plugin's on-disk
	 * state; keeping one accessor means one WP_Filesystem() bootstrap per request.
	 *
	 * @return WP_Filesystem_Base|null
	 */
	private static function filesystem(): ?WP_Filesystem_Base {
		if ( ! class_exists( 'X_Companion_Block_Library' ) ) {
			return null;
		}

		return X_Companion_Block_Library::filesystem();
	}

	/**
	 * Deep merge that treats lists as atomic values.
	 *
	 * `settings.color.palette` is replaced wholesale — it is the token set —
	 * while `settings.color.custom`, `settings.spacing.units` and every other
	 * unrelated key survive untouched.
	 *
	 * @param array $base     Existing settings.
	 * @param array $incoming Compiled settings.
	 * @return array
	 */
	public static function merge_settings( array $base, array $incoming ): array {
		foreach ( $incoming as $key => $value ) {
			$mergeable = is_array( $value )
				&& ! array_is_list( $value )
				&& isset( $base[ $key ] )
				&& is_array( $base[ $key ] )
				&& ! array_is_list( $base[ $key ] );

			$base[ $key ] = $mergeable ? self::merge_settings( $base[ $key ], $value ) : $value;
		}

		return $base;
	}

	/**
	 * Write the compiled settings into the user-origin global styles CPT.
	 *
	 * @param array $settings theme.json settings fragment.
	 * @return bool
	 */
	public static function write_global_styles( array $settings, array $styles = array() ): bool {
		if ( ( empty( $settings ) && empty( $styles ) ) || ! class_exists( 'WP_Theme_JSON_Resolver' ) ) {
			return false;
		}

		$post_id = WP_Theme_JSON_Resolver::get_user_global_styles_post_id();

		if ( ! $post_id ) {
			return false;
		}

		$post = get_post( $post_id );

		if ( ! $post instanceof WP_Post ) {
			return false;
		}

		$config = json_decode( (string) $post->post_content, true );
		$config = is_array( $config ) ? $config : array();

		$config['version']                     = class_exists( 'WP_Theme_JSON' ) ? WP_Theme_JSON::LATEST_SCHEMA : 3;
		$config['isGlobalStylesUserThemeJSON'] = true;
		$config['settings']                    = self::merge_settings( (array) ( $config['settings'] ?? array() ), $settings );

		if ( array() !== $styles ) {
			$config['styles'] = self::merge_settings( (array) ( $config['styles'] ?? array() ), $styles );
		}

		$json = wp_json_encode( $config, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		if ( ! is_string( $json ) ) {
			return false;
		}

		// wp_update_post() unslashes; font family stacks are full of escaped
		// quotes, so the JSON must go in slashed or it comes out broken.
		$updated = wp_update_post(
			array(
				'ID'           => $post_id,
				'post_content' => wp_slash( $json ),
			),
			true
		);

		if ( is_wp_error( $updated ) ) {
			return false;
		}

		self::flush_global_styles_cache();

		return true;
	}

	/**
	 * Secondary path: merge the settings into the active theme's theme.json.
	 *
	 * Off unless `X_COMPANION_TOKENS_WRITE_THEME_FILE` is defined true, and even
	 * then only when the theme directory is writable. The CPT above is what the
	 * contract calls the primary path and it is what `theme_json_written`
	 * reports; this exists for the case where the artifact you want is a theme
	 * directory you are about to export.
	 *
	 * @param array $settings theme.json settings fragment.
	 * @return bool
	 */
	public static function maybe_write_theme_file( array $settings ): bool {
		$enabled = defined( 'X_COMPANION_TOKENS_WRITE_THEME_FILE' ) ? (bool) X_COMPANION_TOKENS_WRITE_THEME_FILE : false;

		/**
		 * Filters whether the active theme's theme.json file is also rewritten.
		 *
		 * @param bool  $enabled  Default false.
		 * @param array $settings Compiled settings.
		 */
		$enabled = (bool) apply_filters( 'x_companion_write_theme_json_file', $enabled, $settings );

		if ( ! $enabled || empty( $settings ) || ! function_exists( 'get_stylesheet_directory' ) ) {
			return false;
		}

		$filesystem = self::filesystem();

		if ( null === $filesystem ) {
			return false;
		}

		$dir = get_stylesheet_directory();

		if ( ! is_dir( $dir ) || ! $filesystem->is_writable( $dir ) ) {
			return false;
		}

		$file   = $dir . '/theme.json';
		$config = array();

		if ( file_exists( $file ) ) {
			if ( ! $filesystem->is_writable( $file ) ) {
				return false;
			}

			$decoded = json_decode( (string) file_get_contents( $file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$config  = is_array( $decoded ) ? $decoded : array();
		}

		if ( empty( $config['version'] ) ) {
			$config['version'] = class_exists( 'WP_Theme_JSON' ) ? WP_Theme_JSON::LATEST_SCHEMA : 3;
		}

		$config['settings'] = self::merge_settings( (array) ( $config['settings'] ?? array() ), $settings );

		$json = wp_json_encode( $config, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE );

		if ( ! is_string( $json ) || false === file_put_contents( $file, $json . "\n" ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
			return false;
		}

		self::flush_global_styles_cache();

		return true;
	}

	/**
	 * Drop every layer of theme.json caching.
	 *
	 * @return void
	 */
	private static function flush_global_styles_cache(): void {
		if ( class_exists( 'WP_Theme_JSON_Resolver' ) && method_exists( 'WP_Theme_JSON_Resolver', 'clean_cached_data' ) ) {
			WP_Theme_JSON_Resolver::clean_cached_data();
		}

		if ( function_exists( 'wp_clean_theme_json_cache' ) ) {
			wp_clean_theme_json_cache();
		}
	}

	/*
	 * -------------------------------------------------------------------
	 * Suite adapters
	 * -------------------------------------------------------------------
	 */

	/**
	 * Every declared adapter class, sorted.
	 *
	 * The bootstrap requires includes/adapters/class-*.php before anything is
	 * booted, so discovery is a scan of declared classes rather than a registry
	 * someone has to remember to add to.
	 *
	 * @return string[]
	 */
	public static function adapters(): array {
		$classes = array();

		foreach ( get_declared_classes() as $class ) {
			if ( 0 === strpos( $class, self::ADAPTER_PREFIX ) ) {
				$classes[] = $class;
			}
		}

		sort( $classes );

		/**
		 * Filters the suite adapter classes the tokens route runs.
		 *
		 * @param string[] $classes Class names.
		 */
		$classes = (array) apply_filters( 'x_companion_token_adapters', $classes );

		return array_values( array_filter( $classes, 'class_exists' ) );
	}

	/**
	 * The id an adapter reports itself as in `adapters_applied`.
	 *
	 * @param string $class Class name.
	 * @return string
	 */
	public static function adapter_id( string $class ): string {
		if ( defined( $class . '::ID' ) ) {
			return (string) constant( $class . '::ID' );
		}

		return strtolower( str_replace( '_', '-', substr( $class, strlen( self::ADAPTER_PREFIX ) ) ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /snapshot/export
	 * -------------------------------------------------------------------
	 */

	/**
	 * Stream the artifact bundle. Never returns.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return WP_Error|void
	 */
	public static function route_export( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$archive = self::build_snapshot();

		if ( is_wp_error( $archive ) ) {
			return $archive;
		}

		$size = (int) filesize( $archive );

		if ( ! headers_sent() ) {
			// export_wp() set text/xml and a Content-Disposition of its own
			// while the WXR was being captured; both are replaced here.
			header( 'Content-Type: application/zip' );
			header( 'Content-Disposition: attachment; filename="x-companion-snapshot-' . gmdate( 'Ymd-His' ) . '.zip"' );
			header( 'Content-Length: ' . $size );
			header( 'Content-Transfer-Encoding: binary' );
			header( 'Cache-Control: no-store, no-cache, must-revalidate, max-age=0' );
			header( 'X-Companion-Fingerprint: ' . X_Companion_Manifest::fingerprint() );
		}

		readfile( $archive ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_readfile
		unlink( $archive ); // phpcs:ignore WordPress.WP.AlternativeFunctions.unlink_unlink

		exit;
	}

	/**
	 * Stage the five entries and zip them.
	 *
	 * Staging first means the zip is written by a single recursive add, which
	 * is the one operation both ZipArchive and WordPress's bundled PclZip do
	 * equally well.
	 *
	 * @return string|WP_Error Absolute path of a temporary zip.
	 */
	public static function build_snapshot() {
		$stage = self::temp_dir( 'x-companion-snapshot-' );

		if ( is_wp_error( $stage ) ) {
			return $stage;
		}

		$theme_dir  = $stage . '/theme';
		$blocks_dir = $stage . '/agent-blocks';

		if ( ! wp_mkdir_p( $theme_dir ) || ! wp_mkdir_p( $blocks_dir ) ) {
			self::rmdir_recursive( $stage );

			return new WP_Error( 'export_failed', __( 'Could not stage the snapshot.', 'x-companion' ), array( 'status' => 500 ) );
		}

		if ( function_exists( 'get_stylesheet_directory' ) ) {
			self::copy_recursive( get_stylesheet_directory(), $theme_dir );
		}

		// Installed agent packages are standard plugins; export each one whole,
		// so the artifact re-installs on the target exactly as it ran here.
		$prefixes = array( X_Companion_Block_Library::PLUGIN_PREFIX, X_Companion_Block_Library::SCHEMA_PLUGIN_PREFIX );

		foreach ( $prefixes as $prefix ) {
			$plugin_dirs = glob( rtrim( (string) WP_PLUGIN_DIR, '/\\' ) . '/' . $prefix . '*', GLOB_ONLYDIR );

			foreach ( is_array( $plugin_dirs ) ? $plugin_dirs : array() as $plugin_dir ) {
				self::copy_recursive( $plugin_dir, $blocks_dir . '/' . basename( $plugin_dir ) );
			}
		}

		$patterns = X_Companion_Rest::route_patterns();
		$patterns = $patterns instanceof WP_REST_Response ? $patterns->get_data() : $patterns;

		file_put_contents( $stage . '/patterns.json', (string) wp_json_encode( $patterns, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		file_put_contents( $stage . '/content.xml', self::content_xml() ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		file_put_contents( $stage . '/manifest.json', (string) wp_json_encode( X_Companion_Manifest::get_manifest( true ), JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE ) ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents

		$archive = self::zip_directory( $stage );

		self::rmdir_recursive( $stage );

		return $archive;
	}

	/**
	 * WXR of published posts and pages.
	 *
	 * `export_wp()` cannot be called twice in one request: WordPress defines
	 * `wxr_cdata()` and its siblings **inside** the body of `export_wp()`, so a
	 * second call is a "Cannot redeclare" fatal. It also accepts `status` only
	 * when `content` is a single post type. So the export runs exactly once over
	 * everything, and the `<item>` elements are filtered afterwards — which is
	 * also the only way to get posts *and* pages out of one call.
	 *
	 * @return string
	 */
	public static function content_xml(): string {
		if ( ! function_exists( 'export_wp' ) ) {
			require_once ABSPATH . 'wp-admin/includes/export.php';
		}

		if ( ! function_exists( 'export_wp' ) ) {
			return '';
		}

		global $post;
		$saved = $post;

		ob_start();

		try {
			export_wp( array( 'content' => 'all' ) );
			$xml = (string) ob_get_clean();
		} catch ( Throwable $e ) {
			ob_end_clean();
			$xml = '';
		}

		$post = $saved; // phpcs:ignore WordPress.WP.GlobalVariablesOverride.Prohibited
		wp_reset_postdata();

		return self::filter_wxr_items( $xml, array( 'post', 'page' ), 'publish' );
	}

	/**
	 * Keep only the `<item>` elements of the given post types and status.
	 *
	 * Everything outside the items — channel header, authors, terms — is left
	 * exactly as `export_wp()` wrote it, so the document still imports.
	 *
	 * @param string   $xml    WXR document.
	 * @param string[] $types  Post types to keep.
	 * @param string   $status Post status to keep.
	 * @return string
	 */
	public static function filter_wxr_items( string $xml, array $types, string $status ): string {
		if ( '' === $xml ) {
			return $xml;
		}

		/*
		 * `<item>` is emitted from a PHP template whose leading whitespace
		 * varies with the surrounding control structures, so the delimiters are
		 * matched loosely rather than anchored to a fixed indent. Items never
		 * nest, so the lazy quantifier is exact.
		 */
		$filtered = preg_replace_callback(
			"/[\r\n\t ]*<item>.*?<\/item>/s",
			static function ( $matches ) use ( $types, $status ) {
				$item = $matches[0];

				if ( ! preg_match( '#<wp:post_type>\s*<!\[CDATA\[(.*?)\]\]>\s*</wp:post_type>#s', $item, $type ) ) {
					return '';
				}

				if ( ! in_array( trim( $type[1] ), $types, true ) ) {
					return '';
				}

				if ( ! preg_match( '#<wp:status>\s*<!\[CDATA\[(.*?)\]\]>\s*</wp:status>#s', $item, $found ) ) {
					return '';
				}

				return trim( $found[1] ) === $status ? $item : '';
			},
			$xml
		);

		// A backtrack blow-up on a very large export must not lose the document.
		return ( is_string( $filtered ) && PREG_NO_ERROR === preg_last_error() ) ? $filtered : $xml;
	}

	/*
	 * -------------------------------------------------------------------
	 * Filesystem + zip helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * A fresh empty temp directory.
	 *
	 * @param string $prefix Prefix.
	 * @return string|WP_Error
	 */
	private static function temp_dir( string $prefix ) {
		$dir = rtrim( get_temp_dir(), '/\\' ) . '/' . $prefix . (string) wp_rand( 100000, 999999 );

		if ( ! wp_mkdir_p( $dir ) ) {
			return new WP_Error( 'export_failed', __( 'Could not create a temporary directory.', 'x-companion' ), array( 'status' => 500 ) );
		}

		return $dir;
	}

	/**
	 * Copy a directory tree.
	 *
	 * @param string $source      Source directory.
	 * @param string $destination Destination directory.
	 * @return void
	 */
	private static function copy_recursive( string $source, string $destination ): void {
		if ( '' === $source || ! is_dir( $source ) ) {
			return;
		}

		wp_mkdir_p( $destination );

		$items = scandir( $source );

		foreach ( is_array( $items ) ? $items : array() as $item ) {
			if ( '.' === $item || '..' === $item ) {
				continue;
			}

			$from = $source . '/' . $item;
			$to   = $destination . '/' . $item;

			if ( is_link( $from ) ) {
				continue;
			}

			if ( is_dir( $from ) ) {
				self::copy_recursive( $from, $to );
				continue;
			}

			copy( $from, $to );
		}
	}

	/**
	 * Zip a directory, entries relative to it.
	 *
	 * @param string $dir Directory.
	 * @return string|WP_Error Path to the zip.
	 */
	private static function zip_directory( string $dir ) {
		$archive = rtrim( get_temp_dir(), '/\\' ) . '/x-companion-snapshot-' . (string) wp_rand( 100000, 999999 ) . '.zip';

		if ( class_exists( 'ZipArchive' ) ) {
			$zip = new ZipArchive();

			if ( true !== $zip->open( $archive, ZipArchive::CREATE | ZipArchive::OVERWRITE ) ) {
				return new WP_Error( 'export_failed', __( 'Could not create the snapshot archive.', 'x-companion' ), array( 'status' => 500 ) );
			}

			self::zip_add_dir( $zip, $dir, '' );
			$zip->close();

			return $archive;
		}

		require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';

		$pcl = new PclZip( $archive );

		if ( 0 === $pcl->create( $dir, PCLZIP_OPT_REMOVE_PATH, $dir ) ) {
			return new WP_Error( 'export_failed', __( 'Could not create the snapshot archive.', 'x-companion' ), array( 'status' => 500 ) );
		}

		return $archive;
	}

	/**
	 * Recursively add a directory to an open ZipArchive.
	 *
	 * Empty directories are added explicitly so `theme/` and `agent-blocks/`
	 * are always present, even on an instance with no agent blocks.
	 *
	 * @param ZipArchive $zip    Open archive.
	 * @param string     $dir    Directory to add.
	 * @param string     $prefix Entry prefix.
	 * @return void
	 */
	private static function zip_add_dir( ZipArchive $zip, string $dir, string $prefix ): void {
		$items = scandir( $dir );
		$items = is_array( $items ) ? array_diff( $items, array( '.', '..' ) ) : array();

		if ( '' !== $prefix && empty( $items ) ) {
			$zip->addEmptyDir( rtrim( $prefix, '/' ) );

			return;
		}

		foreach ( $items as $item ) {
			$path  = $dir . '/' . $item;
			$entry = $prefix . $item;

			if ( is_link( $path ) ) {
				continue;
			}

			if ( is_dir( $path ) ) {
				$zip->addEmptyDir( $entry );
				self::zip_add_dir( $zip, $path, $entry . '/' );
				continue;
			}

			$zip->addFile( $path, $entry );
		}
	}

	/**
	 * Recursive delete confined to the system temp directory.
	 *
	 * @param string $dir Directory.
	 * @return void
	 */
	private static function rmdir_recursive( string $dir ): void {
		$temp = rtrim( get_temp_dir(), '/\\' );

		if ( '' === $dir || ! is_dir( $dir ) || 0 !== strpos( $dir, $temp . '/' ) ) {
			return;
		}

		$filesystem = self::filesystem();

		if ( null === $filesystem ) {
			return;
		}

		// Twice: see X_Companion_Block_Library::rmdir_recursive() for why one
		// pass of WP_Filesystem::delete() is not always enough on a mounted
		// filesystem. This is best-effort cleanup of a temp directory, so a
		// second failure is simply left alone.
		for ( $attempt = 0; $attempt < 2; $attempt++ ) {
			$filesystem->delete( $dir, true );
			clearstatcache( true, $dir );

			if ( ! file_exists( $dir ) ) {
				return;
			}
		}
	}
}
