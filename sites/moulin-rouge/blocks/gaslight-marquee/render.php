<?php
/**
 * Server-side render callback for `agent/gaslight-marquee` — Scrolling ribbon.
 *
 * =============================================================================
 * RENDER INTENT — the agent implements this file against the description below.
 * =============================================================================
 * A full-width ribbon strip: the phrases joined by star separators, duplicated
 * into two identical rows (the second aria-hidden) inside an overflow-hidden
 * track, animated with translateX(-50%) keyframes over speed_seconds, linear,
 * infinite; animation-play-state paused on hover and disabled under
 * prefers-reduced-motion. Colors and type from theme preset custom properties
 * only; escape every phrase; get_block_wrapper_attributes() on the wrapper.
 * =============================================================================
 *
 * @var array    $attributes Block attributes, defaults already merged in.
 * @var string   $content    InnerBlocks markup ('' when the block has none).
 * @var WP_Block $block      The block instance.
 *
 * @package agent-gaslight-marquee
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$phrases = $attributes['phrases'] ?? array();
if ( ! is_array( $phrases ) ) {
	$phrases = array();
}
$phrases = array_values( array_filter( array_map( 'trim', array_map( 'strval', $phrases ) ) ) );
if ( empty( $phrases ) ) {
	$phrases = array( __( 'Moulin Rouge', 'agent-gaslight-marquee' ) );
}

$speed_seconds = (float) ( $attributes['speed_seconds'] ?? 30 );
if ( $speed_seconds < 5 ) {
	$speed_seconds = 5;
}

$wrapper_attributes = get_block_wrapper_attributes(
	array(
		'class' => 'agent-gaslight-marquee',
		'style' => sprintf( '--mr-glide:%ss', esc_attr( (string) $speed_seconds ) ),
	)
);

$row = '';
foreach ( $phrases as $phrase ) {
	$row .= '<span class="mr-marquee__item">' . esc_html( $phrase ) . '</span>';
	$row .= '<span class="mr-marquee__star" aria-hidden="true">&#x2605;</span>';
}

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- $row is built above from esc_html()'d phrases; wrapper attrs are pre-escaped.
?>
<div <?php echo $wrapper_attributes; ?>>
	<div class="mr-marquee__track">
		<div class="mr-marquee__row"><?php echo $row; ?></div>
		<div class="mr-marquee__row" aria-hidden="true"><?php echo $row; ?></div>
	</div>
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
