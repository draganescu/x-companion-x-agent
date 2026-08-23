<?php
/**
 * Uninstall for agent-schema-newsletter.
 *
 * Registrations are hook-based and vanish with the plugin. Content removal
 * is destructive and therefore opt-in: define
 * X_AGENT_SCHEMA_UNINSTALL_CONTENT true to also delete the stored entries.
 */
defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

if ( defined( 'X_AGENT_SCHEMA_UNINSTALL_CONTENT' ) && X_AGENT_SCHEMA_UNINSTALL_CONTENT ) {
	foreach ( get_posts( array( 'post_type' => 'mr_subscriber', 'post_status' => 'any', 'numberposts' => -1, 'fields' => 'ids' ) ) as $x_id ) {
		wp_delete_post( (int) $x_id, true );
	}
}
