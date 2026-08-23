<?php
/**
 * Server-side render callback for `agent/newsletter-capture` — Newsletter signup.
 *
 * =============================================================================
 * RENDER INTENT — the agent implements this file against the description below.
 * =============================================================================
 * One block, two modes. inline: a centered signup card — heading, message, an
 * email form (email input with placeholder, submit button labelled
 * button_label, hidden hp_website honeypot field, hidden _wpnonce) that POSTs
 * to the agent-newsletter/v1/subscribe REST route and works without
 * JavaScript; view.js upgrades it to fetch-in-place and swaps the form for
 * success_message. exit: the same card inside a native <dialog> that stays
 * closed; view.js pushes a history sentinel on load and opens the dialog on
 * popstate exactly once per session (sessionStorage guard, skipped if already
 * subscribed); the decline link, Escape and dialog cancel all really leave via
 * history.back(); a successful signup shows success_message then leaves the
 * same way. When $is_editor_preview is true the exit dialog's card is rendered
 * open in the canvas so the editor can see what they are editing. The
 * stylesheet must restate [hidden]{display:none} for any element it sets
 * display on. Tokens only; escape everything; get_block_wrapper_attributes().
 * =============================================================================
 *
 * @var array    $attributes Block attributes, defaults already merged in.
 * @var string   $content    InnerBlocks markup ('' when the block has none).
 * @var WP_Block $block      The block instance.
 *
 * @package agent-newsletter-capture
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only render branch, no state is written.
$is_editor_preview = defined( 'REST_REQUEST' ) && REST_REQUEST && isset( $_GET['context'] ) && 'edit' === sanitize_key( wp_unslash( (string) $_GET['context'] ) );

$mode            = ( 'exit' === ( $attributes['mode'] ?? 'inline' ) ) ? 'exit' : 'inline';
$heading         = (string) ( $attributes['heading'] ?? '' );
$message         = (string) ( $attributes['message'] ?? '' );
$placeholder     = (string) ( $attributes['placeholder'] ?? 'your@email.com' );
$button_label    = (string) ( $attributes['button_label'] ?? __( 'Sign up', 'agent-newsletter-capture' ) );
$success_message = (string) ( $attributes['success_message'] ?? __( 'Thank you!', 'agent-newsletter-capture' ) );
$decline_label   = (string) ( $attributes['decline_label'] ?? __( 'No thank you', 'agent-newsletter-capture' ) );

$action = rest_url( 'agent-newsletter/v1/subscribe' );
$nonce  = wp_create_nonce( 'wp_rest' );
$source = 'exit' === $mode ? 'exit_modal' : 'inline';

$wrapper_attributes = get_block_wrapper_attributes(
	array(
		'class'     => 'agent-newsletter-capture is-mode-' . $mode,
		'data-mode' => $mode,
	)
);

ob_start();
?>
	<div class="mr-capture__card">
		<?php if ( '' !== $heading ) : ?>
			<h2 class="mr-capture__heading"><?php echo esc_html( $heading ); ?></h2>
		<?php endif; ?>
		<?php if ( '' !== $message ) : ?>
			<p class="mr-capture__message"><?php echo esc_html( $message ); ?></p>
		<?php endif; ?>
		<form class="mr-capture__form" method="post" action="<?php echo esc_url( $action ); ?>">
			<input type="hidden" name="_wpnonce" value="<?php echo esc_attr( $nonce ); ?>" />
			<input type="hidden" name="signup_source" value="<?php echo esc_attr( $source ); ?>" />
			<p class="mr-capture__hp" aria-hidden="true">
				<label>
					<?php esc_html_e( 'Leave this field empty', 'agent-newsletter-capture' ); ?>
					<input type="text" name="hp_website" value="" tabindex="-1" autocomplete="off" />
				</label>
			</p>
			<label class="mr-capture__email-label" for="mr-capture-email-<?php echo esc_attr( $source ); ?>">
				<?php esc_html_e( 'Your email address', 'agent-newsletter-capture' ); ?>
			</label>
			<div class="mr-capture__row">
				<input
					class="mr-capture__email"
					id="mr-capture-email-<?php echo esc_attr( $source ); ?>"
					type="email"
					name="email"
					required
					placeholder="<?php echo esc_attr( $placeholder ); ?>"
				/>
				<button class="mr-capture__submit" type="submit"><?php echo esc_html( $button_label ); ?></button>
			</div>
		</form>
		<p class="mr-capture__error" role="alert" hidden></p>
		<p class="mr-capture__success" role="status" <?php echo $is_editor_preview ? '' : 'hidden'; ?>><?php echo esc_html( $success_message ); ?></p>
		<?php if ( 'exit' === $mode ) : ?>
			<button class="mr-capture__decline" type="button"><?php echo esc_html( $decline_label ); ?></button>
		<?php endif; ?>
	</div>
<?php
$card = (string) ob_get_clean();

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- $card is assembled above from escaped parts; wrapper attrs are pre-escaped.
?>
<div <?php echo $wrapper_attributes; ?>>
	<?php if ( 'exit' === $mode ) : ?>
		<dialog class="mr-capture__dialog" <?php echo $is_editor_preview ? 'open' : ''; ?>>
			<?php echo $card; ?>
		</dialog>
	<?php else : ?>
		<?php echo $card; ?>
	<?php endif; ?>
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
