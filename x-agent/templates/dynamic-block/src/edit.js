/**
 * Editor UI for `agent/{{slug}}` — {{title}}.
 *
 * Deliberately minimal: `useBlockProps()` on the preview wrapper and one
 * `InspectorControls` panel holding a control per declared attribute. The
 * canvas preview is an approximation; render.php is the source of truth.
 */
import { __ } from '@wordpress/i18n';
import { useBlockProps, InspectorControls } from '@wordpress/block-editor';
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
