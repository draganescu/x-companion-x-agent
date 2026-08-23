<?php
/**
 * Server-side render callback for `agent/moulin-sails` — Windmill hero.
 *
 * =============================================================================
 * RENDER INTENT — the agent implements this file against the description below.
 * =============================================================================
 * A full-viewport-height hero: a stylised red windmill drawn as inline SVG whose
 * four sails rotate continuously (CSS keyframes on a group with transform-box
 * fill-box, duration from spin_seconds, disabled under prefers-reduced-motion),
 * above a small uppercase kicker line, a display-size main title and a tagline.
 * All colors from theme preset custom properties (rouge, gold, contrast, base);
 * escape every attribute; get_block_wrapper_attributes() on the wrapper.
 * =============================================================================
 *
 * @var array    $attributes Block attributes, defaults already merged in.
 * @var string   $content    InnerBlocks markup ('' when the block has none).
 * @var WP_Block $block      The block instance.
 *
 * @package agent-moulin-sails
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only render branch, no state is written.
$is_editor_preview = defined( 'REST_REQUEST' ) && REST_REQUEST && isset( $_GET['context'] ) && 'edit' === sanitize_key( wp_unslash( (string) $_GET['context'] ) );

$kicker       = (string) ( $attributes['kicker'] ?? '' );
$heading      = (string) ( $attributes['heading'] ?? 'Moulin Rouge' );
$tagline      = (string) ( $attributes['tagline'] ?? '' );
$spin_seconds = (float) ( $attributes['spin_seconds'] ?? 16 );
if ( $spin_seconds < 2 ) {
	$spin_seconds = 2;
}

$wrapper_attributes = get_block_wrapper_attributes(
	array(
		'class' => 'agent-moulin-sails',
		'style' => sprintf( '--mr-spin:%ss', esc_attr( (string) $spin_seconds ) ),
	)
);

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- get_block_wrapper_attributes() returns pre-escaped markup.
?>
<div <?php echo $wrapper_attributes; ?>>
	<svg class="mr-windmill" viewBox="0 0 200 250" role="img" aria-label="<?php esc_attr_e( 'The red windmill of the Moulin Rouge, sails turning', 'agent-moulin-sails' ); ?>" focusable="false">
		<g class="mr-mill">
			<path class="mr-mill__tower" d="M80 118 L120 118 L134 244 L66 244 Z" />
			<path class="mr-mill__dome" d="M78 118 Q100 88 122 118 Z" />
			<rect class="mr-mill__band" x="76" y="114" width="48" height="6" rx="3" />
			<rect class="mr-mill__window" x="94" y="150" width="12" height="18" rx="6" />
			<rect class="mr-mill__window" x="92" y="190" width="16" height="20" rx="8" />
		</g>
		<g transform="translate(100 100)">
			<g class="mr-rotor">
				<g class="mr-sail">
					<rect class="mr-sail__arm" x="-2.5" y="-86" width="5" height="86" rx="2.5" />
					<rect class="mr-sail__web" x="5" y="-84" width="20" height="58" rx="3" />
					<line class="mr-sail__rung" x1="5" y1="-70" x2="25" y2="-70" />
					<line class="mr-sail__rung" x1="5" y1="-55" x2="25" y2="-55" />
					<line class="mr-sail__rung" x1="5" y1="-40" x2="25" y2="-40" />
				</g>
				<g class="mr-sail" transform="rotate(90)">
					<rect class="mr-sail__arm" x="-2.5" y="-86" width="5" height="86" rx="2.5" />
					<rect class="mr-sail__web" x="5" y="-84" width="20" height="58" rx="3" />
					<line class="mr-sail__rung" x1="5" y1="-70" x2="25" y2="-70" />
					<line class="mr-sail__rung" x1="5" y1="-55" x2="25" y2="-55" />
					<line class="mr-sail__rung" x1="5" y1="-40" x2="25" y2="-40" />
				</g>
				<g class="mr-sail" transform="rotate(180)">
					<rect class="mr-sail__arm" x="-2.5" y="-86" width="5" height="86" rx="2.5" />
					<rect class="mr-sail__web" x="5" y="-84" width="20" height="58" rx="3" />
					<line class="mr-sail__rung" x1="5" y1="-70" x2="25" y2="-70" />
					<line class="mr-sail__rung" x1="5" y1="-55" x2="25" y2="-55" />
					<line class="mr-sail__rung" x1="5" y1="-40" x2="25" y2="-40" />
				</g>
				<g class="mr-sail" transform="rotate(270)">
					<rect class="mr-sail__arm" x="-2.5" y="-86" width="5" height="86" rx="2.5" />
					<rect class="mr-sail__web" x="5" y="-84" width="20" height="58" rx="3" />
					<line class="mr-sail__rung" x1="5" y1="-70" x2="25" y2="-70" />
					<line class="mr-sail__rung" x1="5" y1="-55" x2="25" y2="-55" />
					<line class="mr-sail__rung" x1="5" y1="-40" x2="25" y2="-40" />
				</g>
				<circle class="mr-rotor__hub" cx="0" cy="0" r="9" />
			</g>
		</g>
	</svg>
	<?php if ( '' !== $kicker ) : ?>
		<p class="agent-moulin-sails__kicker"><?php echo esc_html( $kicker ); ?></p>
	<?php endif; ?>
	<h1 class="agent-moulin-sails__heading"><?php echo esc_html( $heading ); ?></h1>
	<?php if ( '' !== $tagline ) : ?>
		<p class="agent-moulin-sails__tagline"><?php echo esc_html( $tagline ); ?></p>
	<?php endif; ?>
	<span class="agent-moulin-sails__scroll-hint" aria-hidden="true">&#x2193;</span>
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
