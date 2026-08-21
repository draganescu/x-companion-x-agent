<?php
/**
 * Server render for agent/testimonial, version 1.
 *
 * $attributes, $content and $block are provided by WordPress.
 *
 * @package agent-testimonial
 */

$agent_quote       = isset( $attributes['quote'] ) ? (string) $attributes['quote'] : '';
$agent_attribution = isset( $attributes['attribution'] ) ? (string) $attributes['attribution'] : '';
$agent_role        = isset( $attributes['role'] ) ? (string) $attributes['role'] : '';
$agent_tone        = isset( $attributes['tone'] ) ? (string) $attributes['tone'] : 'plain';

$agent_wrapper = get_block_wrapper_attributes(
	array(
		'class'      => 'agent-testimonial is-tone-' . sanitize_html_class( $agent_tone ),
		'data-agent' => 'testimonial-v1',
	)
);
?>
<figure <?php echo $agent_wrapper; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>>
	<blockquote class="agent-testimonial__quote"><?php echo esc_html( $agent_quote ); ?></blockquote>
	<?php if ( '' !== $agent_attribution || '' !== $agent_role ) : ?>
		<figcaption class="agent-testimonial__attribution">
			<span class="agent-testimonial__name"><?php echo esc_html( $agent_attribution ); ?></span>
			<?php if ( '' !== $agent_role ) : ?>
				<span class="agent-testimonial__role"><?php echo esc_html( $agent_role ); ?></span>
			<?php endif; ?>
		</figcaption>
	<?php endif; ?>
</figure>
