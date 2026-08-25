<?php
/**
 * Uninstall x-companion.
 *
 * Removes the x_agent role, revokes the three capabilities from every role
 * that holds them, and deletes plugin options/transients.
 *
 * It deliberately does NOT touch installed agent packages: they are standard,
 * independently activated plugins under wp-content/plugins/ (agent-block-*,
 * agent-schema-*) and may still be serving published content. Each one is
 * removed on its own, canonically, from plugins.php.
 *
 * @package x-companion
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

global $wpdb;

$x_companion_caps = array( 'x_companion_read', 'x_companion_author', 'x_companion_extend' );

remove_role( 'x_agent' );

$x_companion_roles = wp_roles();
foreach ( array_keys( $x_companion_roles->roles ) as $x_companion_role_slug ) {
	$x_companion_role = get_role( $x_companion_role_slug );
	if ( ! $x_companion_role instanceof WP_Role ) {
		continue;
	}
	foreach ( $x_companion_caps as $x_companion_cap ) {
		$x_companion_role->remove_cap( $x_companion_cap );
	}
}

delete_option( 'x_companion_caps_posture' );
delete_option( 'x_companion_manifest_cache_key' );

// The agent pattern corpus (saved sections and design-kit molecules) is plugin
// state, not content: published pages carry compiled markup and never reference
// it, so it sweeps cleanly with the plugin (deliverable-purity).
delete_option( 'x_companion_patterns' );

// Manifest transients are keyed by fingerprint, so sweep the prefix.
$x_companion_transients = $wpdb->get_col(
	$wpdb->prepare(
		"SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s OR option_name LIKE %s",
		$wpdb->esc_like( '_transient_x_companion_' ) . '%',
		$wpdb->esc_like( '_transient_timeout_x_companion_' ) . '%'
	)
);

foreach ( (array) $x_companion_transients as $x_companion_option_name ) {
	delete_option( $x_companion_option_name );
}

if ( is_multisite() ) {
	$x_companion_site_transients = $wpdb->get_col(
		$wpdb->prepare(
			"SELECT meta_key FROM {$wpdb->sitemeta} WHERE meta_key LIKE %s OR meta_key LIKE %s",
			$wpdb->esc_like( '_site_transient_x_companion_' ) . '%',
			$wpdb->esc_like( '_site_transient_timeout_x_companion_' ) . '%'
		)
	);
	foreach ( (array) $x_companion_site_transients as $x_companion_meta_key ) {
		delete_site_option( str_replace( array( '_site_transient_timeout_', '_site_transient_' ), '', $x_companion_meta_key ) );
	}
}
