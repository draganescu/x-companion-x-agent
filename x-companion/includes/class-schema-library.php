<?php
/**
 * POST /schema/install and GET /schema/installed — the schema library.
 *
 * A schema package is the backend counterpart of an agent block: **a standard
 * WordPress plugin** (generated and GATED by the agent-side schema factory)
 * that registers post types, taxonomies, REST-visible meta, binding sources
 * and REST routes through core APIs on every request. Install unpacks the
 * package into `wp-content/plugins/agent-schema-{slug}/` and activates it
 * through `activate_plugin()` — after which WordPress itself loads it like
 * any other plugin. It appears in plugins.php, deactivates there, and its
 * own `uninstall.php` runs when it is deleted there. There is no sideband
 * loader and no PHP under uploads, by design; a package that fatals is
 * paused by core's own fatal-error recovery, like any broken plugin.
 *
 * This class enforces the install policy structurally (zip safety, plugin
 * layout, schema.json contract, forbidden tokens — the same list the agent
 * gate scans, enforced twice by design) and records what each package
 * provides so the manifest's data_model can label its registrations
 * source:"agent".
 *
 * Like POST /blocks/install, this route does NOT lint PHP — the agent-side
 * wp_schema_build_test sandbox is THE gate.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Schema package library.
 */
final class X_Companion_Schema_Library {

	/** Plugin directory prefix for installed schema packages. */
	const PLUGIN_PREFIX = X_Companion_Block_Library::SCHEMA_PLUGIN_PREFIX;

	/** Install policy: total package size ≤ 1 MB. */
	const MAX_BYTES = 1048576;

	/**
	 * Forbidden tokens — the same policy the agent gate scans. Enforced twice
	 * by design: a package that reaches this route without the gate is
	 * exactly the package this second scan exists for.
	 *
	 * @var array<string,string> regex => human reason.
	 */
	const FORBIDDEN = array(
		'/\$wpdb\b/'                                              => 'direct $wpdb use',
		'/\bmysqli?_/'                                            => 'direct SQL driver use',
		'/\beval\s*\(/'                                           => 'eval()',
		'/\b(?:exec|shell_exec|passthru|proc_open|popen|system)\s*\(/' => 'process execution',
	);

	/**
	 * Register hooks. No loader: WordPress loads installed packages itself,
	 * because they are active plugins.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_schema_install', array( __CLASS__, 'route_install' ), 10, 2 );
		add_filter( 'x_companion_route_schema_installed', array( __CLASS__, 'route_installed' ), 10, 2 );
	}

	/**
	 * The plugin directory name for a schema slug.
	 *
	 * @param string $slug Package slug.
	 * @return string
	 */
	public static function plugin_dir_name( string $slug ): string {
		return self::PLUGIN_PREFIX . $slug;
	}

	/**
	 * One package's plugin directory.
	 *
	 * @param string $slug Package slug.
	 * @param bool   $prev Rollback copy (under core's upgrade backup root).
	 * @return string
	 */
	public static function plugin_dir( string $slug, bool $prev = false ): string {
		if ( '' === $slug ) {
			return '';
		}

		$root = $prev ? X_Companion_Block_Library::backup_root() : rtrim( (string) WP_PLUGIN_DIR, '/\\' );

		return $root . '/' . self::plugin_dir_name( $slug );
	}

	/**
	 * The plugin basename WordPress activates: agent-schema-{slug}/{slug}.php.
	 *
	 * @param string $slug Package slug.
	 * @return string
	 */
	public static function plugin_basename_for( string $slug ): string {
		return self::plugin_dir_name( $slug ) . '/' . $slug . '.php';
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /schema/install
	 * -------------------------------------------------------------------
	 */

	/**
	 * Install a schema package zip as a standard, activated plugin.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array|WP_Error
	 */
	public static function route_install( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$files   = (array) $request->get_file_params();
		$package = isset( $files['package'] ) && is_array( $files['package'] ) ? $files['package'] : null;

		if ( null === $package || empty( $package['tmp_name'] ) || ! empty( $package['error'] ) ) {
			return new WP_Error(
				'rest_invalid_param',
				__( 'Send the package as multipart/form-data in a field named "package".', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		$archive  = (string) $package['tmp_name'];
		$analysis = self::analyze_package( $archive );

		if ( is_wp_error( $analysis ) ) {
			return $analysis;
		}

		$slug    = (string) $analysis['slug'];
		$root    = (string) $analysis['root'];
		$target  = self::plugin_dir( $slug );
		$prev    = self::plugin_dir( $slug, true );
		$staging = rtrim( (string) WP_PLUGIN_DIR, '/\\' ) . '/.agent-staging-' . $slug . '-' . (string) wp_rand( 100000, 999999 );

		if ( ! wp_mkdir_p( $staging ) ) {
			return new WP_Error( 'install_failed', __( 'Could not create the staging directory.', 'x-companion' ), array( 'status' => 500 ) );
		}

		foreach ( $analysis['entries'] as $entry => $size ) {
			if ( '' !== $root && 0 !== strpos( $entry, $root ) ) {
				continue;
			}
			$relative = '' === $root ? $entry : substr( $entry, strlen( $root ) );
			if ( '' === $relative || '/' === substr( $relative, -1 ) ) {
				continue;
			}
			$data = X_Companion_Block_Library::zip_read( $archive, $entry );
			if ( ! is_string( $data ) ) {
				X_Companion_Block_Library::rmdir_recursive( $staging );

				return new WP_Error( 'install_failed', sprintf( 'Could not read %s from the package.', $entry ), array( 'status' => 500 ) );
			}
			// Packages are flat by construction.
			file_put_contents( $staging . '/' . basename( $relative ), $data ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
		}

		$replaced = false;
		clearstatcache( true );

		if ( is_dir( $target ) ) {
			if ( ! wp_mkdir_p( X_Companion_Block_Library::backup_root() ) ) {
				X_Companion_Block_Library::rmdir_recursive( $staging );

				return new WP_Error( 'install_failed', __( 'Could not create the rollback backup directory.', 'x-companion' ), array( 'status' => 500 ) );
			}
			X_Companion_Block_Library::rmdir_recursive( $prev );
			if ( ! @rename( $target, $prev ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
				X_Companion_Block_Library::rmdir_recursive( $staging );

				return new WP_Error( 'install_failed', __( 'Could not move the existing package aside.', 'x-companion' ), array( 'status' => 500 ) );
			}
			$replaced = true;
		}

		if ( ! @rename( $staging, $target ) ) { // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			X_Companion_Block_Library::rmdir_recursive( $staging );
			if ( $replaced && is_dir( $prev ) ) {
				@rename( $prev, $target ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
			}

			return new WP_Error( 'install_failed', __( 'Could not move the package into wp-content/plugins.', 'x-companion' ), array( 'status' => 500 ) );
		}

		// Activate through core — the canonical mechanism. From the next request
		// on, WordPress loads the package like any other active plugin.
		X_Companion_Block_Library::plugin_api();
		$basename = self::plugin_basename_for( $slug );

		if ( ! is_plugin_active( $basename ) ) {
			$activated = activate_plugin( $basename );

			if ( is_wp_error( $activated ) ) {
				X_Companion_Block_Library::rmdir_recursive( $target );
				if ( $replaced && is_dir( $prev ) ) {
					@rename( $prev, $target ); // phpcs:ignore WordPress.PHP.NoSilencedErrors.Discouraged
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

		$meta = $analysis['meta'];

		self::record_provides( $slug, (array) ( $meta['provides'] ?? array() ) );

		// Register the package's model in THIS request so the returned
		// fingerprint already covers it: activate_plugin() included the main
		// file (its init hook has already fired), so call its registration
		// function directly.
		$register = 'agent_schema_' . str_replace( '-', '_', $slug ) . '_register';
		if ( function_exists( $register ) ) {
			try {
				$register();
			} catch ( Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement
				// A persistent failure surfaces on the next request, where core's
				// fatal-error recovery pauses the plugin like any other.
			}
		}

		X_Companion_Manifest::bust_cache();

		return array(
			'installed'         => array(
				'slug'    => $slug,
				'version' => (string) ( $meta['version'] ?? '' ),
			),
			'fingerprint'       => X_Companion_Manifest::fingerprint( true ),
			'replaced_previous' => $replaced,
		);
	}

	/**
	 * Structural + policy analysis of an uploaded package.
	 *
	 * A package is a standard plugin zip: one top-level directory,
	 * `agent-schema-{slug}/`, holding `{slug}.php` (the plugin main file with
	 * a real header), `schema.json`, and its other PHP files.
	 *
	 * @param string $archive Absolute path of the uploaded zip.
	 * @return array|WP_Error
	 */
	public static function analyze_package( string $archive ) {
		$reasons = array();

		$size = (int) filesize( $archive );
		if ( $size > self::MAX_BYTES ) {
			$reasons[] = sprintf( 'package is %d bytes, over the %d byte limit', $size, self::MAX_BYTES );
		}

		$entries = X_Companion_Block_Library::zip_entries( $archive );
		if ( is_wp_error( $entries ) ) {
			return self::policy_error( array( $entries->get_error_message() ) );
		}
		if ( empty( $entries ) ) {
			return self::policy_error( array( 'package contains no files' ) );
		}

		foreach ( $entries as $name => $entry_size ) {
			if ( ! X_Companion_Block_Library::is_safe_entry( (string) $name ) ) {
				return self::policy_error( array( 'unsafe zip entry: ' . $name ) );
			}
		}

		$root = X_Companion_Block_Library::detect_root( array_keys( $entries ) );

		if ( null === $root || '' === $root ) {
			return self::policy_error( array( 'zip must contain exactly one top-level plugin directory (agent-schema-{slug}/)' ) );
		}

		$plugin_dir_name = rtrim( $root, '/' );

		if ( 0 !== strpos( $plugin_dir_name, self::PLUGIN_PREFIX ) ) {
			return self::policy_error( array( sprintf( 'zip root "%s" is not an %s{slug} plugin directory', $plugin_dir_name, self::PLUGIN_PREFIX ) ) );
		}

		if ( ! isset( $entries[ $root . 'schema.json' ] ) ) {
			return self::policy_error( array( 'schema.json not found at the package root' ) );
		}

		$raw  = X_Companion_Block_Library::zip_read( $archive, $root . 'schema.json' );
		$meta = is_string( $raw ) ? json_decode( $raw, true ) : null;

		if ( ! is_array( $meta ) || '' === (string) ( $meta['slug'] ?? '' ) ) {
			return self::policy_error( array( 'schema.json is missing or has no slug' ) );
		}

		$slug = sanitize_key( (string) $meta['slug'] );
		if ( '' === $slug || ! preg_match( '/^[a-z0-9-]+$/', $slug ) ) {
			return self::policy_error( array( sprintf( 'schema.json slug "%s" is invalid', (string) $meta['slug'] ) ) );
		}

		if ( $plugin_dir_name !== self::plugin_dir_name( $slug ) ) {
			return self::policy_error( array( sprintf( 'zip root "%s" does not match schema.json slug "%s" (expected %s)', $plugin_dir_name, $slug, self::plugin_dir_name( $slug ) ) ) );
		}

		$main_entry = $root . $slug . '.php';

		if ( ! isset( $entries[ $main_entry ] ) ) {
			return self::policy_error( array( sprintf( '%s.php (the main plugin file) is not in the package', $slug ) ) );
		}

		$main_code = X_Companion_Block_Library::zip_read( $archive, $main_entry );
		if ( ! is_string( $main_code ) || ! preg_match( '/^\s*\*?\s*Plugin Name\s*:/m', $main_code ) ) {
			$reasons[] = sprintf( '%s.php has no "Plugin Name:" header; the package must be an installable WordPress plugin', $slug );
		}

		// Policy scan — the same forbidden list the agent gate uses.
		foreach ( array_keys( $entries ) as $entry ) {
			if ( '.php' !== substr( (string) $entry, -4 ) ) {
				continue;
			}
			$code = X_Companion_Block_Library::zip_read( $archive, (string) $entry );
			if ( ! is_string( $code ) ) {
				continue;
			}
			foreach ( self::FORBIDDEN as $pattern => $what ) {
				if ( preg_match( $pattern, $code ) ) {
					$reasons[] = sprintf( '%s: %s', basename( (string) $entry ), $what );
				}
			}
		}

		if ( ! empty( $reasons ) ) {
			return self::policy_error( $reasons );
		}

		return array(
			'root'    => $root,
			'entries' => $entries,
			'meta'    => $meta,
			'slug'    => $slug,
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * GET /schema/installed
	 * -------------------------------------------------------------------
	 */

	/**
	 * List installed schema packages with what each provides.
	 *
	 * No private registry: the plugins directory plus WordPress's own plugin
	 * state is the source of truth.
	 *
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public static function route_installed( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		X_Companion_Block_Library::plugin_api();

		$out  = array();
		$dirs = glob( rtrim( (string) WP_PLUGIN_DIR, '/\\' ) . '/' . self::PLUGIN_PREFIX . '*', GLOB_ONLYDIR );

		foreach ( is_array( $dirs ) ? $dirs : array() as $dir ) {
			$slug      = substr( basename( $dir ), strlen( self::PLUGIN_PREFIX ) );
			$meta_file = $dir . '/schema.json';

			if ( '' === $slug || ! file_exists( $meta_file ) ) {
				continue;
			}

			$decoded = json_decode( (string) file_get_contents( $meta_file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
			$decoded = is_array( $decoded ) ? $decoded : array();

			$main         = $dir . '/' . $slug . '.php';
			$mtime        = file_exists( $main ) ? filemtime( $main ) : filemtime( $meta_file );
			$installed_at = $mtime ? gmdate( 'c', (int) $mtime ) : '';

			$out[] = array(
				'slug'         => $slug,
				'version'      => (string) ( $decoded['version'] ?? '' ),
				'installed_at' => $installed_at,
				'active'       => is_plugin_active( self::plugin_basename_for( $slug ) ),
				'provides'     => is_array( $decoded['provides'] ?? null ) ? $decoded['provides'] : array(),
			);
		}

		usort(
			$out,
			static function ( $a, $b ) {
				return strcmp( $a['slug'], $b['slug'] );
			}
		);

		return array( 'packages' => $out );
	}

	/*
	 * -------------------------------------------------------------------
	 * Helpers
	 * -------------------------------------------------------------------
	 */

	/**
	 * Record what a package provides, for the manifest's source labels.
	 *
	 * @param string $slug     Package slug.
	 * @param array  $provides schema.json provides.
	 * @return void
	 */
	private static function record_provides( string $slug, array $provides ): void {
		$map = get_option( X_Companion_Platform::PROVIDES_OPTION, array() );
		$map = is_array( $map ) ? $map : array();

		foreach ( (array) ( $provides['post_types'] ?? array() ) as $type ) {
			$map['post_types'][ (string) $type ] = $slug;
		}
		foreach ( (array) ( $provides['taxonomies'] ?? array() ) as $tax ) {
			$map['taxonomies'][ (string) $tax ] = $slug;
		}

		update_option( X_Companion_Platform::PROVIDES_OPTION, $map, false );
	}

	/**
	 * 422 schema_policy, mirroring the block install policy error.
	 *
	 * @param array $reasons Reasons.
	 * @return WP_Error
	 */
	private static function policy_error( array $reasons ): WP_Error {
		return new WP_Error(
			'schema_policy',
			__( 'The package violates the schema install policy.', 'x-companion' ),
			array(
				'status'  => 422,
				'reasons' => array_values( $reasons ),
			)
		);
	}
}
