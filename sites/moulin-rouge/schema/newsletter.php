<?php
/**
 * Plugin Name:       Moulin Rouge — Newsletter Subscribers
 * Description:       Collects newsletter signups from the Moulin Rouge site and files each one as a subscriber record under Subscribers in the dashboard. Provides the secure signup endpoint used by the signup form, with spam protection built in; new signups arrive as pending entries for review.
 * Version:           1.0.1
 * Requires at least: 6.5
 * Requires PHP:      8.1
 * License:           GPL-2.0-or-later
 * Update URI:        false
 *
 * =========================================================================
 * INTENT — the domain this package models. Implement against this.
 * =========================================================================
 * Tourism newsletter signups collected on the Moulin Rouge landing page: visitors submit their email through a public nonce-guarded route (from the end-of-page inline form or the exit-intent modal); each signup is stored as a pending mr_subscriber record with the email and which form captured it, and staff review the list in the standard admin table.
 * =========================================================================
 */

defined( 'ABSPATH' ) || exit;

define( 'AGENT_SCHEMA_NEWSLETTER_VERSION', '1.0.1' );
define( 'AGENT_SCHEMA_NEWSLETTER_REST_NS', 'agent-newsletter/v1' );

/** Every registration happens here, on every request. */
function agent_schema_newsletter_register(): void {
	register_post_type( 'mr_subscriber', array(
		'label'         => "Subscribers",
		'public'        => false,
		'show_ui'       => true,
		'show_in_menu'  => true,
		'show_in_rest'  => true,
		'menu_icon'     => 'dashicons-database',
		'supports'      => array( "title", "custom-fields" ),
	) );

	register_post_meta( 'mr_subscriber', "email", array(
		'type'         => "string",
		'single'       => true,
		// POLICY: REST-invisible meta is invisible to bindings and to the agent.
		'show_in_rest' => array( 'schema' => array( "type" => "string" ) ),
		'sanitize_callback' => static function ( $value ) { return is_string( $value ) ? sanitize_text_field( $value ) : $value; },
	) );

	register_post_meta( 'mr_subscriber', "signup_source", array(
		'type'         => "string",
		'single'       => true,
		// POLICY: REST-invisible meta is invisible to bindings and to the agent.
		'show_in_rest' => array( 'schema' => array( "type" => "string" ) ),
		'sanitize_callback' => static function ( $value ) { return is_string( $value ) ? sanitize_text_field( $value ) : $value; },
	) );

}
add_action( 'init', 'agent_schema_newsletter_register' );

add_filter( 'manage_mr_subscriber_posts_columns', static function ( array $columns ): array {
	$columns["email"] = "email";
	$columns["signup_source"] = "signup source";
	return $columns;
} );
add_action( 'manage_mr_subscriber_posts_custom_column', static function ( string $column, int $post_id ): void {
	if ( in_array( $column, array( "email", "signup_source" ), true ) ) {
		echo esc_html( (string) get_post_meta( $post_id, $column, true ) );
	}
}, 10, 2 );

require_once __DIR__ . '/routes.php';
