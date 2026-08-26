/**
 * Editor UI for `agent/{{slug}}` — {{title}}.
 *
 * THE EDITOR CONTRACT — the canvas is the front end.
 *
 * The canvas previews the block through ServerSideRender: what the editor
 * shows IS render.php's output, by construction, and cannot drift as
 * render.php evolves. Every setting lives in the InspectorControls sidebar.
 *
 * Labels and help text are for the site editor: plain language about what
 * the reader sees. Never toolchain or implementation vocabulary.
 *
 * This file is vanilla JavaScript against the wp.* globals and ships exactly
 * as written — there is no build step. edit.asset.php beside it names the
 * script handles WordPress loads first.
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
( function ( wp ) {
	'use strict';

	const { registerBlockType } = wp.blocks;
	const { createElement: el, Fragment } = wp.element;
	const { __ } = wp.i18n;
	const ServerSideRender = wp.serverSideRender;
{{editor_globals}}
{{editor_helpers}}
	function Edit( { attributes, setAttributes } ) {
		const blockProps = useBlockProps();

		return el(
			Fragment,
			null,
			el( InspectorControls, null, el(
				PanelBody,
				{ title: __( 'Settings', '{{textdomain}}' ), initialOpen: true },
{{inspector_controls}}
			) ),
			el(
				'div',
				blockProps,
				el( ServerSideRender, {
					block: 'agent/{{slug}}',
					attributes: attributes,
					httpMethod: 'post',
					skipBlockSupportAttributes: true,
				} )
			)
		);
	}

	// The block is DYNAMIC: `save` returns null, so post content only ever
	// holds the block comment plus its attributes, and render.php produces the
	// markup. Never change `save` to emit HTML — a static block freezes its
	// output into every post that already uses it.
	registerBlockType( 'agent/{{slug}}', {
		edit: Edit,
		save: () => null,
	} );
} )( window.wp );
