<?php
/**
 * REST routes for agent-schema-newsletter. Namespace AGENT_SCHEMA_NEWSLETTER_REST_NS.
 *
 * POLICY: every route declares its auth. public-nonce routes verify a REST
 * nonce and an empty honeypot before touching anything; capability routes
 * name the capability in permission_callback. Handlers sanitize every input
 * and write exclusively through core APIs.
 */

defined( 'ABSPATH' ) || exit;

add_action( 'rest_api_init', static function (): void {
	register_rest_route( AGENT_SCHEMA_NEWSLETTER_REST_NS, "/subscribe", array(
		'methods'             => "POST",
		// public-nonce: open at the permission layer, verified in the handler.
		'permission_callback' => '__return_true',
		'callback'            => static function ( WP_REST_Request $request ) {
			$nonce = (string) ( $request->get_param( '_wpnonce' ) ?? $request->get_header( 'X-WP-Nonce' ) );
			if ( ! wp_verify_nonce( $nonce, 'wp_rest' ) ) {
				return new WP_Error( 'rest_cookie_invalid_nonce', 'Nonce check failed.', array( 'status' => 403 ) );
			}
			if ( '' !== trim( (string) $request->get_param( 'hp_website' ) ) ) {
				return new WP_Error( 'rest_invalid_param', 'Submission could not be verified.', array( 'status' => 400 ) );
			}
			// A nonce'd call with no email is a reachability ping, not a signup.
			if ( null === $request->get_param( 'email' ) ) {
				return rest_ensure_response( array( 'ping' => true ) );
			}
			$email = sanitize_email( (string) $request->get_param( 'email' ) );
			if ( '' === $email || ! is_email( $email ) ) {
				return new WP_Error( 'rest_invalid_param', 'Merci de saisir une adresse e-mail valide.', array( 'status' => 400 ) );
			}
			$existing = get_posts( array(
				'post_type'      => 'mr_subscriber',
				'post_status'    => array( 'pending', 'publish', 'draft' ),
				'meta_key'       => 'email',
				'meta_value'     => $email,
				'posts_per_page' => 1,
				'fields'         => 'ids',
			) );
			if ( ! empty( $existing ) ) {
				return rest_ensure_response( array( 'created' => (int) $existing[0], 'duplicate' => true ) );
			}
			$post_id = wp_insert_post( array(
				'post_type'   => 'mr_subscriber',
				'post_status' => 'pending',
				'post_title'  => $email,
			), true );
			if ( is_wp_error( $post_id ) ) {
				return new WP_Error( 'rest_cannot_create', $post_id->get_error_message(), array( 'status' => 500 ) );
			}
			update_post_meta( $post_id, 'email', $email );
			$source = sanitize_key( (string) ( $request->get_param( 'signup_source' ) ?? 'inline' ) );
			update_post_meta( $post_id, 'signup_source', '' !== $source ? $source : 'inline' );
			return rest_ensure_response( array( 'created' => $post_id ) );
		},
	) );

} );
