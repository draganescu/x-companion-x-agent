/**
 * Editor UI for `agent/newsletter-capture` — Newsletter signup.
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
import { PanelBody, TextControl, TextareaControl, SelectControl } from '@wordpress/components';

export default function Edit( { attributes, setAttributes } ) {
	const blockProps = useBlockProps();

	return (
		<>
			<InspectorControls>
				<PanelBody
					title={ __( 'Settings', 'agent-newsletter-capture' ) }
					initialOpen={ true }
				>
					<SelectControl
						label={ __( "Where it appears", "agent-newsletter-capture" ) }
						help={ __( "“In the page” shows the form where you place this block. “Popup” stays invisible until the visitor presses Back to leave, then asks once.", "agent-newsletter-capture" ) }
						value={ attributes.mode }
						options={ [ { label: __( "In the page", "agent-newsletter-capture" ), value: "inline" }, { label: __( "Popup when the visitor leaves", "agent-newsletter-capture" ), value: "exit" } ] }
						onChange={ ( value ) => setAttributes( { mode: value } ) }
					/>
					<TextControl
						label={ __( "Title", "agent-newsletter-capture" ) }
						value={ attributes.heading }
						onChange={ ( value ) => setAttributes( { heading: value } ) }
					/>
					<TextareaControl
						label={ __( "Message", "agent-newsletter-capture" ) }
						value={ attributes.message }
						onChange={ ( value ) => setAttributes( { message: value } ) }
					/>
					<TextControl
						label={ __( "Email field hint", "agent-newsletter-capture" ) }
						value={ attributes.placeholder }
						onChange={ ( value ) => setAttributes( { placeholder: value } ) }
					/>
					<TextControl
						label={ __( "Button text", "agent-newsletter-capture" ) }
						value={ attributes.button_label }
						onChange={ ( value ) => setAttributes( { button_label: value } ) }
					/>
					<TextControl
						label={ __( "Thank-you message", "agent-newsletter-capture" ) }
						help={ __( "Shown after a successful signup.", "agent-newsletter-capture" ) }
						value={ attributes.success_message }
						onChange={ ( value ) => setAttributes( { success_message: value } ) }
					/>
					<TextControl
						label={ __( "Decline link text", "agent-newsletter-capture" ) }
						help={ __( "Only used by the popup: the link that lets the visitor leave without signing up.", "agent-newsletter-capture" ) }
						value={ attributes.decline_label }
						onChange={ ( value ) => setAttributes( { decline_label: value } ) }
					/>
				</PanelBody>
			</InspectorControls>
			<div { ...blockProps }>
				<ServerSideRender
					block="agent/newsletter-capture"
					attributes={ attributes }
					httpMethod="post"
					skipBlockSupportAttributes
				/>
			</div>
		</>
	);
}
