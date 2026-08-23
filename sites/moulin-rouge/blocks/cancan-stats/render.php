<?php
/**
 * Server-side render callback for `agent/cancan-stats` — Numbers that dance.
 *
 * =============================================================================
 * RENDER INTENT — the agent implements this file against the description below.
 * =============================================================================
 * A responsive row of stat items. Each item: the final number (rendered
 * server-side so it is correct without JavaScript) in display-size type with
 * its optional suffix, and the label underneath. view.js enhances: an
 * IntersectionObserver starts a requestAnimationFrame count-up from 0 to the
 * value over duration_ms with an ease-out curve, once per page view, skipped
 * under prefers-reduced-motion. Numbers formatted with thin thousands
 * separators. Tokens only for color/size; escape everything;
 * get_block_wrapper_attributes() on the wrapper.
 * =============================================================================
 *
 * @var array    $attributes Block attributes, defaults already merged in.
 * @var string   $content    InnerBlocks markup ('' when the block has none).
 * @var WP_Block $block      The block instance.
 *
 * @package agent-cancan-stats
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

$stats = $attributes['stats'] ?? array();
if ( ! is_array( $stats ) ) {
	$stats = array();
}

$duration_ms = (int) ( $attributes['duration_ms'] ?? 1600 );
if ( $duration_ms < 200 ) {
	$duration_ms = 200;
}

$wrapper_attributes = get_block_wrapper_attributes(
	array(
		'class'            => 'agent-cancan-stats',
		'data-duration-ms' => (string) $duration_ms,
	)
);

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- get_block_wrapper_attributes() returns pre-escaped markup.
?>
<div <?php echo $wrapper_attributes; ?>>
	<?php foreach ( $stats as $stat ) : ?>
		<?php
		if ( ! is_array( $stat ) ) {
			continue;
		}
		$value  = (float) ( $stat['value'] ?? 0 );
		$suffix = (string) ( $stat['suffix'] ?? '' );
		$label  = (string) ( $stat['label'] ?? '' );
		// Years read as plain figures; other quantities get separators.
		$formatted = ( $value >= 1000 && $value <= 2100 && floor( $value ) === $value )
			? (string) (int) $value
			: number_format_i18n( $value );
		?>
		<div class="mr-stat">
			<span class="mr-stat__figure">
				<span class="mr-stat__number" data-value="<?php echo esc_attr( (string) $value ); ?>"><?php echo esc_html( $formatted ); ?></span><span class="mr-stat__suffix"><?php echo esc_html( $suffix ); ?></span>
			</span>
			<?php if ( '' !== $label ) : ?>
				<span class="mr-stat__label"><?php echo esc_html( $label ); ?></span>
			<?php endif; ?>
		</div>
	<?php endforeach; ?>
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
