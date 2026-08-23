/**
 * Front-end behavior for agent/cancan-stats — the 'view-script' rung.
 *
 * Progressive enhancement only: the final numbers are already rendered by
 * render.php, so the block is correct without this file. This file adds the
 * count-up: an IntersectionObserver starts a requestAnimationFrame ramp from
 * 0 to each value over data-duration-ms with an ease-out curve, once per page
 * view, skipped when the visitor prefers reduced motion.
 */
( function () {
	'use strict';

	var reducedMotion = window.matchMedia && window.matchMedia( '(prefers-reduced-motion: reduce)' ).matches;

	function formatLike( value, isYear ) {
		if ( isYear ) {
			return String( Math.round( value ) );
		}
		return Math.round( value ).toLocaleString();
	}

	function countUp( el, durationMs ) {
		var target = parseFloat( el.dataset.value || '0' );
		if ( ! isFinite( target ) ) {
			return;
		}
		var isYear = target >= 1000 && target <= 2100 && target === Math.floor( target );
		var start = null;
		function frame( ts ) {
			if ( null === start ) {
				start = ts;
			}
			var t = Math.min( ( ts - start ) / durationMs, 1 );
			var eased = 1 - Math.pow( 1 - t, 3 );
			el.textContent = formatLike( target * eased, isYear );
			if ( t < 1 ) {
				window.requestAnimationFrame( frame );
			} else {
				el.textContent = formatLike( target, isYear );
			}
		}
		window.requestAnimationFrame( frame );
	}

	function enhance( el ) {
		// Marker asserted by wp_block_build_test's front smoke. Keep it.
		el.dataset.xAgentView = 'ready';

		if ( reducedMotion || ! ( 'IntersectionObserver' in window ) ) {
			return;
		}

		var durationMs = parseInt( el.dataset.durationMs || '1600', 10 );
		var done = false;
		var observer = new IntersectionObserver( function ( entries ) {
			entries.forEach( function ( entry ) {
				if ( entry.isIntersecting && ! done ) {
					done = true;
					el.querySelectorAll( '.mr-stat__number' ).forEach( function ( num ) {
						countUp( num, durationMs );
					} );
					observer.disconnect();
				}
			} );
		}, { threshold: 0.35 } );
		observer.observe( el );
	}

	function boot() {
		document.querySelectorAll( '.wp-block-agent-cancan-stats' ).forEach( enhance );
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', boot );
	} else {
		boot();
	}
} )();
