/**
 * Editor UI for `agent/{{slug}}` — {{title}}.
 *
 * The block-editing contract is a 1:1 canvas: text attributes are edited
 * INLINE on the canvas via RichText (plain text, no formats), exactly where
 * the front end will show them; only non-text attributes (numbers, toggles,
 * selects) live in the InspectorControls sidebar. When implementing
 * render.php, shape this canvas into the same structure, classes and inline
 * styles — the two files are one design in two languages. Note: RichText
 * stores entity-encoded text, so render.php must output those attributes
 * through `wp_kses( $value, array() )`, not `esc_html()`.
 */
import { __ } from '@wordpress/i18n';
import { useBlockProps, InspectorControls, RichText } from '@wordpress/block-editor';
import {
	PanelBody,
	TextControl,
	TextareaControl,
	ToggleControl,
	SelectControl,
} from '@wordpress/components';

export default function Edit( { attributes, setAttributes } ) {
	const blockProps = useBlockProps( { className: '{{css_class}}' } );

	return (
		<>
			<InspectorControls>
				<PanelBody
					title={ __( '{{title}}', '{{textdomain}}' ) }
					initialOpen={ true }
				>
{{inspector_controls}}
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
{{editor_preview}}
			</div>
		</>
	);
}
