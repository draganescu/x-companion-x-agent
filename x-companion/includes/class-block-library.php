<?php
/**
 * The agent block library: install, list, rollback, delete.
 *
 * CONTRACT.md §5. A block package is a **standard WordPress plugin**: the zip
 * contains one directory, `agent-block-{slug}/`, holding a plugin main file
 * (`agent-block-{slug}.php`, a real plugin header plus one
 * `register_block_type()` on `init`) and the block directory `{slug}/`.
 * Install unpacks it into `wp-content/plugins/` and activates it through
 * `activate_plugin()` — after which WordPress itself loads it on every
 * request, in both postures, exactly like any other plugin. It appears in
 * plugins.php, deactivates there, and deletes there. There is no sideband
 * loader and no PHP under uploads, by design.
 *
 * Rollback copies live in `wp-content/upgrade-temp-backup/plugins/` — the
 * location WordPress core's own upgrader uses for exactly this purpose.
 *
 * Validation is **structural only**: zip shape, block.json shape, referenced
 * files present, no traversal, size cap. There is no `php -l` and no `exec`.
 * The safety gate for "does this code actually work" is on the agent side,
 * which smoke-tests the identical plugin layout in a throwaway Playground
 * before it POSTs.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Agent block library.
 */
final class X_Companion_Block_Library {

	/** Plugin directory prefix for installed block packages. */
	const PLUGIN_PREFIX = 'agent-block-';

	/** Plugin directory prefix for installed schema packages (shared path guard). */
	const SCHEMA_PLUGIN_PREFIX = 'agent-schema-';

	/** Hard size cap, compressed and uncompressed. */
	const MAX_BYTES = 5242880;

	/**
	 * block.json keys whose values may point at files in the package.
	 *
	 * @var string[]
	 */
	const FILE_KEYS = array(
		'render',
		'editorScript',
		'editorScriptModule',
		'script',
		'scriptModule',
		'viewScript',
		'viewScriptModule',
		'editorStyle',
		'style',
		'viewStyle',
	);

	/**
	 * Hook the four dispatched routes.
	 *
	 * Registration needs no hook of its own any more: every installed package
	 * is an active plugin, so WordPress loads it and the package's own `init`
	 * callback registers the block.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_blocks_install', array( __CLASS__, 'route_install' ), 10, 2 );
		add_filter( 'x_companion_route_blocks_library', array( __CLASS__, 'route_library' ), 10, 2 );
		add_filter( 'x_companion_route_blocks_rollback', array( __CLASS__, 'route_rollback' ), 10, 2 );
		add_filter( 'x_companion_route_blocks_delete', array( __CLASS__, 'route_delete' ), 10, 2 );
	}

	/*
	 * -------------------------------------------------------------------
	 * Paths
	 * -------------------------------------------------------------------
	 */

	/**
	 * The plugin's shared WP_Filesystem accessor.
	 *
	 * Every mutation this plugin makes below wp-content goes through
	 * WP_Filesystem rather than rename()/rmdir()/unlink() directly, so it keeps
	 * working on installations whose FS_METHOD is not `direct` — and so the
	 * plugin passes Plugin Check without waivers. It lives on this class because
	 * this is the class that owns the plugin's on-disk state; X_Companion_Theme_Tokens
	 * borrows it for the snapshot staging area.
	 *
	 * @return WP_Filesystem_Base|null Null when credentials would be required.
	 */
	public static function filesystem(): ?WP_Filesystem_Base {
		global $wp_filesystem;

		if ( $wp_filesystem instanceof WP_Filesystem_Base ) {
			return $wp_filesystem;
		}

		if ( ! function_exists( 'WP_Filesystem' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}

		if ( ! WP_Filesystem() ) {
			return null;
		}

		return ( $wp_filesystem instanceof WP_Filesystem_Base ) ? $wp_filesystem : null;
	}

	/**
	 * The plugin-management API (activate_plugin() and friends).
	 *
	 * @return void
	 */
	public static function plugin_api(): void {
		if ( ! function_exists( 'activate_plugin' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
	}

	/**
	 * Move a file or directory into place, replacing whatever is there.
	 *
	 * Three things this does that a bare `$wp_filesystem->move( $s, $d, true )`
	 * does not, all of them forced by measurement against Playground's mounted
	 * (WASM) filesystem, where a worker's view of a directory can disagree with
	 * the directory:
	 *
	 *  1. clearstatcache() around the decisions. Observed inside one request:
	 *     is_dir( $target ) false at the top of the installer, file_exists( $target )
	 *     true a few statements later.
	 *  2. Clear a real destination here, where a failure is actionable, instead of
	 *     inside WP_Filesystem::move()'s overwrite branch — that branch abandons
	 *     the whole move when its recursive delete reports even a partial failure.
	 *  3. Judge the result by the state of the filesystem, and fall back to
	 *     rename() when the wrapper refuses. Observed: move() returning false with
	 *     a bare rename() of the same two paths succeeding on the very next line,
	 *     because move()'s pre-flight exists() check saw an entry that is not
	 *     really there. rename() is exactly what move() would have called.
	 *
	 * @param string $source      Source path.
	 * @param string $destination Destination path.
	 * @return bool Whether the destination now holds what the source held.
	 */
	private static function move( string $source, string $destination ): bool {
		$filesystem = self::filesystem();

		if ( null === $filesystem ) {
			return false;
		}

		clearstatcache( true );

		if ( is_dir( $destination ) && ! self::rmdir_recursive( $destination ) ) {
			return false;
		}

		if ( file_exists( $destination ) && ! is_dir( $destination ) ) {
			$filesystem->delete( $destination );
			clearstatcache( true, $destination );
		}

		if ( ! $filesystem->move( $source, $destination, true ) ) {
			// phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename -- deliberate last resort; see the method docblock. WP_Filesystem::move() has just refused this exact rename on a filesystem where it succeeds.
			@rename( $source, $destination );
		}

		clearstatcache( true );

		return file_exists( $destination ) && ! file_exists( $source );
	}

	/**
	 * The error a filesystem operation gets when WP_Filesystem is unusable.
	 *
	 * @param string $code    Error code.
	 * @param string $message What was being attempted.
	 * @return WP_Error
	 */
	private static function filesystem_error( string $code, string $message ): WP_Error {
		if ( null === self::filesystem() ) {
			$message .= ' ' . __( 'WP_Filesystem needs credentials on this installation; define FS_METHOD as "direct", or supply FTP constants in wp-config.php.', 'x-companion' );
		}

		return new WP_Error( $code, $message, array( 'status' => 500 ) );
	}

	/**
	 * Where rollback copies live: core's own upgrade backup location.
	 *
	 * @return string
	 */
	public static function backup_root(): string {
		return rtrim( (string) WP_CONTENT_DIR, '/\\' ) . '/upgrade-temp-backup/plugins';
	}

	/**
	 * The plugin directory name for a block slug.
	 *
	 * @param string $slug Slug.
	 * @return string
	 */
	public static function plugin_dir_name( string $slug ): string {
		return self::PLUGIN_PREFIX . $slug;
	}

	/**
	 * Absolute path of one installed block package (a real plugin directory).
	 *
	 * @param string $slug Slug.
	 * @param bool   $prev Address the rollback copy instead.
	 * @return string
	 */
	public static function plugin_dir( string $slug, bool $prev = false ): string {
		if ( '' === $slug ) {
			return '';
		}

		$root = $prev ? self::backup_root() : rtrim( (string) WP_PLUGIN_DIR, '/\\' );

		return $root . '/' . self::plugin_dir_name( $slug );
	}

	/**
	 * The plugin basename WordPress activates: agent-block-{slug}/agent-block-{slug}.php.
	 *
	 * @param string $slug Slug.
	 * @return string
	 */
	public static function plugin_basename_for( string $slug ): string {
		return self::plugin_dir_name( $slug ) . '/' . self::plugin_dir_name( $slug ) . '.php';
	}

	/**
	 * Absolute path of one installed block's block directory (where block.json lives).
	 *
	 * @param string $slug Slug.
	 * @param bool   $prev Address the rollback copy instead.
	 * @return string
	 */
	public static function block_dir( string $slug, bool $prev = false ): string {
		$plugin = self::plugin_dir( $slug, $prev );

		return '' === $plugin ? '' : $plugin . '/' . $slug;
	}

	/**
	 * The block namespace agent packages must use.
	 *
	 * @return string
	 */
	public static function block_namespace(): string {
		/**
		 * Filters the namespace an installable agent block must declare.
		 *
		 * @param string $namespace Default 'agent'.
		 */
		$namespace = apply_filters( 'x_companion_block_namespace', 'agent' );

		return ( is_string( $namespace ) && preg_match( '/^[a-z][a-z0-9-]*$/', $namespace ) ) ? $namespace : 'agent';
	}

	/**
	 * Register a single block directory, defensively.
	 *
	 * Used only for same-request registration right after an install or a
	 * rollback (the `init` hook has already fired by then, so the freshly
	 * activated plugin's own callback will not run until the next request —
	 * but the fingerprint returned to the agent must already cover the block).
	 *
	 * @param string $dir Absolute path of a directory containing block.json.
	 * @return bool True when the block ended up registered.
	 */
	public static function register_one( string $dir ): bool {
		$manifest = $dir . '/block.json';

		if ( ! file_exists( $manifest ) || ! is_readable( $manifest ) ) {
			return false;
		}

		$metadata = json_decode( (string) file_get_contents( $manifest ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents

		if ( ! is_array( $metadata ) || empty( $metadata['name'] ) || ! is_string( $metadata['name'] ) ) {
			self::log( 'x-companion: skipping ' . $dir . ' — block.json is missing or has no name.' );

			return false;
		}

		// A declared render file that is not on disk is a guaranteed fatal at
		// render time; refuse to register rather than find out later.
		if ( ! empty( $metadata['render'] ) && is_string( $metadata['render'] ) ) {
			$render = $dir . '/' . self::normalize_file_reference( $metadata['render'] );
			if ( ! file_exists( $render ) ) {
				self::log( 'x-companion: skipping ' . $metadata['name'] . ' — declared render file is missing.' );

				return false;
			}
		}

		if ( class_exists( 'WP_Block_Type_Registry' ) && WP_Block_Type_Registry::get_instance()->is_registered( $metadata['name'] ) ) {
			return true;
		}

		try {
			$type = register_block_type( $dir );
		} catch ( Throwable $e ) {
			self::log( 'x-companion: registering ' . $metadata['name'] . ' threw ' . get_class( $e ) . ': ' . $e->getMessage() );

			return false;
		}

		return $type instanceof WP_Block_Type;
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /blocks/install
	 * -------------------------------------------------------------------
	 */

	/**
	 * Install a package: unpack into wp-content/plugins/ and activate it as a
	 * standard WordPress plugin.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_install( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$files   = (array) $request->get_file_params();
		$package = isset( $files['package'] ) && is_array( $files['package'] ) ? $files['package'] : null;

		if ( null === $package || empty( $package['tmp_name'] ) ) {
			return new WP_Error(
				'rest_invalid_param',
				__( 'Send the package as multipart/form-data in a field named "package".', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		if ( ! empty( $package['error'] ) ) {
			return new WP_Error(
				'rest_invalid_param',
				sprintf(
					/* translators: %d: PHP upload error code. */
					__( 'The upload failed with PHP error code %d.', 'x-companion' ),
					(int) $package['error']
				),
				array( 'status' => 400 )
			);
		}

		$archive = (string) $package['tmp_name'];

		if ( ! is_readable( $archive ) ) {
			return new WP_Error(
				'rest_invalid_param',
				__( 'The uploaded package could not be read.', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		$analysis = self::analyze_package( $archive );

		if ( is_wp_error( $analysis ) ) {
			return $analysis;
		}

		$slug    = (string) $analysis['slug'];
		$target  = self::plugin_dir( $slug );
		$prev    = self::plugin_dir( $slug, true );
		$staging = rtrim( (string) WP_PLUGIN_DIR, '/\\' ) . '/.agent-staging-' . $slug . '-' . (string) wp_rand( 100000, 999999 );

		$extracted = self::extract( $archive, $analysis, $staging );

		if ( is_wp_error( $extracted ) ) {
			self::rmdir_recursive( $staging );

			return $extracted;
		}

		$replaced = false;

		// A worker that has not touched this directory recently can hold a stale
		// stat for it; replaced_previous, and therefore whether a rollback exists,
		// depends on getting this right.
		clearstatcache( true );

		if ( is_dir( $target ) ) {
			if ( ! wp_mkdir_p( self::backup_root() ) || ! self::rmdir_recursive( $prev ) ) {
				self::rmdir_recursive( $staging );

				return self::filesystem_error(
					'install_failed',
					__( 'Could not clear the previous rollback copy.', 'x-companion' )
				);
			}

			if ( ! self::move( $target, $prev ) ) {
				self::rmdir_recursive( $staging );

				return self::filesystem_error(
					'install_failed',
					__( 'Could not move the existing package aside for rollback.', 'x-companion' )
				);
			}

			$replaced = true;
		}

		if ( ! self::move( $staging, $target ) ) {
			self::rmdir_recursive( $staging );

			if ( $replaced && is_dir( $prev ) ) {
				self::move( $prev, $target );
			}

			return self::filesystem_error(
				'install_failed',
				__( 'Could not move the extracted package into wp-content/plugins.', 'x-companion' )
			);
		}

		// Activate through core — the canonical mechanism. The package becomes a
		// normal row in plugins.php and WordPress loads it on every request.
		self::plugin_api();
		$basename = self::plugin_basename_for( $slug );

		if ( ! is_plugin_active( $basename ) ) {
			$activated = activate_plugin( $basename );

			if ( is_wp_error( $activated ) ) {
				self::rmdir_recursive( $target );

				if ( $replaced && is_dir( $prev ) ) {
					self::move( $prev, $target );
				}

				return new WP_Error(
					'install_failed',
					sprintf(
						/* translators: %s: activation error. */
						__( 'WordPress refused to activate the package: %s', 'x-companion' ),
						$activated->get_error_message()
					),
					array( 'status' => 500 )
				);
			}
		}

		// Same-request registration: init has already fired, so the plugin's own
		// callback runs from the NEXT request on. The fingerprint handed back
		// must already cover the block.
		self::reregister( (string) $analysis['name'], self::block_dir( $slug ) );

		return array(
			'installed'         => array(
				'slug'    => $slug,
				'name'    => (string) $analysis['name'],
				'version' => (string) $analysis['version'],
			),
			'fingerprint'       => self::new_epoch(),
			'replaced_previous' => $replaced,
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * GET /blocks/library
	 * -------------------------------------------------------------------
	 */

	/**
	 * List installed block packages, straight from the plugins directory.
	 *
	 * No private registry: the filesystem plus WordPress's own plugin state is
	 * the source of truth.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public static function route_library( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		self::plugin_api();

		$out  = array();
		$dirs = glob( rtrim( (string) WP_PLUGIN_DIR, '/\\' ) . '/' . self::PLUGIN_PREFIX . '*', GLOB_ONLYDIR );

		foreach ( is_array( $dirs ) ? $dirs : array() as $dir ) {
			$slug     = substr( basename( $dir ), strlen( self::PLUGIN_PREFIX ) );
			$manifest = $dir . '/' . $slug . '/block.json';

			if ( '' === $slug || ! file_exists( $manifest ) ) {
				continue;
			}

			$metadata = json_decode( (string) file_get_contents( $manifest ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$metadata = is_array( $metadata ) ? $metadata : array();

			$main         = $dir . '/' . self::plugin_dir_name( $slug ) . '.php';
			$mtime        = file_exists( $main ) ? filemtime( $main ) : filemtime( $manifest );
			$installed_at = $mtime ? gmdate( 'c', (int) $mtime ) : '';

			$out[] = array(
				'slug'         => $slug,
				'name'         => (string) ( $metadata['name'] ?? '' ),
				'version'      => (string) ( $metadata['version'] ?? '' ),
				'installed_at' => $installed_at,
				'active'       => is_plugin_active( self::plugin_basename_for( $slug ) ),
				'has_prev'     => is_dir( self::plugin_dir( $slug, true ) ),
			);
		}

		usort(
			$out,
			static function ( $a, $b ) {
				return strcmp( $a['slug'], $b['slug'] );
			}
		);

		return $out;
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /blocks/library/{slug}/rollback
	 * -------------------------------------------------------------------
	 */

	/**
	 * Restore the previous version of a block package.
	 *
	 * The plugin directory name is stable across versions, so the plugin stays
	 * active through the swap — exactly how core's own upgrader rolls back.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_rollback( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$slug   = (string) $request->get_param( 'slug' );
		$target = self::plugin_dir( $slug );
		$prev   = self::plugin_dir( $slug, true );

		if ( '' === $target || ( ! is_dir( $target ) && ! is_dir( $prev ) ) ) {
			return self::not_found( $slug );
		}

		if ( ! is_dir( $prev ) ) {
			return new WP_Error(
				'no_previous',
				sprintf(
					/* translators: %s: block slug. */
					__( 'Block "%s" has no previous version to roll back to.', 'x-companion' ),
					$slug
				),
				array( 'status' => 409 )
			);
		}

		$name = self::registered_name( self::block_dir( $slug ) );

		if ( is_dir( $target ) && ! self::rmdir_recursive( $target ) ) {
			return self::filesystem_error(
				'rollback_failed',
				__( 'Could not remove the current version of the block.', 'x-companion' )
			);
		}

		if ( ! self::move( $prev, $target ) ) {
			return self::filesystem_error(
				'rollback_failed',
				__( 'Could not restore the previous version of the block.', 'x-companion' )
			);
		}

		$restored = self::registered_name( self::block_dir( $slug ) );

		self::reregister( '' !== $restored ? $restored : $name, self::block_dir( $slug ) );

		return array( 'fingerprint' => self::new_epoch() );
	}

	/*
	 * -------------------------------------------------------------------
	 * DELETE /blocks/library/{slug}
	 * -------------------------------------------------------------------
	 */

	/**
	 * Remove a block package, unless published content still uses it.
	 *
	 * Deactivates through core first, then removes the plugin directory and
	 * its rollback copy — the same sequence deleting it from plugins.php runs.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_delete( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$slug   = (string) $request->get_param( 'slug' );
		$target = self::plugin_dir( $slug );
		$prev   = self::plugin_dir( $slug, true );

		if ( '' === $target || ( ! is_dir( $target ) && ! is_dir( $prev ) ) ) {
			return self::not_found( $slug );
		}

		$name = self::registered_name( self::block_dir( $slug ) );

		if ( '' !== $name ) {
			$posts = self::posts_using( $name );

			if ( ! empty( $posts ) ) {
				return new WP_Error(
					'in_use',
					sprintf(
						/* translators: 1: block name, 2: number of posts. */
						__( 'Block "%1$s" is still used by %2$d published item(s).', 'x-companion' ),
						$name,
						count( $posts )
					),
					array(
						'status' => 409,
						'posts'  => $posts,
					)
				);
			}
		}

		self::plugin_api();
		deactivate_plugins( self::plugin_basename_for( $slug ) );

		self::rmdir_recursive( $target );
		self::rmdir_recursive( $prev );

		if ( '' !== $name && class_exists( 'WP_Block_Type_Registry' ) && WP_Block_Type_Registry::get_instance()->is_registered( $name ) ) {
			unregister_block_type( $name );
		}

		return array( 'fingerprint' => self::new_epoch() );
	}

	/**
	 * IDs of published posts whose content carries this block's delimiter.
	 *
	 * @param string $name Block name.
	 * @return int[]
	 */
	public static function posts_using( string $name ): array {
		global $wpdb;

		if ( ! isset( $wpdb ) || '' === $name ) {
			return array();
		}

		$needle = '<!-- wp:' . $name;

		// phpcs:disable WordPress.DB.DirectDatabaseQuery
		$ids = $wpdb->get_col(
			$wpdb->prepare(
				"SELECT ID FROM {$wpdb->posts} WHERE post_status = 'publish' AND post_content LIKE %s ORDER BY ID ASC LIMIT 100",
				'%' . $wpdb->esc_like( $needle ) . '%'
			)
		);
		// phpcs:enable WordPress.DB.DirectDatabaseQuery

		return array_map( 'intval', is_array( $ids ) ? $ids : array() );
	}

	/*
	 * -------------------------------------------------------------------
	 * Package analysis
	 * -------------------------------------------------------------------
	 */

	/**
	 * Structural policy check.
	 *
	 * A package is a standard plugin zip: exactly one top-level directory,
	 * `agent-block-{slug}/`, holding a plugin main file with a real header and
	 * the block directory `{slug}/block.json`. Every violation is collected
	 * before returning, so one round trip tells the agent everything that is
	 * wrong with the package.
	 *
	 * @param string $archive Path to the uploaded zip.
	 * @return array|WP_Error { root, block_root, entries, metadata, name, slug, version }
	 */
	public static function analyze_package( string $archive ) {
		$reasons = array();

		$size = (int) filesize( $archive );

		if ( $size > self::MAX_BYTES ) {
			$reasons[] = sprintf( 'package is %d bytes, over the %d byte limit', $size, self::MAX_BYTES );
		}

		$entries = self::zip_entries( $archive );

		if ( is_wp_error( $entries ) ) {
			$reasons[] = $entries->get_error_message();

			return self::policy_error( $reasons );
		}

		if ( empty( $entries ) ) {
			$reasons[] = 'package contains no files';

			return self::policy_error( $reasons );
		}

		$total  = 0;
		$unsafe = array();

		foreach ( $entries as $name => $entry_size ) {
			$total += (int) $entry_size;

			if ( ! self::is_safe_entry( $name ) ) {
				$unsafe[] = $name;
			}
		}

		if ( ! empty( $unsafe ) ) {
			$reasons[] = 'unsafe zip entries (path traversal or absolute path): ' . implode( ', ', array_slice( $unsafe, 0, 10 ) );

			// A traversing archive is never inspected further.
			return self::policy_error( $reasons );
		}

		if ( $total > self::MAX_BYTES ) {
			$reasons[] = sprintf( 'package expands to %d bytes, over the %d byte limit', $total, self::MAX_BYTES );
		}

		$root = self::detect_root( array_keys( $entries ) );

		if ( null === $root || '' === $root ) {
			$reasons[] = 'zip must contain exactly one top-level plugin directory (agent-block-{slug}/)';

			return self::policy_error( $reasons );
		}

		$plugin_dir_name = rtrim( $root, '/' );

		if ( 0 !== strpos( $plugin_dir_name, self::PLUGIN_PREFIX ) ) {
			$reasons[] = sprintf( 'zip root "%s" is not an %s{slug} plugin directory', $plugin_dir_name, self::PLUGIN_PREFIX );

			return self::policy_error( $reasons );
		}

		$slug       = sanitize_key( substr( $plugin_dir_name, strlen( self::PLUGIN_PREFIX ) ) );
		$block_root = $root . $slug . '/';

		$main_entry = $root . $plugin_dir_name . '.php';

		if ( ! isset( $entries[ $main_entry ] ) ) {
			$reasons[] = sprintf( '%s (the plugin main file) is not in the package', $main_entry );
		} else {
			$main_code = self::zip_read( $archive, $main_entry );
			if ( ! is_string( $main_code ) || ! preg_match( '/^\s*\*?\s*Plugin Name\s*:/m', $main_code ) ) {
				$reasons[] = sprintf( '%s has no "Plugin Name:" header; the package must be an installable WordPress plugin', $main_entry );
			}
		}

		$manifest_entry = $block_root . 'block.json';

		if ( ! isset( $entries[ $manifest_entry ] ) ) {
			$reasons[] = sprintf( 'block.json not found at %s inside the package', $block_root );

			return self::policy_error( $reasons );
		}

		$raw = self::zip_read( $archive, $manifest_entry );

		if ( ! is_string( $raw ) ) {
			$reasons[] = 'block.json could not be read from the package';

			return self::policy_error( $reasons );
		}

		$metadata = json_decode( $raw, true );

		if ( ! is_array( $metadata ) ) {
			$reasons[] = 'block.json is not valid JSON: ' . json_last_error_msg();

			return self::policy_error( $reasons );
		}

		$namespace = self::block_namespace();
		$pattern   = '#^' . preg_quote( $namespace, '#' ) . '/[a-z0-9-]+$#';
		$name      = isset( $metadata['name'] ) && is_string( $metadata['name'] ) ? $metadata['name'] : '';

		if ( ! preg_match( $pattern, $name ) ) {
			$reasons[] = sprintf( 'block.json name "%s" must match %s/[a-z0-9-]+', $name, $namespace );
		} elseif ( $name !== $namespace . '/' . $slug ) {
			$reasons[] = sprintf( 'block.json name "%s" does not match the plugin directory "%s"', $name, $plugin_dir_name );
		}

		$render = isset( $metadata['render'] ) && is_string( $metadata['render'] ) ? $metadata['render'] : '';

		if ( '' === $render ) {
			if ( ! X_COMPANION_ALLOW_STATIC_BLOCKS ) {
				$reasons[] = 'block.json has no "render" entry; static blocks are refused unless X_COMPANION_ALLOW_STATIC_BLOCKS is defined true';
			}
		} elseif ( ! isset( $entries[ $block_root . self::normalize_file_reference( $render ) ] ) ) {
			$reasons[] = sprintf( 'block.json "render" points at %s, which is not in the package', $render );
		}

		foreach ( self::referenced_files( $metadata ) as $reference ) {
			if ( ! isset( $entries[ $block_root . $reference ] ) ) {
				$reasons[] = sprintf( 'block.json references %s, which is not in the package', $reference );
			}
		}

		if ( ! empty( $reasons ) ) {
			return self::policy_error( $reasons );
		}

		return array(
			'root'       => $root,
			'block_root' => $block_root,
			'entries'    => $entries,
			'metadata'   => $metadata,
			'name'       => $name,
			'slug'       => $slug,
			'version'    => isset( $metadata['version'] ) && is_scalar( $metadata['version'] ) ? (string) $metadata['version'] : '',
		);
	}

	/**
	 * Is this zip entry name safe to write below a directory we control?
	 *
	 * @param string $name Entry name.
	 * @return bool
	 */
	public static function is_safe_entry( string $name ): bool {
		if ( '' === $name ) {
			return false;
		}

		if ( false !== strpos( $name, "\0" ) || false !== strpos( $name, '\\' ) ) {
			return false;
		}

		if ( '/' === $name[0] ) {
			return false;
		}

		if ( preg_match( '#^[a-zA-Z]:#', $name ) ) {
			return false;
		}

		foreach ( explode( '/', $name ) as $segment ) {
			if ( '..' === $segment ) {
				return false;
			}
		}

		return true;
	}

	/**
	 * Resolve the package root inside the archive.
	 *
	 * @param string[] $names Entry names.
	 * @return string|null '' for a flat package, 'dir/' for a wrapped one, null when neither.
	 */
	public static function detect_root( array $names ): ?string {
		$top_dirs  = array();
		$top_files = array();

		foreach ( $names as $name ) {
			$name = ltrim( $name, '/' );

			if ( '' === $name ) {
				continue;
			}

			if ( false !== strpos( $name, '/' ) ) {
				$top_dirs[ strtok( $name, '/' ) ] = true;
			} else {
				$top_files[ $name ] = true;
			}
		}

		if ( ! empty( $top_files ) && empty( $top_dirs ) ) {
			return '';
		}

		if ( 1 === count( $top_dirs ) && empty( $top_files ) ) {
			return array_key_first( $top_dirs ) . '/';
		}

		// A single wrapper dir plus stray top-level files, or several dirs.
		return null;
	}

	/**
	 * All `file:` references declared in block.json, normalised.
	 *
	 * @param array $metadata Decoded block.json.
	 * @return string[] Paths relative to the block root.
	 */
	public static function referenced_files( array $metadata ): array {
		$out = array();

		foreach ( self::FILE_KEYS as $key ) {
			if ( ! isset( $metadata[ $key ] ) ) {
				continue;
			}

			foreach ( (array) $metadata[ $key ] as $value ) {
				if ( ! is_string( $value ) || 0 !== strpos( $value, 'file:' ) ) {
					continue;
				}

				$path = self::normalize_file_reference( $value );

				if ( '' !== $path && ! in_array( $path, $out, true ) ) {
					$out[] = $path;
				}
			}
		}

		return $out;
	}

	/**
	 * `file:./render.php` -> `render.php`.
	 *
	 * @param string $reference Raw value from block.json.
	 * @return string
	 */
	public static function normalize_file_reference( string $reference ): string {
		$path = preg_replace( '#^file:#', '', $reference );
		$path = preg_replace( '#^\./#', '', (string) $path );

		return ltrim( (string) $path, '/' );
	}

	/*
	 * -------------------------------------------------------------------
	 * Zip access
	 * -------------------------------------------------------------------
	 *
	 * ZipArchive is present in the Playground PHP build and in every stock
	 * PHP 8 with ext-zip. PclZip ships with WordPress itself, which keeps the
	 * fallback dependency-free.
	 */

	/**
	 * Entry name => uncompressed size, directories excluded.
	 *
	 * @param string $archive Path.
	 * @return array<string,int>|WP_Error
	 */
	public static function zip_entries( string $archive ) {
		if ( class_exists( 'ZipArchive' ) ) {
			$zip = new ZipArchive();

			if ( true !== $zip->open( $archive ) ) {
				return new WP_Error( 'zip_unreadable', 'package is not a readable zip archive' );
			}

			$entries = array();

			for ( $i = 0; $i < $zip->numFiles; $i++ ) {
				$stat = $zip->statIndex( $i );

				if ( ! is_array( $stat ) || ! isset( $stat['name'] ) ) {
					continue;
				}

				$name = (string) $stat['name'];

				if ( '' === $name || '/' === substr( $name, -1 ) ) {
					continue;
				}

				$entries[ $name ] = (int) ( $stat['size'] ?? 0 );
			}

			$zip->close();

			return $entries;
		}

		$list = self::pclzip( $archive );

		if ( is_wp_error( $list ) ) {
			return $list;
		}

		$entries = array();

		foreach ( $list as $item ) {
			if ( ! empty( $item['folder'] ) ) {
				continue;
			}

			$entries[ (string) $item['filename'] ] = (int) ( $item['size'] ?? 0 );
		}

		return $entries;
	}

	/**
	 * Read one entry's bytes.
	 *
	 * @param string $archive Path.
	 * @param string $entry   Entry name.
	 * @return string|false
	 */
	public static function zip_read( string $archive, string $entry ) {
		if ( class_exists( 'ZipArchive' ) ) {
			$zip = new ZipArchive();

			if ( true !== $zip->open( $archive ) ) {
				return false;
			}

			$contents = $zip->getFromName( $entry );
			$zip->close();

			return $contents;
		}

		require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';

		$pcl  = new PclZip( $archive );
		$list = $pcl->extract( PCLZIP_OPT_BY_NAME, $entry, PCLZIP_OPT_EXTRACT_AS_STRING );

		if ( ! is_array( $list ) || empty( $list[0]['content'] ) ) {
			return false;
		}

		return (string) $list[0]['content'];
	}

	/**
	 * PclZip listing, or an error.
	 *
	 * @param string $archive Path.
	 * @return array|WP_Error
	 */
	private static function pclzip( string $archive ) {
		require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';

		$pcl  = new PclZip( $archive );
		$list = $pcl->listContent();

		if ( ! is_array( $list ) ) {
			return new WP_Error( 'zip_unreadable', 'package is not a readable zip archive' );
		}

		return $list;
	}

	/**
	 * Write the package root's files into a staging directory.
	 *
	 * Entries are written one at a time under names we have already validated;
	 * ZipArchive::extractTo() is never handed the archive wholesale.
	 *
	 * @param string $archive  Path to the zip.
	 * @param array  $analysis analyze_package() output.
	 * @param string $staging  Destination directory.
	 * @return true|WP_Error
	 */
	private static function extract( string $archive, array $analysis, string $staging ) {
		$root    = (string) $analysis['root'];
		$entries = (array) $analysis['entries'];

		if ( ! wp_mkdir_p( $staging ) ) {
			return new WP_Error( 'install_failed', __( 'Could not create the staging directory.', 'x-companion' ), array( 'status' => 500 ) );
		}

		foreach ( array_keys( $entries ) as $entry ) {
			if ( '' !== $root && 0 !== strpos( $entry, $root ) ) {
				continue;
			}

			$relative = '' === $root ? $entry : substr( $entry, strlen( $root ) );

			if ( '' === $relative || ! self::is_safe_entry( $relative ) ) {
				continue;
			}

			$destination = $staging . '/' . $relative;
			$directory   = dirname( $destination );

			if ( ! wp_mkdir_p( $directory ) ) {
				return new WP_Error( 'install_failed', __( 'Could not create a directory inside the staging area.', 'x-companion' ), array( 'status' => 500 ) );
			}

			$contents = self::zip_read( $archive, $entry );

			if ( ! is_string( $contents ) ) {
				return new WP_Error( 'install_failed', __( 'Could not read an entry out of the package.', 'x-companion' ), array( 'status' => 500 ) );
			}

			if ( false === file_put_contents( $destination, $contents ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
				return new WP_Error( 'install_failed', __( 'Could not write an extracted file.', 'x-companion' ), array( 'status' => 500 ) );
			}
		}

		return true;
	}

	/*
	 * -------------------------------------------------------------------
	 * Small helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * 422 with the reason list the contract pins.
	 *
	 * @param string[] $reasons Reasons.
	 * @return WP_Error
	 */
	private static function policy_error( array $reasons ): WP_Error {
		return new WP_Error(
			'block_policy',
			__( 'The package does not satisfy the agent block install policy.', 'x-companion' ),
			array(
				'status'  => 422,
				'reasons' => array_values( $reasons ),
			)
		);
	}

	/**
	 * 404 for an unknown slug.
	 *
	 * @param string $slug Slug.
	 * @return WP_Error
	 */
	private static function not_found( string $slug ): WP_Error {
		return new WP_Error(
			'not_found',
			sprintf(
				/* translators: %s: block slug. */
				__( 'No installed agent block with slug "%s".', 'x-companion' ),
				$slug
			),
			array( 'status' => 404 )
		);
	}

	/**
	 * Re-read a block directory into the live registry.
	 *
	 * @param string $name Block name currently registered, if any.
	 * @param string $dir  Directory to register.
	 * @return void
	 */
	private static function reregister( string $name, string $dir ): void {
		if ( '' !== $name && class_exists( 'WP_Block_Type_Registry' ) && WP_Block_Type_Registry::get_instance()->is_registered( $name ) ) {
			unregister_block_type( $name );
		}

		self::register_one( $dir );

		/*
		 * Supports-derived attributes (align, className, style, anchor, the
		 * colour pair, ...) are injected into every registered block type by
		 * WP_Block_Supports on `init` priority 22. A block registered *after*
		 * that -- which is exactly what an install or a rollback does -- would
		 * otherwise carry a smaller attribute set than the same block carries on
		 * the next request, and the fingerprint returned to the agent would not
		 * match the one GET /fingerprint serves a moment later. Re-running the
		 * pass is idempotent.
		 */
		if ( class_exists( 'WP_Block_Supports' ) ) {
			WP_Block_Supports::init();
		}
	}

	/**
	 * Bust the manifest cache and return the new epoch.
	 *
	 * @return string
	 */
	private static function new_epoch(): string {
		X_Companion_Manifest::bust_cache();

		return X_Companion_Manifest::fingerprint( true );
	}

	/**
	 * The `name` declared by a block directory's block.json.
	 *
	 * @param string $dir Directory.
	 * @return string Empty string when unreadable.
	 */
	private static function registered_name( string $dir ): string {
		return self::manifest_value( $dir, 'name' );
	}

	/**
	 * One scalar value out of a block directory's block.json.
	 *
	 * @param string $dir Directory.
	 * @param string $key Key.
	 * @return string
	 */
	private static function manifest_value( string $dir, string $key ): string {
		$manifest = $dir . '/block.json';

		if ( '' === $dir || ! file_exists( $manifest ) ) {
			return '';
		}

		$metadata = json_decode( (string) file_get_contents( $manifest ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents

		return ( is_array( $metadata ) && isset( $metadata[ $key ] ) && is_scalar( $metadata[ $key ] ) ) ? (string) $metadata[ $key ] : '';
	}

	/**
	 * Is this a path the library is allowed to delete?
	 *
	 * Only agent-managed plugin directories (agent-block-*, agent-schema-*,
	 * .agent-staging-*) under wp-content/plugins or the upgrade backup root.
	 * Everything else — including every human-installed plugin — is refused.
	 *
	 * @param string $dir Directory.
	 * @return bool
	 */
	private static function is_managed_path( string $dir ): bool {
		$dir   = wp_normalize_path( $dir );
		$roots = array(
			wp_normalize_path( rtrim( (string) WP_PLUGIN_DIR, '/\\' ) ),
			wp_normalize_path( self::backup_root() ),
		);

		foreach ( $roots as $root ) {
			if ( 0 !== strpos( $dir, $root . '/' ) ) {
				continue;
			}

			$top = strtok( substr( $dir, strlen( $root ) + 1 ), '/' );

			if ( preg_match( '/^(agent-block-|agent-schema-|\.agent-staging-)/', (string) $top ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Recursive delete, refusing to touch anything the library does not manage.
	 *
	 * @param string $dir Directory.
	 * @return bool
	 */
	public static function rmdir_recursive( string $dir ): bool {
		clearstatcache( true, $dir );

		if ( '' === $dir || ! is_dir( $dir ) ) {
			return true;
		}

		if ( ! self::is_managed_path( $dir ) ) {
			return false;
		}

		$filesystem = self::filesystem();

		if ( null === $filesystem ) {
			return false;
		}

		/*
		 * Twice, and judged by whether the directory is gone rather than by the
		 * return value: WP_Filesystem_Direct::delete() walks a directory listing,
		 * and on a mounted filesystem whose stat cache lags, that listing can come
		 * back short — reporting failure for a directory it has in fact emptied,
		 * or leaving one straggler behind.
		 */
		for ( $attempt = 0; $attempt < 2; $attempt++ ) {
			$filesystem->delete( $dir, true );
			clearstatcache( true, $dir );

			if ( ! file_exists( $dir ) ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Log without depending on WP_DEBUG_LOG.
	 *
	 * @param string $message Message.
	 * @return void
	 */
	private static function log( string $message ): void {
		if ( function_exists( 'error_log' ) ) {
			error_log( $message ); // phpcs:ignore WordPress.PHP.DevelopmentFunctions.error_log_error_log
		}
	}
}
