/* A save()-based block: its markup is frozen into post content, which is exactly
   what the install policy refuses unless X_COMPANION_ALLOW_STATIC_BLOCKS is on. */
( function ( wp ) {
	wp.blocks.registerBlockType( 'agent/static-card', {
		edit: function () { return null; },
		save: function ( props ) {
			return wp.element.createElement( 'div', { className: 'agent-static-card' }, props.attributes.heading );
		}
	} );
}( window.wp ) );
