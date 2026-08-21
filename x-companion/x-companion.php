<?php
/**
 * Plugin Name:       X Companion
 * Plugin URI:        https://github.com/x-contract/x-companion
 * Description:       Makes this WordPress instance a ground-truth toolchain target for block-generating agents: exposes the live block registry, theme tokens and patterns as machine-readable contracts, validates agent-generated Tree IR against them, and hosts the browser serialization harness.
 * Version:           1.0.0
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * Author:            X Contract
 * License:           GPL-2.0-or-later
 * License URI:       https://www.gnu.org/licenses/gpl-2.0.html
 * Text Domain:       x-companion
 *
 * @package x-companion
 */

defined( 'ABSPATH' ) || exit;

/*
 * ---------------------------------------------------------------------------
 * Constants
 * ---------------------------------------------------------------------------
 */

define( 'X_COMPANION_VERSION', '1.0.0' );
define( 'X_COMPANION_FILE', __FILE__ );
define( 'X_COMPANION_DIR', plugin_dir_path( __FILE__ ) );
define( 'X_COMPANION_URL', plugin_dir_url( __FILE__ ) );

/** REST namespace. Pinned by contract v1. */
define( 'X_COMPANION_REST_NAMESPACE', 'x-companion/v1' );

/** interfaces.version. Pinned by contract v1. Bumping this is a wire break. */
define( 'X_COMPANION_INTERFACES_VERSION', '1' );

/**
 * Posture. 'toolchain' | 'production'.
 *
 * MUST default to 'production' when undefined: a plugin that lands on a live
 * site without anyone thinking about it gets the safe posture, not the
 * permissive one. Set in wp-config.php:
 *
 *     define( 'X_COMPANION_POSTURE', 'toolchain' );
 */
if ( ! defined( 'X_COMPANION_POSTURE' ) ) {
	define( 'X_COMPANION_POSTURE', 'production' );
}

/**
 * Allow installing static (non-dynamic) agent blocks.
 *
 * Default false: static blocks freeze save() output into post content and
 * break on every iteration of the block's markup. Enforced by the block
 * library installer.
 */
if ( ! defined( 'X_COMPANION_ALLOW_STATIC_BLOCKS' ) ) {
	define( 'X_COMPANION_ALLOW_STATIC_BLOCKS', false );
}

/** Option holding the posture the current role/caps grant was built for. */
define( 'X_COMPANION_CAPS_OPTION', 'x_companion_caps_posture' );

/** The agent role slug. */
define( 'X_COMPANION_ROLE', 'x_agent' );

/*
 * ---------------------------------------------------------------------------
 * Posture + capabilities
 * ---------------------------------------------------------------------------
 */

/**
 * Resolve the posture, defensively.
 *
 * An unrecognised value is treated as 'production'. Never guess permissive.
 *
 * @return string 'toolchain'|'production'
 */
function x_companion_posture(): string {
	$posture = defined( 'X_COMPANION_POSTURE' ) ? X_COMPANION_POSTURE : 'production';

	return ( 'toolchain' === $posture ) ? 'toolchain' : 'production';
}

/**
 * True when the extend tier is available on this instance.
 *
 * @return bool
 */
function x_companion_extend_enabled(): bool {
	return 'toolchain' === x_companion_posture();
}

/**
 * The three capability tiers, ordered.
 *
 * @return string[]
 */
function x_companion_capabilities(): array {
	return array( 'x_companion_read', 'x_companion_author', 'x_companion_extend' );
}

/**
 * Create/refresh the x_agent role and grant administrators every capability.
 *
 * x_companion_extend is granted to the role ONLY in toolchain posture. The
 * route-level posture gate still applies to administrators, who always hold
 * all three caps.
 *
 * @return void
 */
function x_companion_install_caps(): void {
	$caps = array(
		'read'               => true,
		'x_companion_read'   => true,
		'x_companion_author' => true,
	);

	if ( x_companion_extend_enabled() ) {
		$caps['x_companion_extend'] = true;
	}

	// remove_role() + add_role() so a posture flip re-syncs the grant exactly.
	remove_role( X_COMPANION_ROLE );
	add_role( X_COMPANION_ROLE, __( 'X Agent', 'x-companion' ), $caps );

	$admin = get_role( 'administrator' );
	if ( $admin instanceof WP_Role ) {
		foreach ( x_companion_capabilities() as $cap ) {
			$admin->add_cap( $cap );
		}
	}

	update_option( X_COMPANION_CAPS_OPTION, x_companion_posture(), true );
}

/**
 * Drop the role and revoke administrator capabilities.
 *
 * @return void
 */
function x_companion_remove_caps(): void {
	remove_role( X_COMPANION_ROLE );

	$admin = get_role( 'administrator' );
	if ( $admin instanceof WP_Role ) {
		foreach ( x_companion_capabilities() as $cap ) {
			$admin->remove_cap( $cap );
		}
	}

	delete_option( X_COMPANION_CAPS_OPTION );
}

/**
 * Activation hook.
 *
 * @return void
 */
function x_companion_activate(): void {
	x_companion_install_caps();
}
register_activation_hook( __FILE__, 'x_companion_activate' );

/**
 * Re-sync the role when the posture constant changed since activation.
 *
 * Cheap: one autoloaded option read per request.
 *
 * @return void
 */
function x_companion_maybe_resync_caps(): void {
	if ( get_option( X_COMPANION_CAPS_OPTION ) !== x_companion_posture() ) {
		x_companion_install_caps();
	}
}

/*
 * ---------------------------------------------------------------------------
 * Loader
 * ---------------------------------------------------------------------------
 *
 * Every includes/class-*.php that exists is required, then ::init() is called
 * on the class it declares, if that class exists and declares init(). Files
 * owned by other milestones may legitimately be absent; a missing file must
 * never fatal the site.
 */

/**
 * Map an include filename to its class name.
 *
 * class-block-library.php -> X_Companion_Block_Library
 *
 * @param string $file Absolute path to the include.
 * @return string Class name.
 */
function x_companion_class_for_file( string $file ): string {
	$base = basename( $file, '.php' );
	$base = preg_replace( '/^class-/', '', $base );

	$parts = array_map( 'ucfirst', explode( '-', (string) $base ) );

	return 'X_Companion_' . implode( '_', $parts );
}

/**
 * Require every present include and boot the classes they declare.
 *
 * @return void
 */
function x_companion_load(): void {
	$includes = glob( X_COMPANION_DIR . 'includes/class-*.php' );
	$includes = is_array( $includes ) ? $includes : array();
	sort( $includes );

	$classes = array();

	foreach ( $includes as $file ) {
		if ( ! file_exists( $file ) ) {
			continue;
		}
		require_once $file;

		$class = x_companion_class_for_file( $file );
		if ( class_exists( $class ) ) {
			$classes[] = $class;
		}
	}

	// Suite adapters are plain classes; they are required (so class-theme-tokens
	// can discover them) but never booted directly.
	$adapters = glob( X_COMPANION_DIR . 'includes/adapters/class-*.php' );
	foreach ( is_array( $adapters ) ? $adapters : array() as $file ) {
		if ( file_exists( $file ) ) {
			require_once $file;
		}
	}

	foreach ( $classes as $class ) {
		if ( method_exists( $class, 'init' ) ) {
			call_user_func( array( $class, 'init' ) );
		}
	}
}

/**
 * Boot.
 *
 * @return void
 */
function x_companion_boot(): void {
	x_companion_maybe_resync_caps();
	x_companion_load();
}
add_action( 'plugins_loaded', 'x_companion_boot', 5 );
