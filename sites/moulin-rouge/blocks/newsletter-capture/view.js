/**
 * Front-end behavior for agent/newsletter-capture — the 'view-script' rung.
 *
 * Progressive enhancement: the form is a real POST to the subscribe route and
 * works without this file. This file upgrades it to fetch-in-place, and in
 * exit mode arms the back-button trap: a history sentinel is pushed on load,
 * popstate opens the <dialog> once per session, and every way out of the
 * dialog (decline, Escape/cancel, or a completed signup) really leaves via
 * history.back().
 */
( function () {
	'use strict';

	var SHOWN_KEY = 'mrExitShown';
	var SUBSCRIBED_KEY = 'mrSubscribed';

	function submitOverFetch( form, onSuccess ) {
		var block = form.closest( '.wp-block-agent-newsletter-capture' );
		var error = block.querySelector( '.mr-capture__error' );
		var success = block.querySelector( '.mr-capture__success' );

		form.addEventListener( 'submit', function ( event ) {
			event.preventDefault();
			error.hidden = true;
			var button = form.querySelector( '.mr-capture__submit' );
			button.disabled = true;
			window.fetch( form.action, { method: 'POST', body: new FormData( form ) } )
				.then( function ( res ) {
					return res.json().then( function ( body ) {
						return { ok: res.ok, body: body };
					} );
				} )
				.then( function ( result ) {
					if ( result.ok ) {
						try {
							window.sessionStorage.setItem( SUBSCRIBED_KEY, '1' );
						} catch ( e ) { /* storage unavailable */ }
						form.hidden = true;
						success.hidden = false;
						if ( onSuccess ) {
							onSuccess();
						}
					} else {
						error.textContent = ( result.body && result.body.message ) || 'Something went wrong. Please try again.';
						error.hidden = false;
						button.disabled = false;
					}
				} )
				.catch( function () {
					error.textContent = 'Something went wrong. Please try again.';
					error.hidden = false;
					button.disabled = false;
				} );
		} );
	}

	function armExitTrap( el ) {
		var dialog = el.querySelector( '.mr-capture__dialog' );
		if ( ! dialog || 'function' !== typeof dialog.showModal ) {
			return;
		}

		var alreadyShown = false;
		var subscribed = false;
		try {
			alreadyShown = '1' === window.sessionStorage.getItem( SHOWN_KEY );
			subscribed = '1' === window.sessionStorage.getItem( SUBSCRIBED_KEY );
		} catch ( e ) { /* storage unavailable */ }
		if ( alreadyShown || subscribed ) {
			return;
		}

		// The sentinel: one extra history entry. The visitor's first Back pops
		// it (staying on this page) and we ask once; every later Back leaves.
		window.history.pushState( { mrSentinel: true }, '', window.location.href );

		var opened = false;
		window.addEventListener( 'popstate', function () {
			if ( opened || dialog.open ) {
				return;
			}
			opened = true;
			try {
				window.sessionStorage.setItem( SHOWN_KEY, '1' );
			} catch ( e ) { /* storage unavailable */ }
			dialog.showModal();
		} );

		var leave = function () {
			if ( dialog.open ) {
				dialog.close();
			}
			window.history.back();
		};

		var decline = dialog.querySelector( '.mr-capture__decline' );
		if ( decline ) {
			decline.addEventListener( 'click', leave );
		}
		dialog.addEventListener( 'cancel', function ( event ) {
			event.preventDefault();
			leave();
		} );

		var form = dialog.querySelector( '.mr-capture__form' );
		if ( form ) {
			submitOverFetch( form, function () {
				window.setTimeout( leave, 1400 );
			} );
		}
	}

	function enhance( el ) {
		// Marker asserted by wp_block_build_test's front smoke. Keep it.
		el.dataset.xAgentView = 'ready';

		if ( 'exit' === el.dataset.mode ) {
			armExitTrap( el );
			return;
		}

		var form = el.querySelector( '.mr-capture__form' );
		if ( form ) {
			submitOverFetch( form, null );
		}
	}

	function boot() {
		document.querySelectorAll( '.wp-block-agent-newsletter-capture' ).forEach( enhance );
	}

	if ( 'loading' === document.readyState ) {
		document.addEventListener( 'DOMContentLoaded', boot );
	} else {
		boot();
	}
} )();
