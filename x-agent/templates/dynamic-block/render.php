<?php
/**
 * Server-side render callback for `agent/{{slug}}` — {{title}}.
 *
 * =============================================================================
 * RENDER INTENT — the agent implements this file against the description below.
 * =============================================================================
{{render_intent_comment}}
 * =============================================================================
 *
 * This block is DYNAMIC by construction. Markup is produced here, on the server,
 * on every request; there is no `save()` and nothing is frozen into post
 * content. That is why editing this file changes every existing usage, and why
 * the block can never go "invalid" in the editor.
 *
 * Rules for whatever replaces the body below:
 *   - EVERY attribute value must go through an escaping function on output
 *     (`esc_html`, `esc_attr`, `esc_url`, `wp_kses_post`) — never echo raw.
 *   - String attributes edited inline via RichText in edit.js arrive
 *     entity-encoded: output them with `wp_kses( $value, array() )` (or a
 *     richer whitelist), NOT `esc_html()`, or entities double-escape.
 *   - Image attributes (control `image`) hold attachment URLs: output them
 *     with `esc_url()` inside an <img>, and keep the element empty-safe.
 *   - The outermost element must carry `get_block_wrapper_attributes()` so the
 *     block's own supports (align, spacing, colour, anchor) actually apply.
 *   - Return nothing / echo directly: WordPress buffers this file's output.
 *
 * Available in this scope:
 *
 * @var array    $attributes Block attributes, defaults already merged in.
 * @var string   $content    InnerBlocks markup ('' when the block has none).
 * @var WP_Block $block      The block instance.
 *
 * @package {{textdomain}}
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

{{attribute_locals}}

$wrapper_attributes = get_block_wrapper_attributes( array( 'class' => '{{css_class}}' ) );

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- get_block_wrapper_attributes() returns pre-escaped markup.
?>
<div <?php echo $wrapper_attributes; ?>>
{{attribute_output}}
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
