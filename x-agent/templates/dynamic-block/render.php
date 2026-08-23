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
 *   - String attributes arrive as plain text from the inspector controls:
 *     output them with `esc_html()` (or `wp_kses_post( wpautop( ... ) )` for
 *     multi-paragraph textarea content).
 *   - Image attributes (control `image`) hold attachment URLs: output them
 *     with `esc_url()` inside an <img>, and keep the element empty-safe.
 *   - The editor previews this file live through ServerSideRender. If part
 *     of the output is hidden on the front by default (a closed modal, a
 *     success state), show it when `$is_editor_preview` is true so the site
 *     editor can see what they are editing.
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

// True while the block editor is asking for a preview of this block (the
// block-renderer REST route ServerSideRender calls with context=edit). Use it
// to reveal output the front hides by default, never to change front markup.
// phpcs:ignore WordPress.Security.NonceVerification.Recommended -- read-only render branch, no state is written.
$is_editor_preview = defined( 'REST_REQUEST' ) && REST_REQUEST && isset( $_GET['context'] ) && 'edit' === sanitize_key( wp_unslash( (string) $_GET['context'] ) );

{{attribute_locals}}

$wrapper_attributes = get_block_wrapper_attributes( array( 'class' => '{{css_class}}' ) );

// phpcs:disable WordPress.Security.EscapeOutput.OutputNotEscaped -- get_block_wrapper_attributes() returns pre-escaped markup.
?>
<div <?php echo $wrapper_attributes; ?>>
{{attribute_output}}
</div>
<?php
// phpcs:enable WordPress.Security.EscapeOutput.OutputNotEscaped
