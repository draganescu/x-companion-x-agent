<?php
/**
 * Registry -> Manifest compiler + fingerprint.
 *
 * Split deliberately into two layers:
 *
 *  - LIVE layer  (snapshot_registry(), active_theme(), active_plugins(),
 *                 theme_tokens(), patterns_summary()) touches WordPress.
 *  - PURE layer  (canonical_json(), fingerprint_inputs(), compute_fingerprint(),
 *                 build_blocks(), build()) is a function of an injected
 *                 registry snapshot array and takes no globals.
 *
 * The pure layer is what tests/bootstrap-lite.php exercises offline against
 * fixtures/registry-snapshot.json. Keep it that way: no get_option(), no
 * wp_get_global_settings(), no registry reads below build().
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Manifest compiler.
 */
final class X_Companion_Manifest {

	/**
	 * Transient name prefix. The remainder of the name is the fingerprint,
	 * so a registry change invalidates the cache by construction.
	 */
	const TRANSIENT_PREFIX = 'x_companion_manifest_';

	/** Option tracking the transient currently in play, so bust_cache() can find it. */
	const CACHE_KEY_OPTION = 'x_companion_manifest_cache_key';

	/** Manifest transient TTL. The fingerprint is the real invalidator; this is a backstop. */
	const TRANSIENT_TTL = DAY_IN_SECONDS;

	/**
	 * Suite slugs recognised in the manifest's `suites` list.
	 *
	 * @var string[]
	 */
	const KNOWN_SUITES = array(
		'kadence-blocks',
		'ultimate-addons-for-gutenberg',
		'generateblocks',
		'stackable-ultimate-gutenberg-blocks',
		'woocommerce',
	);

	/**
	 * Per-request memo of the registry snapshot.
	 *
	 * @var array<string,array>|null
	 */
	private static $snapshot = null;

	/**
	 * Per-request memo of the fingerprint.
	 *
	 * @var string|null
	 */
	private static $fingerprint = null;

	/**
	 * Per-request memo of the built manifest.
	 *
	 * @var array|null
	 */
	private static $manifest = null;

	/**
	 * Register cache invalidation hooks.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_action( 'activated_plugin', array( __CLASS__, 'bust_cache' ) );
		add_action( 'deactivated_plugin', array( __CLASS__, 'bust_cache' ) );
		add_action( 'switch_theme', array( __CLASS__, 'bust_cache' ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * Public API (also the seam the block-library / theme-tokens agent uses)
	 * -------------------------------------------------------------------
	 */

	/**
	 * Drop every cached manifest artefact.
	 *
	 * Call after anything that changes the registry mid-request (block
	 * install, rollback, delete) and then read fingerprint() for the new epoch.
	 *
	 * @return void
	 */
	public static function bust_cache(): void {
		self::$snapshot    = null;
		self::$fingerprint = null;
		self::$manifest    = null;

		if ( function_exists( 'get_option' ) ) {
			$key = get_option( self::CACHE_KEY_OPTION );
			if ( is_string( $key ) && '' !== $key ) {
				delete_transient( $key );
			}
			delete_option( self::CACHE_KEY_OPTION );
		}
	}

	/**
	 * The epoch.
	 *
	 * Cheap by contract: reads the in-memory block registry, the active theme
	 * header and the active plugin headers. Never builds patterns or global
	 * settings.
	 *
	 * @param bool $force_refresh Recompute even if memoised this request.
	 * @return string 64 hex characters.
	 */
	public static function fingerprint( bool $force_refresh = false ): string {
		if ( $force_refresh ) {
			self::$snapshot    = null;
			self::$fingerprint = null;
		}

		if ( null !== self::$fingerprint ) {
			return self::$fingerprint;
		}

		$inputs = self::fingerprint_inputs(
			self::snapshot_registry(),
			self::active_theme(),
			self::active_plugins(),
			self::global_styles_stamp()
		);

		self::$fingerprint = self::compute_fingerprint( $inputs );

		return self::$fingerprint;
	}

	/**
	 * The full manifest.
	 *
	 * Cached in a transient keyed by the fingerprint. Every call recomputes the
	 * cheap fingerprint; the heavy body (patterns, theme tokens, hints,
	 * variation counts) is rebuilt only when the fingerprint moved.
	 *
	 * @param bool $force_refresh Bypass both memo and transient.
	 * @return array Manifest.
	 */
	public static function get_manifest( bool $force_refresh = false ): array {
		if ( $force_refresh ) {
			self::bust_cache();
		}

		if ( null !== self::$manifest ) {
			return self::$manifest;
		}

		$fingerprint = self::fingerprint();
		$key         = self::TRANSIENT_PREFIX . substr( $fingerprint, 0, 32 );

		if ( ! $force_refresh ) {
			$cached = get_transient( $key );
			if ( is_array( $cached ) && isset( $cached['fingerprint'] ) && $cached['fingerprint'] === $fingerprint ) {
				self::$manifest = $cached;

				return $cached;
			}
		}

		$manifest = self::build(
			self::snapshot_registry(),
			array(
				'fingerprint'        => $fingerprint,
				'generated_at'       => gmdate( 'c' ),
				'wp_version'         => (string) get_bloginfo( 'version' ),
				'site_url'           => (string) get_site_url(),
				'posture'            => x_companion_posture(),
				'interfaces_version' => X_COMPANION_INTERFACES_VERSION,
				'patterns'           => self::patterns_summary(),
				'theme_tokens'       => self::theme_tokens(),
				'suites'             => self::suites( self::active_plugins() ),
			)
		);

		set_transient( $key, $manifest, self::TRANSIENT_TTL );
		update_option( self::CACHE_KEY_OPTION, $key, false );

		self::$manifest = $manifest;

		return $manifest;
	}

	/*
	 * -------------------------------------------------------------------
	 * Pure layer: canonical JSON
	 * -------------------------------------------------------------------
	 */

	/**
	 * Recursively sort object keys ascending byte order.
	 *
	 * PHP list arrays keep their order (they are JSON arrays). PHP assoc
	 * arrays and stdClass are JSON objects and are ksort()ed at every depth.
	 * stdClass is preserved as stdClass so an empty object stays `{}` rather
	 * than collapsing to `[]`.
	 *
	 * @param mixed $value Value.
	 * @return mixed Canonicalised value.
	 */
	public static function canonicalize( $value ) {
		if ( $value instanceof stdClass ) {
			$assoc = (array) $value;
			ksort( $assoc, SORT_STRING );
			foreach ( $assoc as $k => $v ) {
				$assoc[ $k ] = self::canonicalize( $v );
			}

			return (object) $assoc;
		}

		if ( is_array( $value ) ) {
			if ( array_is_list( $value ) ) {
				return array_map( array( __CLASS__, 'canonicalize' ), $value );
			}

			ksort( $value, SORT_STRING );
			foreach ( $value as $k => $v ) {
				$value[ $k ] = self::canonicalize( $v );
			}

			return $value;
		}

		return $value;
	}

	/**
	 * Canonical JSON per CONTRACT.md section 4.
	 *
	 * UTF-8, object keys sorted ascending byte order at every depth, no
	 * insignificant whitespace, `/` not escaped, unicode not escaped.
	 *
	 * @param mixed $value Value.
	 * @return string JSON.
	 */
	public static function canonical_json( $value ): string {
		$flags = JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE;

		$canonical = self::canonicalize( $value );

		if ( function_exists( 'wp_json_encode' ) ) {
			$json = wp_json_encode( $canonical, $flags );
		} else {
			$json = json_encode( $canonical, $flags ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode
		}

		return is_string( $json ) ? $json : '';
	}

	/*
	 * -------------------------------------------------------------------
	 * Pure layer: fingerprint
	 * -------------------------------------------------------------------
	 */

	/**
	 * Build the pinned fingerprint_inputs object.
	 *
	 * Exactly the shape in CONTRACT.md section 4. Keys are emitted in the
	 * documented order; canonical_json() sorts them anyway, the order is kept
	 * so a dumped inputs object is readable next to the contract.
	 *
	 * @param array $snapshot Registry snapshot, name => normalised block.
	 * @param array $theme    { slug, version }.
	 * @param array $plugins  List of { slug, version }.
	 * @return array
	 */
	public static function fingerprint_inputs( array $snapshot, array $theme, array $plugins, string $global_styles = '' ): array {
		$names = array_keys( $snapshot );
		usort( $names, 'strcmp' );

		$blocks = array();
		foreach ( $names as $name ) {
			$block    = $snapshot[ $name ];
			$blocks[] = array(
				'name'        => (string) $name,
				'api_version' => (int) ( $block['api_version'] ?? 1 ),
				'attributes'  => self::as_object( $block['attributes'] ?? array() ),
				'parent'      => self::as_sorted_list_or_null( $block['parent'] ?? null ),
				'ancestor'    => self::as_sorted_list_or_null( $block['ancestor'] ?? null ),
			);
		}

		usort(
			$plugins,
			static function ( $a, $b ) {
				return strcmp( (string) ( $a['slug'] ?? '' ), (string) ( $b['slug'] ?? '' ) );
			}
		);

		$plugin_list = array();
		foreach ( $plugins as $plugin ) {
			$plugin_list[] = array(
				'slug'    => (string) ( $plugin['slug'] ?? '' ),
				'version' => (string) ( $plugin['version'] ?? '' ),
			);
		}

		return array(
			'interfaces_version' => defined( 'X_COMPANION_INTERFACES_VERSION' ) ? X_COMPANION_INTERFACES_VERSION : '1',
			'blocks'             => $blocks,
			'theme'              => array(
				'slug'    => (string) ( $theme['slug'] ?? '' ),
				'version' => (string) ( $theme['version'] ?? '' ),
			),
			'plugins'            => $plugin_list,
			'global_styles'      => $global_styles,
		);
	}

	/**
	 * sha256 of the canonical JSON of the inputs.
	 *
	 * @param array $inputs Result of fingerprint_inputs().
	 * @return string 64 hex characters.
	 */
	public static function compute_fingerprint( array $inputs ): string {
		return hash( 'sha256', self::canonical_json( $inputs ) );
	}

	/*
	 * -------------------------------------------------------------------
	 * Pure layer: manifest body
	 * -------------------------------------------------------------------
	 */

	/**
	 * Default agent hints.
	 *
	 * @return array
	 */
	public static function default_hints(): array {
		return array(
			'allowed_blocks'     => null,
			'template_lock'      => null,
			'usage_notes'        => '',
			'example_attributes' => array(),
		);
	}

	/**
	 * True when a hints array carries nothing beyond the defaults.
	 *
	 * @param array $hints Hints.
	 * @return bool
	 */
	private static function hints_are_default( array $hints ): bool {
		$defaults = self::default_hints();

		foreach ( $defaults as $key => $default ) {
			$value = $hints[ $key ] ?? $default;
			if ( is_object( $value ) ) {
				$value = (array) $value;
			}
			if ( $value !== $default ) {
				return false;
			}
		}

		return count( array_diff_key( $hints, $defaults ) ) === 0;
	}

	/**
	 * Compile the manifest `blocks` map from a registry snapshot.
	 *
	 * Applies the x_companion_agent_hints filter per block. The third filter
	 * argument is the live WP_Block_Type when one is available (it is carried
	 * on the snapshot entry under `_type`, which is never emitted); offline it
	 * is null.
	 *
	 * @param array $snapshot Registry snapshot.
	 * @return array name => block entry.
	 */
	public static function build_blocks( array $snapshot ): array {
		$names = array_keys( $snapshot );
		usort( $names, 'strcmp' );

		$blocks = array();

		foreach ( $names as $name ) {
			$block = $snapshot[ $name ];

			$entry = array(
				'title'            => (string) ( $block['title'] ?? $name ),
				'category'         => isset( $block['category'] ) ? ( null === $block['category'] ? null : (string) $block['category'] ) : null,
				'api_version'      => (int) ( $block['api_version'] ?? 1 ),
				'attributes'       => self::as_object( $block['attributes'] ?? array() ),
				'supports'         => self::as_object( $block['supports'] ?? array() ),
				'parent'           => self::as_sorted_list_or_null( $block['parent'] ?? null ),
				'ancestor'         => self::as_sorted_list_or_null( $block['ancestor'] ?? null ),
				'provides_context' => self::as_object( $block['provides_context'] ?? array() ),
				'uses_context'     => array_values( (array) ( $block['uses_context'] ?? array() ) ),
				'is_dynamic'       => (bool) ( $block['is_dynamic'] ?? false ),
				'variations_count' => (int) ( $block['variations_count'] ?? 0 ),
			);

			$hints = array_merge( self::default_hints(), (array) ( $block['agent_hints'] ?? array() ) );

			if ( function_exists( 'apply_filters' ) ) {
				$filtered = apply_filters( 'x_companion_agent_hints', $hints, (string) $name, $block['_type'] ?? null );
				if ( is_array( $filtered ) ) {
					$hints = array_merge( $hints, $filtered );
				}
			}

			$hints = self::normalize_hints( $hints );

			if ( ! self::hints_are_default( $hints ) ) {
				$hints['example_attributes'] = self::as_object( $hints['example_attributes'] );
				$entry['agent_hints']        = $hints;
			}

			$blocks[ (string) $name ] = $entry;
		}

		return $blocks;
	}

	/**
	 * Coerce filtered hints into the contract shape.
	 *
	 * @param array $hints Raw hints.
	 * @return array
	 */
	private static function normalize_hints( array $hints ): array {
		$out = self::default_hints();

		if ( isset( $hints['allowed_blocks'] ) && is_array( $hints['allowed_blocks'] ) ) {
			$out['allowed_blocks'] = array_values( array_map( 'strval', $hints['allowed_blocks'] ) );
		}

		if ( array_key_exists( 'template_lock', $hints ) ) {
			$lock = $hints['template_lock'];
			if ( is_string( $lock ) || is_bool( $lock ) || null === $lock ) {
				$out['template_lock'] = $lock;
			}
		}

		if ( isset( $hints['usage_notes'] ) && is_string( $hints['usage_notes'] ) ) {
			$out['usage_notes'] = $hints['usage_notes'];
		}

		if ( isset( $hints['example_attributes'] ) ) {
			$example = $hints['example_attributes'];
			if ( is_object( $example ) ) {
				$example = (array) $example;
			}
			if ( is_array( $example ) ) {
				$out['example_attributes'] = $example;
			}
		}

		return $out;
	}

	/**
	 * Assemble the whole manifest from a snapshot plus a live context bundle.
	 *
	 * @param array $snapshot Registry snapshot.
	 * @param array $context  fingerprint, generated_at, wp_version, site_url,
	 *                        posture, interfaces_version, patterns,
	 *                        theme_tokens, suites.
	 * @return array Manifest.
	 */
	public static function build( array $snapshot, array $context ): array {
		$blocks = self::build_blocks( $snapshot );

		$dynamic = 0;
		foreach ( $blocks as $block ) {
			if ( ! empty( $block['is_dynamic'] ) ) {
				++$dynamic;
			}
		}

		$patterns = array_values( (array) ( $context['patterns'] ?? array() ) );

		return array(
			'fingerprint'        => (string) ( $context['fingerprint'] ?? '' ),
			'generated_at'       => (string) ( $context['generated_at'] ?? '' ),
			'wp_version'         => (string) ( $context['wp_version'] ?? '' ),
			'site_url'           => (string) ( $context['site_url'] ?? '' ),
			'posture'            => 'toolchain' === ( $context['posture'] ?? '' ) ? 'toolchain' : 'production',
			'interfaces_version' => (string) ( $context['interfaces_version'] ?? '1' ),
			'blocks'             => $blocks,
			'patterns'           => $patterns,
			'theme_tokens'       => self::normalize_theme_tokens( (array) ( $context['theme_tokens'] ?? array() ) ),
			'suites'             => array_values( (array) ( $context['suites'] ?? array() ) ),
			'counts'             => array(
				'blocks'         => count( $blocks ),
				'dynamic_blocks' => $dynamic,
				'static_blocks'  => count( $blocks ) - $dynamic,
				'patterns'       => count( $patterns ),
			),
		);
	}

	/**
	 * Guarantee the four required theme_tokens groups exist.
	 *
	 * @param array $tokens Raw tokens.
	 * @return array
	 */
	public static function normalize_theme_tokens( array $tokens ): array {
		return array(
			'color'      => array(
				'palette' => $tokens['color']['palette'] ?? self::as_object( array() ),
			),
			'spacing'    => array(
				'spacingSizes' => $tokens['spacing']['spacingSizes'] ?? self::as_object( array() ),
				'spacingScale' => $tokens['spacing']['spacingScale'] ?? self::as_object( array() ),
			),
			'typography' => array(
				'fontSizes'    => $tokens['typography']['fontSizes'] ?? self::as_object( array() ),
				'fontFamilies' => $tokens['typography']['fontFamilies'] ?? self::as_object( array() ),
			),
			'layout'     => array(
				'contentSize' => $tokens['layout']['contentSize'] ?? '',
				'wideSize'    => $tokens['layout']['wideSize'] ?? '',
			),
		);
	}

	/**
	 * Filter the active plugin list down to recognised block suites.
	 *
	 * @param array $plugins List of { slug, version }.
	 * @return array List of { slug, version }.
	 */
	public static function suites( array $plugins ): array {
		$suites = array();

		foreach ( $plugins as $plugin ) {
			$slug = (string) ( $plugin['slug'] ?? '' );
			if ( in_array( $slug, self::KNOWN_SUITES, true ) ) {
				$suites[] = array(
					'slug'    => $slug,
					'version' => (string) ( $plugin['version'] ?? '' ),
				);
			}
		}

		return $suites;
	}

	/**
	 * A stamp for the user-origin global styles, so design-token writes move
	 * the fingerprint.
	 *
	 * Without this, POST /theme/tokens changed what the manifest reports
	 * (theme_tokens) while the fingerprint — and therefore the manifest
	 * transient key — stayed put, so clients kept reading stale tokens until
	 * a forced refresh. The stamp is the sha256 of the user global-styles
	 * post content ('' when none exists), which is exactly the surface the
	 * tokens route writes.
	 *
	 * @return string 64 hex characters, or ''.
	 */
	public static function global_styles_stamp(): string {
		if ( ! class_exists( 'WP_Theme_JSON_Resolver' ) || ! method_exists( 'WP_Theme_JSON_Resolver', 'get_user_global_styles_post_id' ) ) {
			return '';
		}

		$post_id = (int) WP_Theme_JSON_Resolver::get_user_global_styles_post_id();

		if ( $post_id <= 0 ) {
			return '';
		}

		$post = get_post( $post_id );

		if ( ! $post || '' === (string) $post->post_content ) {
			return '';
		}

		return hash( 'sha256', (string) $post->post_content );
	}

	/*
	 * -------------------------------------------------------------------
	 * Live layer
	 * -------------------------------------------------------------------
	 */

	/**
	 * Normalise the live block registry into the snapshot shape.
	 *
	 * This is the ONLY place the manifest reads WP_Block_Type_Registry.
	 * Installed agent blocks appear here automatically as long as they are
	 * registered on `init` -- there is no special-casing by namespace.
	 *
	 * @return array name => normalised block.
	 */
	public static function snapshot_registry(): array {
		if ( null !== self::$snapshot ) {
			return self::$snapshot;
		}

		$snapshot = array();

		if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
			self::$snapshot = $snapshot;

			return $snapshot;
		}

		$registry = WP_Block_Type_Registry::get_instance();

		foreach ( $registry->get_all_registered() as $name => $type ) {
			$attributes = method_exists( $type, 'get_attributes' )
				? $type->get_attributes()
				: (array) ( $type->attributes ?? array() );

			$variations = $type->variations ?? null;

			$snapshot[ (string) $name ] = array(
				'title'            => (string) ( $type->title ?? $name ),
				'category'         => isset( $type->category ) ? $type->category : null,
				'api_version'      => (int) ( $type->api_version ?? 1 ),
				'attributes'       => is_array( $attributes ) ? $attributes : array(),
				'supports'         => (array) ( $type->supports ?? array() ),
				'parent'           => is_array( $type->parent ?? null ) ? $type->parent : null,
				'ancestor'         => is_array( $type->ancestor ?? null ) ? $type->ancestor : null,
				'provides_context' => (array) ( $type->provides_context ?? array() ),
				'uses_context'     => array_values( (array) ( $type->uses_context ?? array() ) ),
				'is_dynamic'       => method_exists( $type, 'is_dynamic' ) ? (bool) $type->is_dynamic() : is_callable( $type->render_callback ?? null ),
				'variations_count' => is_array( $variations ) ? count( $variations ) : 0,
				'_type'            => $type,
			);
		}

		self::$snapshot = $snapshot;

		return $snapshot;
	}

	/**
	 * Active theme slug + version.
	 *
	 * @return array { slug, version }
	 */
	public static function active_theme(): array {
		if ( ! function_exists( 'wp_get_theme' ) ) {
			return array(
				'slug'    => '',
				'version' => '',
			);
		}

		$theme = wp_get_theme();

		return array(
			'slug'    => (string) $theme->get_stylesheet(),
			'version' => (string) $theme->get( 'Version' ),
		);
	}

	/**
	 * Active plugins as { slug, version }.
	 *
	 * `slug` is the plugin file's dirname, or its basename without `.php` for
	 * single-file plugins. Versions come from get_file_data(), not
	 * get_plugins(), so this stays cheap enough for GET /fingerprint.
	 *
	 * @return array List of { slug, version }.
	 */
	public static function active_plugins(): array {
		$files = (array) get_option( 'active_plugins', array() );

		if ( function_exists( 'is_multisite' ) && is_multisite() ) {
			$network = get_site_option( 'active_sitewide_plugins', array() );
			if ( is_array( $network ) ) {
				$files = array_merge( $files, array_keys( $network ) );
			}
		}

		$files   = array_values( array_unique( array_map( 'strval', $files ) ) );
		$plugins = array();

		foreach ( $files as $file ) {
			$dir  = dirname( $file );
			$slug = ( '.' === $dir || '' === $dir ) ? basename( $file, '.php' ) : $dir;

			$version = '';
			$path    = defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR . '/' . $file : '';
			if ( $path && file_exists( $path ) && function_exists( 'get_file_data' ) ) {
				$data    = get_file_data( $path, array( 'Version' => 'Version' ), 'plugin' );
				$version = (string) ( $data['Version'] ?? '' );
			}

			$plugins[] = array(
				'slug'    => $slug,
				'version' => $version,
			);
		}

		return $plugins;
	}

	/**
	 * The resolved theme token subset.
	 *
	 * @return array
	 */
	public static function theme_tokens(): array {
		if ( ! function_exists( 'wp_get_global_settings' ) ) {
			return self::normalize_theme_tokens( array() );
		}

		$settings = wp_get_global_settings();
		$settings = is_array( $settings ) ? $settings : array();

		return self::normalize_theme_tokens(
			array(
				'color'      => array(
					'palette' => $settings['color']['palette'] ?? self::as_object( array() ),
				),
				'spacing'    => array(
					'spacingSizes' => $settings['spacing']['spacingSizes'] ?? self::as_object( array() ),
					'spacingScale' => $settings['spacing']['spacingScale'] ?? self::as_object( array() ),
				),
				'typography' => array(
					'fontSizes'    => $settings['typography']['fontSizes'] ?? self::as_object( array() ),
					'fontFamilies' => $settings['typography']['fontFamilies'] ?? self::as_object( array() ),
				),
				'layout'     => array(
					'contentSize' => $settings['layout']['contentSize'] ?? '',
					'wideSize'    => $settings['layout']['wideSize'] ?? '',
				),
			)
		);
	}

	/**
	 * Pattern summaries for the manifest. Content itself lives on GET /patterns.
	 *
	 * @return array List of { name, title, categories, source, has_content }.
	 */
	public static function patterns_summary(): array {
		if ( ! class_exists( 'WP_Block_Patterns_Registry' ) ) {
			return array();
		}

		$out = array();

		foreach ( WP_Block_Patterns_Registry::get_instance()->get_all_registered() as $pattern ) {
			$out[] = array(
				'name'        => (string) ( $pattern['name'] ?? '' ),
				'title'       => (string) ( $pattern['title'] ?? '' ),
				'categories'  => array_values( array_map( 'strval', (array) ( $pattern['categories'] ?? array() ) ) ),
				'source'      => isset( $pattern['source'] ) ? (string) $pattern['source'] : null,
				'has_content' => '' !== trim( (string) ( $pattern['content'] ?? '' ) ),
			);
		}

		usort(
			$out,
			static function ( $a, $b ) {
				return strcmp( $a['name'], $b['name'] );
			}
		);

		return $out;
	}

	/*
	 * -------------------------------------------------------------------
	 * Helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * Force a value to encode as a JSON object.
	 *
	 * An empty PHP array encodes as `[]`; the manifest schema demands `{}` for
	 * attributes/supports/provides_context, so empties become stdClass.
	 *
	 * @param mixed $value Value.
	 * @return array|stdClass
	 */
	public static function as_object( $value ) {
		if ( $value instanceof stdClass ) {
			return $value;
		}

		if ( ! is_array( $value ) || array() === $value ) {
			return new stdClass();
		}

		return $value;
	}

	/**
	 * Null, or the list sorted ascending.
	 *
	 * @param mixed $value Value.
	 * @return array|null
	 */
	public static function as_sorted_list_or_null( $value ) {
		if ( ! is_array( $value ) || array() === $value ) {
			return null;
		}

		$list = array_values( array_map( 'strval', $value ) );
		usort( $list, 'strcmp' );

		return $list;
	}
}
