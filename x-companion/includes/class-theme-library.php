<?php
/**
 * Theme install: POST /themes/install.
 *
 * THE ONE PLEDGE-BREAKING SURFACE. The x-pipeline spec promised the companion
 * would gain no new routes; the theme-factory spec (specs/theme-factory.spec.json)
 * retires that pledge for exactly this endpoint, recorded as such, because core
 * REST cannot upload themes. Extend tier, posture-gated ahead of capability,
 * like every other mutating route.
 *
 * The contract mirrors POST /blocks/install: a multipart zip in a field named
 * "package", structural validation before any byte lands (one top-level dir
 * named after the slug, style.css with a Theme Name header, theme.json parses,
 * templates/index.html present), staged unzip into the THEME root, activation
 * via switch_theme() — core's canonical mechanism — and the NEW fingerprint in
 * the response, computed after activation so the epoch the caller adopts is the
 * bespoke world's. There is no theme mutation lane: a theme installs whole and
 * activates, or it does not ship.
 *
 * The installed theme is DELIVERABLE: named, versioned, deletable from
 * wp-admin like any theme. Nothing here ever removes it (deliverable-purity
 * governs the companion, never the artifact). The deletion fence below exists
 * only for this library's own staging/backup debris.
 *
 * @package XCompanion
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * POST /themes/install handler.
 */
final class X_Companion_Theme_Library {

	/**
	 * Upload cap, matching the block library.
	 */
	const MAX_BYTES = 5242880;

	/**
	 * Theme slugs this route will accept.
	 */
	const SLUG_PATTERN = '/^[a-z][a-z0-9-]{1,48}$/';

	/**
	 * Register hooks.
	 *
	 * @return void
	 */
	public static function init(): void {
		add_filter( 'x_companion_route_themes_install', array( __CLASS__, 'route_install' ), 10, 2 );
	}

	/**
	 * Install a theme package: validate, unpack into the theme root, activate.
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
				__( 'Send the theme as multipart/form-data in a field named "package".', 'x-companion' ),
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
				__( 'The uploaded theme package could not be read.', 'x-companion' ),
				array( 'status' => 400 )
			);
		}

		$analysis = self::analyze_theme_package( $archive );

		if ( is_wp_error( $analysis ) ) {
			return $analysis;
		}

		$slug    = (string) $analysis['slug'];
		$root    = rtrim( (string) get_theme_root(), '/\\' );
		$target  = $root . '/' . $slug;
		$prev    = self::backup_root() . '/' . $slug;
		$staging = $root . '/.agent-staging-' . $slug . '-' . (string) wp_rand( 100000, 999999 );

		$extracted = self::extract( $archive, $analysis, $staging );

		if ( is_wp_error( $extracted ) ) {
			self::rmdir_recursive( $staging );

			return $extracted;
		}

		$replaced       = false;
		$previous_theme = (string) get_stylesheet();

		clearstatcache( true );

		if ( is_dir( $target ) ) {
			if ( ! wp_mkdir_p( self::backup_root() ) || ! self::rmdir_recursive( $prev ) ) {
				self::rmdir_recursive( $staging );

				return self::filesystem_error(
					'install_failed',
					__( 'Could not clear the previous theme rollback copy.', 'x-companion' )
				);
			}

			if ( ! self::move( $target, $prev ) ) {
				self::rmdir_recursive( $staging );

				return self::filesystem_error(
					'install_failed',
					__( 'Could not move the existing theme aside for rollback.', 'x-companion' )
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
				__( 'Could not move the extracted theme into the theme root.', 'x-companion' )
			);
		}

		// WP_Theme caches by (root, slug): a same-slug replace would otherwise
		// serve the PREVIOUS copy's headers (observed live: Version 1.0.0 after
		// 1.0.1 landed). Flush before core reads anything about the new bytes.
		wp_clean_themes_cache( true );

		// Activate through core. switch_theme() has no error channel; the state
		// of the world afterwards is the verdict, and a miss rolls back whole —
		// a theme installs and activates, or it does not ship.
		switch_theme( $slug );

		if ( (string) get_stylesheet() !== $slug ) {
			if ( '' !== $previous_theme && $previous_theme !== $slug ) {
				switch_theme( $previous_theme );
			}

			self::remove_installed( $slug );

			if ( $replaced && is_dir( $prev ) ) {
				self::move( $prev, $target );
			}

			return new WP_Error(
				'install_failed',
				__( 'WordPress did not activate the theme.', 'x-companion' ),
				array( 'status' => 500 )
			);
		}

		$theme = wp_get_theme( $slug );

		// The theme-JSON resolver memoizes per request (theme data, the user
		// global-styles post — which is PER THEME). Reset it so the recompute
		// below reads the NEW theme's world, not the previous one's.
		if ( class_exists( 'WP_Theme_JSON_Resolver' ) ) {
			WP_Theme_JSON_Resolver::clean_cached_data();
		}

		// The fingerprint below is BEST EFFORT, recorded as such (measured
		// live): a theme's init-time contributions — block style variations
		// from theme.json partials and friends — only register on the NEXT
		// request, and no cache bust can re-run init. The authoritative epoch
		// is the manifest refresh the agent performs right after install
		// (wp_theme_install returns THAT one); what this request guarantees is
		// that the epoch has moved and the transient is gone.
		X_Companion_Manifest::bust_cache();

		return array(
			'installed'         => array(
				'slug'    => $slug,
				'name'    => (string) $theme->get( 'Name' ),
				'version' => (string) $theme->get( 'Version' ),
			),
			'fingerprint'       => X_Companion_Manifest::fingerprint( true ),
			'replaced_previous' => $replaced,
			'previous_theme'    => $previous_theme,
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Package analysis
	 * -------------------------------------------------------------------
	 */

	/**
	 * Structural policy, applied before any byte lands outside the temp upload.
	 *
	 * @param string $archive Uploaded zip path.
	 * @return array|WP_Error { slug, root, entries } or a 422 with reasons[].
	 */
	public static function analyze_theme_package( string $archive ) {
		$reasons = array();

		$size = (int) filesize( $archive );

		if ( $size > self::MAX_BYTES ) {
			$reasons[] = sprintf( 'package is %d bytes, over the %d byte limit', $size, self::MAX_BYTES );
		}

		$entries = X_Companion_Block_Library::zip_entries( $archive );

		if ( is_wp_error( $entries ) ) {
			return self::policy_error( array( $entries->get_error_message() ) );
		}

		$names = array_keys( $entries );

		foreach ( $names as $name ) {
			if ( ! X_Companion_Block_Library::is_safe_entry( $name ) ) {
				$reasons[] = sprintf( 'unsafe entry path: %s', $name );
			}
		}

		$total = 0;

		foreach ( $entries as $bytes ) {
			$total += (int) $bytes;
		}

		if ( $total > self::MAX_BYTES ) {
			$reasons[] = sprintf( 'package expands to %d bytes, over the %d byte limit', $total, self::MAX_BYTES );
		}

		$root = X_Companion_Block_Library::detect_root( $names );

		if ( null === $root || '' === $root ) {
			$reasons[] = 'a theme package must contain exactly one top-level directory named after its slug';

			return self::policy_error( $reasons );
		}

		$slug = rtrim( $root, '/' );

		if ( ! preg_match( self::SLUG_PATTERN, $slug ) ) {
			$reasons[] = sprintf( 'top-level directory "%s" is not a valid theme slug', $slug );
		}

		$has = static function ( $relative ) use ( $entries, $root ) {
			return isset( $entries[ $root . $relative ] );
		};

		if ( ! $has( 'style.css' ) ) {
			$reasons[] = 'style.css missing';
		} else {
			$css = X_Companion_Block_Library::zip_read( $archive, $root . 'style.css' );

			if ( ! is_string( $css ) || ! preg_match( '/^\s*\*?\s*Theme Name\s*:\s*\S/mi', $css ) ) {
				$reasons[] = 'style.css carries no Theme Name header';
			}
		}

		if ( ! $has( 'templates/index.html' ) ) {
			$reasons[] = 'templates/index.html missing — not an installable block theme';
		}

		if ( $has( 'theme.json' ) ) {
			$raw     = X_Companion_Block_Library::zip_read( $archive, $root . 'theme.json' );
			$decoded = is_string( $raw ) ? json_decode( $raw, true ) : null;

			if ( ! is_array( $decoded ) ) {
				$reasons[] = 'theme.json does not parse';
			}
		}

		foreach ( $entries as $name => $bytes ) {
			$relative = substr( $name, strlen( $root ) );

			if ( 0 === (int) $bytes && ( 0 === strpos( $relative, 'templates/' ) || 0 === strpos( $relative, 'parts/' ) ) ) {
				$reasons[] = sprintf( 'empty template file: %s', $relative );
			}
		}

		if ( ! empty( $reasons ) ) {
			return self::policy_error( $reasons );
		}

		return array(
			'slug'    => $slug,
			'root'    => $root,
			'entries' => $entries,
		);
	}

	/*
	 * -------------------------------------------------------------------
	 * Filesystem (theme-rooted mirrors of the block library's movers; that
	 * library's deletion fence is plugin-rooted by design and must not widen)
	 * -------------------------------------------------------------------
	 */

	/**
	 * Where theme rollback copies live.
	 *
	 * @return string
	 */
	public static function backup_root(): string {
		return rtrim( (string) WP_CONTENT_DIR, '/\\' ) . '/upgrade-temp-backup/themes';
	}

	/**
	 * Deletion fence: only this library's own staging debris and rollback
	 * copies under the theme root / backup root. NEVER an installed theme by
	 * bare slug — the artifact is deliverable and wp-admin owns its lifecycle;
	 * the installed-theme paths this class deletes during rollback are reached
	 * through the same staging prefix check after a failed move.
	 *
	 * @param string $dir Directory.
	 * @return bool
	 */
	public static function is_managed_theme_path( string $dir ): bool {
		$dir   = wp_normalize_path( $dir );
		$roots = array(
			wp_normalize_path( rtrim( (string) get_theme_root(), '/\\' ) ),
			wp_normalize_path( self::backup_root() ),
		);

		foreach ( $roots as $i => $root ) {
			if ( 0 !== strpos( $dir, $root . '/' ) ) {
				continue;
			}

			$top = (string) strtok( substr( $dir, strlen( $root ) + 1 ), '/' );

			// Backup root: any slug this library parked there. Theme root:
			// staging debris always; an installed slug only while THIS request
			// is rolling back its own failed install (tracked below).
			if ( 1 === $i ) {
				return true;
			}

			if ( 0 === strpos( $top, '.agent-staging-' ) ) {
				return true;
			}

			if ( '' !== self::$rollback_slug && $top === self::$rollback_slug ) {
				return true;
			}
		}

		return false;
	}

	/**
	 * The one slug the current request may delete from the theme root (the
	 * install it is itself rolling back). Empty otherwise.
	 *
	 * @var string
	 */
	private static $rollback_slug = '';

	/**
	 * Delete a theme this request itself just installed and failed to
	 * activate — the ONLY path that removes an installed slug, and only for
	 * the duration of this call.
	 *
	 * @param string $slug Theme slug being rolled back.
	 * @return bool
	 */
	private static function remove_installed( string $slug ): bool {
		self::$rollback_slug = $slug;
		$removed             = self::rmdir_recursive( rtrim( (string) get_theme_root(), '/\\' ) . '/' . $slug );
		self::$rollback_slug = '';

		return $removed;
	}

	/**
	 * Recursive delete behind the fence.
	 *
	 * @param string $dir Directory.
	 * @return bool
	 */
	public static function rmdir_recursive( string $dir ): bool {
		clearstatcache( true, $dir );

		if ( '' === $dir || ! is_dir( $dir ) ) {
			return true;
		}

		if ( ! self::is_managed_theme_path( $dir ) ) {
			return false;
		}

		$filesystem = X_Companion_Block_Library::filesystem();

		if ( null === $filesystem ) {
			return false;
		}

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
	 * Move a directory into place (the block library's measured-against-WASM
	 * mover, theme-rooted). See class-block-library.php::move() for why each
	 * step exists.
	 *
	 * @param string $source      Source path.
	 * @param string $destination Destination path.
	 * @return bool
	 */
	private static function move( string $source, string $destination ): bool {
		$filesystem = X_Companion_Block_Library::filesystem();

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
			// phpcs:ignore WordPress.WP.AlternativeFunctions.rename_rename -- deliberate last resort; see class-block-library.php::move().
			@rename( $source, $destination );
		}

		clearstatcache( true );

		return file_exists( $destination ) && ! file_exists( $source );
	}

	/**
	 * Write the package root's files into a staging directory.
	 *
	 * @param string $archive  Path to the zip.
	 * @param array  $analysis analyze_theme_package() output.
	 * @param string $staging  Destination directory.
	 * @return true|WP_Error
	 */
	private static function extract( string $archive, array $analysis, string $staging ) {
		$root    = (string) $analysis['root'];
		$entries = (array) $analysis['entries'];

		if ( ! wp_mkdir_p( $staging ) ) {
			return new WP_Error( 'install_failed', __( 'Could not create the theme staging directory.', 'x-companion' ), array( 'status' => 500 ) );
		}

		foreach ( array_keys( $entries ) as $entry ) {
			if ( 0 !== strpos( $entry, $root ) ) {
				continue;
			}

			$relative = substr( $entry, strlen( $root ) );

			if ( '' === $relative || ! X_Companion_Block_Library::is_safe_entry( $relative ) ) {
				continue;
			}

			$destination = $staging . '/' . $relative;

			if ( ! wp_mkdir_p( dirname( $destination ) ) ) {
				return new WP_Error( 'install_failed', __( 'Could not create a directory inside the theme staging area.', 'x-companion' ), array( 'status' => 500 ) );
			}

			$contents = X_Companion_Block_Library::zip_read( $archive, $entry );

			if ( ! is_string( $contents ) ) {
				return new WP_Error( 'install_failed', __( 'Could not read an entry out of the theme package.', 'x-companion' ), array( 'status' => 500 ) );
			}

			if ( false === file_put_contents( $destination, $contents ) ) { // phpcs:ignore WordPress.WP.AlternativeFunctions.file_system_operations_file_put_contents
				return new WP_Error( 'install_failed', __( 'Could not write an extracted theme file.', 'x-companion' ), array( 'status' => 500 ) );
			}
		}

		return true;
	}

	/**
	 * 422 with the reason list, mirroring the block library's contract.
	 *
	 * @param string[] $reasons Reasons.
	 * @return WP_Error
	 */
	private static function policy_error( array $reasons ): WP_Error {
		return new WP_Error(
			'invalid_theme_package',
			__( 'The theme package violates install policy.', 'x-companion' ),
			array(
				'status'  => 422,
				'reasons' => array_values( $reasons ),
			)
		);
	}

	/**
	 * The error a filesystem operation gets when WP_Filesystem is unusable.
	 *
	 * @param string $code    Error code.
	 * @param string $message What was being attempted.
	 * @return WP_Error
	 */
	private static function filesystem_error( string $code, string $message ): WP_Error {
		if ( null === X_Companion_Block_Library::filesystem() ) {
			$message .= ' ' . __( 'WP_Filesystem needs credentials on this installation; define FS_METHOD as "direct", or supply FTP constants in wp-config.php.', 'x-companion' );
		}

		return new WP_Error( $code, $message, array( 'status' => 500 ) );
	}
}
