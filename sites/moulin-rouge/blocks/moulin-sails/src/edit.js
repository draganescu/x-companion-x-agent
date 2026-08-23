/**
 * Editor UI for `agent/moulin-sails` — Windmill hero.
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
					title={ __( 'Settings', 'agent-moulin-sails' ) }
					initialOpen={ true }
				>
					<TextControl
						label={ __( "Small line above the title", "agent-moulin-sails" ) }
						help={ __( "A short introductory line shown in small capitals above the main title.", "agent-moulin-sails" ) }
						value={ attributes.kicker }
						onChange={ ( value ) => setAttributes( { kicker: value } ) }
					/>
					<TextControl
						label={ __( "Main title", "agent-moulin-sails" ) }
						value={ attributes.heading }
						onChange={ ( value ) => setAttributes( { heading: value } ) }
					/>
					<TextareaControl
						label={ __( "Tagline", "agent-moulin-sails" ) }
						help={ __( "One or two sentences under the title.", "agent-moulin-sails" ) }
						value={ attributes.tagline }
						onChange={ ( value ) => setAttributes( { tagline: value } ) }
					/>
					<TextControl
						type="number"
						label={ __( "Sail rotation (seconds per turn)", "agent-moulin-sails" ) }
						help={ __( "How long one full turn of the sails takes. Visitors who prefer reduced motion see the sails still.", "agent-moulin-sails" ) }
						value={ attributes.spin_seconds }
						onChange={ ( value ) => setAttributes( { spin_seconds: value === '' ? undefined : Number( value ) } ) }
					/>
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
				<ServerSideRender
					block="agent/moulin-sails"
					attributes={ attributes }
					httpMethod="post"
					skipBlockSupportAttributes
				/>
			</div>
		</>
	);
}
