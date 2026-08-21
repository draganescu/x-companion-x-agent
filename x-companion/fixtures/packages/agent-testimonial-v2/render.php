<?php
/**
 * Server render for agent/testimonial, version 2.
 *
 * Deliberately different markup from version 1 so a rollback is observable in
 * the output of POST /render.
 *
 * @package agent-testimonial
 */

$agent_quote       = isset( $attributes['quote'] ) ? (string) $attributes['quote'] : '';
$agent_attribution = isset( $attributes['attribution'] ) ? (string) $attributes['attribution'] : '';

$agent_wrapper = get_block_wrapper_attributes(
	array(
		'class'      => 'agent-testimonial agent-testimonial--v2',
		'data-agent' => 'testimonial-v2',
	)
);
?>
<section <?php echo $agent_wrapper; // phpcs:ignore WordPress.Security.EscapeOutput.OutputNotEscaped ?>>
	<p class="agent-testimonial__quote-v2">&ldquo;<?php echo esc_html( $agent_quote ); ?>&rdquo;</p>
	<p class="agent-testimonial__attribution-v2"><?php echo esc_html( $agent_attribution ); ?></p>
</section>
