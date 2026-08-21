/**
 * x-companion harness — the Tree IR compiler. CONTRACT.md §6.
 *
 * Vanilla ES5-ish, no build step, no bundler. Exposes exactly four globals:
 * __version, __ready, __registry(), __compile(). Everything else is private.
 */
( function ( window ) {
	'use strict';

	window.__version = '1';

	function message( e ) {
		return ( e && e.message ) ? String( e.message ) : String( e );
	}

	/** wp-block-library ships core blocks but does not self-register them; the editor calls this. */
	function registerCoreBlocks() {
		var wp = window.wp;
		if ( ! wp || ! wp.blocks || ! wp.blockLibrary ) { return; }
		if ( wp.blocks.getBlockType( 'core/paragraph' ) ) { return; }
		if ( typeof wp.blockLibrary.registerCoreBlocks === 'function' ) {
			wp.blockLibrary.registerCoreBlocks();
		}
	}

	window.__ready = new Promise( function ( resolve ) {
		function settle() {
			try { registerCoreBlocks(); } catch ( e ) { window.__ready_error = message( e ); }
			// One tick, so block scripts that register from their own domReady have run.
			window.setTimeout( resolve, 0 );
		}
		if ( 'loading' === document.readyState ) {
			document.addEventListener( 'DOMContentLoaded', settle );
		} else {
			settle();
		}
	} );

	window.__registry = function () {
		if ( ! window.wp || ! window.wp.blocks ) { return []; }
		return window.wp.blocks.getBlockTypes().map( function ( type ) { return type.name; } );
	};

	/** createBlock applies defaults and sanitises attributes; recurse depth-first. */
	function create( node ) {
		if ( ! node || 'string' !== typeof node.name ) {
			throw new Error( 'every BlockNode needs a string "name"' );
		}
		// An unregistered name is not an error inside wp.blocks: createBlock
		// accepts it and serialize() then emits NOTHING for that subtree, so the
		// caller would get all_valid:true and silently missing content. Refuse.
		if ( ! window.wp.blocks.getBlockType( node.name ) ) {
			throw new Error( 'block "' + node.name + '" is not registered in this harness; it would serialize to nothing' );
		}
		var inner = ( node.innerBlocks || [] ).map( create );
		return window.wp.blocks.createBlock( node.name, node.attributes || {}, inner );
	}

	/** validationIssues carry a logger function; flatten to JSON-safe strings. */
	function issues( raw ) {
		if ( ! Array.isArray( raw ) ) { return []; }
		return raw.map( function ( issue ) {
			var args = ( issue && Array.isArray( issue.args ) ) ? issue.args : [];
			return args.map( function ( arg ) {
				if ( 'string' === typeof arg ) { return arg; }
				try { return JSON.stringify( arg ); } catch ( e ) { return String( arg ); }
			} );
		} );
	}

	/** RFC 6901 pointer rooted at the array passed to __compile: /0/innerBlocks/2 */
	function walk( blocks, prefix, out ) {
		blocks.forEach( function ( block, index ) {
			var path = prefix + '/' + index;
			if ( false === block.isValid ) {
				out.push( { path: path, name: block.name, validation_issues: issues( block.validationIssues ) } );
			}
			if ( block.innerBlocks && block.innerBlocks.length ) {
				walk( block.innerBlocks, path + '/innerBlocks', out );
			}
		} );
	}

	window.__compile = function ( blocks ) {
		try {
			if ( ! window.wp || ! window.wp.blocks ) {
				throw new Error( 'wp.blocks is not available on this page' );
			}
			if ( ! Array.isArray( blocks ) ) {
				throw new Error( '__compile expects TreeIR.blocks (an array of BlockNode), got ' + typeof blocks );
			}
			var markup = window.wp.blocks.serialize( blocks.map( create ) );
			var invalid = [];
			walk( window.wp.blocks.parse( markup ), '', invalid );
			return { markup: markup, all_valid: 0 === invalid.length, invalid: invalid };
		} catch ( e ) {
			return { error: message( e ) };
		}
	};
}( window ) );
