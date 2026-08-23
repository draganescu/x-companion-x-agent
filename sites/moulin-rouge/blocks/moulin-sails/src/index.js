/**
 * Editor entry point for `agent/moulin-sails`.
 *
 * The block is DYNAMIC: `save` returns null, so post content only ever holds the
 * block comment plus its attributes, and render.php produces the markup. Never
 * change `save` to emit HTML — a static block freezes its output into every post
 * that already uses it.
 */
import { registerBlockType } from '@wordpress/blocks';

import Edit from './edit';

registerBlockType( 'agent/moulin-sails', {
	edit: Edit,
	save: () => null,
} );
