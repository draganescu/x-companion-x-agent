/**
 * Editor UI for `agent/{{slug}}` — {{title}}.
 *
 * THE EDITOR CONTRACT — the canvas is the front end.
 *
 * The canvas previews the block through <ServerSideRender>: what the editor
 * shows IS render.php's output, by construction, and cannot drift as
 * render.php evolves. Every setting lives in the InspectorControls sidebar.
 *
 * Labels and help text are for the site editor: plain language about what
 * the reader sees. Never toolchain or implementation vocabulary.
 *
 * Two finishing obligations before this block is installed:
 *   - If part of the render is invisible on the front by default (a closed
 *     modal, a success state), branch render.php on `$is_editor_preview`
 *     so the canvas shows it — see render.php's header.
 *   - A structured attribute (array/object) scaffolds with
 *     StructuredFallbackControl, a raw-JSON textarea. Replace it with a
 *     purpose-built control (one field per property, add/remove rows);
 *     shipping raw JSON to a site editor is a defect.
 */
import { __ } from '@wordpress/i18n';
import ServerSideRender from '@wordpress/server-side-render';
{{editor_imports}}
{{editor_helpers}}
export default function Edit( { attributes, setAttributes } ) {
	const blockProps = useBlockProps();

	return (
		<>
			<InspectorControls>
				<PanelBody
					title={ __( 'Settings', '{{textdomain}}' ) }
					initialOpen={ true }
				>
{{inspector_controls}}
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
				<ServerSideRender
					block="agent/{{slug}}"
					attributes={ attributes }
					httpMethod="post"
					skipBlockSupportAttributes
				/>
			</div>
		</>
	);
}
