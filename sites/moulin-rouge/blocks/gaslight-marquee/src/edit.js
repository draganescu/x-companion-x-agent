/**
 * Editor UI for `agent/gaslight-marquee` — Scrolling ribbon.
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
import { useBlockProps, InspectorControls } from '@wordpress/block-editor';
import { PanelBody, TextControl, TextareaControl } from '@wordpress/components';

export default function Edit( { attributes, setAttributes } ) {
	const blockProps = useBlockProps();

	return (
		<>
			<InspectorControls>
				<PanelBody
					title={ __( 'Settings', 'agent-gaslight-marquee' ) }
					initialOpen={ true }
				>
					<TextareaControl
						label={ __( "Lines in the ribbon", "agent-gaslight-marquee" ) }
						help={ __( "One phrase per line. They repeat in an endless loop with a star between them.", "agent-gaslight-marquee" ) }
						value={ ( attributes.phrases ?? [] ).join( '\n' ) }
						onChange={ ( value ) => setAttributes( { phrases: value.split( '\n' ) } ) }
					/>
					<TextControl
						type="number"
						label={ __( "Glide time (seconds)", "agent-gaslight-marquee" ) }
						help={ __( "How long one full pass takes. Larger is slower. Visitors who prefer reduced motion see the ribbon still.", "agent-gaslight-marquee" ) }
						value={ attributes.speed_seconds }
						onChange={ ( value ) => setAttributes( { speed_seconds: value === '' ? undefined : Number( value ) } ) }
					/>
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
				<ServerSideRender
					block="agent/gaslight-marquee"
					attributes={ attributes }
					httpMethod="post"
					skipBlockSupportAttributes
				/>
			</div>
		</>
	);
}
