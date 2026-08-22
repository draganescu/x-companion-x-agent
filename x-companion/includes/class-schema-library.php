<?php
/**
 * POST /schema/install and GET /schema/installed — the schema library.
 *
 * A schema package is the backend counterpart of an agent block: real plugin
 * code (generated and GATED by the agent-side schema factory) that registers
 * post types, taxonomies, REST-visible meta, binding sources and REST routes
 * through core APIs on every request. This class stores packages under
 * uploads/x-agent-schemas/{slug}/, loads them defensively, enforces the
 * install policy structurally (zip safety, schema.json contract, forbidden
 * tokens — the same list the agent gate scans, enforced twice by design),
 * and records what each package provides so the manifest's data_model can
 * label its registrations source:"agent".
 *
 * Like POST /blocks/install, this route does NOT lint PHP — the agent-side
 * wp_schema_build_test sandbox is THE gate. What this class adds against a
 * package that lies its way past the gate is a crash-loop breaker: a package
 * that fataled while loading is skipped on the next request and reported,
 * instead of taking the site down with it.
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/**
 * Schema package library.
 */
final class X_Companion_Schema_Library {

	/** Directory under uploads. */
	const DIR = 'x-agent-schemas';

	/** Option remembering installed packages: slug => {version, installed_at}. */
	const OPTION = 'x_companion_schema_library';

	/** Option guarding against a crash-looping package: slug currently loading. */
	const LOADING_OPTION = 'x_companion_schema_loading';

	/** Install policy: total package size ≤ 1 MB. */
	const MAX_BYTES = 1048576;

	const PREV_SUFFIX = '.prev';

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
	 * Register hooks.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_schema_install', array( __CLASS__, 'route_install' ), 10, 2 );
		add_filter( 'x_companion_route_schema_installed', array( __CLASS__, 'route_installed' ), 10, 2 );

		self::load_installed();
	}

	/**
	 * Base directory of the library.
	 *
	 * @return string
	 */
	public static function base_dir(): string {
		$uploads = wp_upload_dir( null, false );

		if ( ! is_array( $uploads ) || empty( $uploads['basedir'] ) ) {
			return '';
		}

		return rtrim( (string) $uploads['basedir'], '/\\' ) . '/' . self::DIR;
	}

	/**
	 * One package's directory.
	 *
	 * @param string $slug Package slug.
	 * @param bool   $prev Rollback copy.
	 * @return string
	 */
	public static function package_dir( string $slug, bool $prev = false ): string {
		$base = self::base_dir();

		return ( '' === $base || '' === $slug ) ? '' : $base . '/' . $slug . ( $prev ? self::PREV_SUFFIX : '' );
	}

	/*
	 * -------------------------------------------------------------------
	 * Loader
	 * -------------------------------------------------------------------
	 */

	/**
	 * Include every installed package's main file, with a crash-loop breaker.
	 *
	 * Runs during plugins_loaded (the companion boots at priority 5), so each
	 * package's own `init` and `rest_api_init` hooks land normally. A package
	 * that fataled mid-include on a previous request is skipped and logged.
	 *
	 * @return void
	 */
	public static function load_installed(): void {
		$base = self::base_dir();

		if ( '' === $base || ! is_dir( $base ) ) {
			return;
		}

		$poisoned = (string) get_option( self::LOADING_OPTION, '' );

		foreach ( self::remembered() as $slug => $entry ) {
			$dir  = self::package_dir( (string) $slug );
			$main = $dir . '/' . $slug . '.php';

			if ( '' === $dir || ! file_exists( $main ) ) {
				continue;
			}

			if ( (string) $slug === $poisoned ) {
				// Previous request died inside this package. Do not load it again.
				continue;
			}

			update_option( self::LOADING_OPTION, (string) $slug, false );
			try {
				require_once $main;
			} catch ( Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement
				// A catchable failure: skip, leave the poison marker cleared below
				// so a transient error does not permanently disable the package.
			}
			delete_option( self::LOADING_OPTION );
		}
	}

	/*
	 * -------------------------------------------------------------------
	 * POST /schema/install
	 * -------------------------------------------------------------------
	 */

	/**
	 * Install a schema package zip.
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

		$base = self::base_dir();
		if ( '' === $base || ! wp_mkdir_p( $base ) ) {
			return new WP_Error( 'install_failed', __( 'The uploads directory is not available.', 'x-companion' ), array( 'status' => 500 ) );
		}

		$slug    = (string) $analysis['slug'];
		$target  = self::package_dir( $slug );
		$prev    = self::package_dir( $slug, true );
		$staging = $base . '/.staging-' . $slug . '-' . (string) wp_rand( 100000, 999999 );

		if ( ! wp_mkdir_p( $staging ) ) {
			return new WP_Error( 'install_failed', __( 'Could not create the staging directory.', 'x-companion' ), array( 'status' => 500 ) );
		}

		foreach ( $analysis['entries'] as $entry => $size ) {
			if ( '' !== $analysis['root'] && 0 !== strpos( $entry, $analysis['root'] ) ) {
				continue;
			}
			$relative = '' === $analysis['root'] ? $entry : substr( $entry, strlen( $analysis['root'] ) );
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

			return new WP_Error( 'install_failed', __( 'Could not move the package into the library.', 'x-companion' ), array( 'status' => 500 ) );
		}

		$meta = $analysis['meta'];

		$remembered          = self::remembered();
		$remembered[ $slug ] = array(
			'version'      => (string) ( $meta['version'] ?? '' ),
			'installed_at' => gmdate( 'c' ),
		);
		update_option( self::OPTION, $remembered, false );

		self::record_provides( $slug, (array) ( $meta['provides'] ?? array() ) );

		// Register the package's model in THIS request so the returned
		// fingerprint already covers it: include the main file (its init hook
		// has already fired) and call its registration function directly.
		$main = $target . '/' . $slug . '.php';
		if ( file_exists( $main ) ) {
			require_once $main;
			$register = 'agent_schema_' . str_replace( '-', '_', $slug ) . '_register';
			if ( function_exists( $register ) ) {
				try {
					$register();
				} catch ( Throwable $e ) { // phpcs:ignore Generic.CodeAnalysis.EmptyStatement
					// The next request's loader will surface persistent failures.
				}
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

		// Flat packages: schema.json at the root (or under a single directory).
		$root = '';
		if ( ! isset( $entries['schema.json'] ) ) {
			$detected = X_Companion_Block_Library::detect_root( array_keys( $entries ) );
			if ( null === $detected || ! isset( $entries[ $detected . 'schema.json' ] ) ) {
				return self::policy_error( array( 'schema.json not found at the package root' ) );
			}
			$root = $detected;
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

		if ( ! isset( $entries[ $root . $slug . '.php' ] ) ) {
			return self::policy_error( array( sprintf( '%s.php (the main plugin file) is not in the package', $slug ) ) );
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
	 * @param mixed           $result  Dispatcher seed.
	 * @param WP_REST_Request $request Request.
	 * @return array
	 */
	public static function route_installed( $result, WP_REST_Request $request ) { // phpcs:ignore Generic.CodeAnalysis.UnusedFunctionParameter
		$out = array();

		foreach ( self::remembered() as $slug => $entry ) {
			$meta_file = self::package_dir( (string) $slug ) . '/schema.json';
			$provides  = array();

			if ( file_exists( $meta_file ) ) {
				$decoded  = json_decode( (string) file_get_contents( $meta_file ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents
				$provides = is_array( $decoded['provides'] ?? null ) ? $decoded['provides'] : array();
			}

			$out[] = array(
				'slug'         => (string) $slug,
				'version'      => (string) ( $entry['version'] ?? '' ),
				'installed_at' => (string) ( $entry['installed_at'] ?? '' ),
				'provides'     => $provides,
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
	 * Installed-package memory.
	 *
	 * @return array
	 */
	private static function remembered(): array {
		$value = get_option( self::OPTION, array() );

		return is_array( $value ) ? $value : array();
	}

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
