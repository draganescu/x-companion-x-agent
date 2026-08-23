<?php
/**
 * The agent block library, against a live WordPress.
 *
 *   node tools/playground/boot.mjs --profile core-only --posture toolchain --plugin ./x-companion
 *   php x-companion/tests/test-install.php --runtime tools/.runtime/core-only-toolchain.json
 *
 * Unlike test-manifest.php and test-validator.php this suite is *not* runnable
 * offline: install, rollback and delete are filesystem-and-registry behaviour,
 * and the only honest oracle for them is a real instance. It talks to that
 * instance over the same wire the agent uses — HTTP Basic with an application
 * password — so what it proves is the contract, not the internals.
 *
 * The zip fixtures come from fixtures/packages/build.sh; this file refuses to
 * run rather than guess if they have not been built.
 *
 * @package x-companion
 */

require_once __DIR__ . '/bootstrap-lite.php';

/*
 * ---------------------------------------------------------------------------
 * A REST client, sized for a test file
 * ---------------------------------------------------------------------------
 *
 * Duplicated verbatim in test-tokens.php and guarded, so either file can be run
 * on its own without a shared include that neither of them owns.
 */

if ( ! function_exists( 'x_live_runtime' ) ) {

	/**
	 * The runtime descriptor written by tools/playground/boot.mjs.
	 *
	 * Resolution order: --runtime <path>, $X_RUNTIME, then the default
	 * core-only/toolchain slot.
	 *
	 * @return array
	 */
	function x_live_runtime(): array {
		$path = getenv( 'X_RUNTIME' ) ?: '';

		$argv = isset( $GLOBALS['argv'] ) ? (array) $GLOBALS['argv'] : array();
		foreach ( $argv as $index => $argument ) {
			if ( '--runtime' === $argument && isset( $argv[ $index + 1 ] ) ) {
				$path = (string) $argv[ $index + 1 ];
			}
		}

		if ( '' === $path ) {
			$path = dirname( __DIR__, 2 ) . '/tools/.runtime/core-only-toolchain.json';
		}

		if ( ! file_exists( $path ) ) {
			fwrite( STDERR, "No runtime descriptor at {$path}.\nBoot one first:\n  node tools/playground/boot.mjs --profile core-only --posture toolchain --plugin ./x-companion\n" );
			exit( 2 );
		}

		$runtime = json_decode( (string) file_get_contents( $path ), true );

		if ( ! is_array( $runtime ) || empty( $runtime['url'] ) ) {
			fwrite( STDERR, "Runtime descriptor at {$path} is not usable.\n" );
			exit( 2 );
		}

		$runtime['__path'] = $path;

		return $runtime;
	}

	/**
	 * One authenticated REST call, with the pretty -> ?rest_route= fallback the
	 * contract requires of every client.
	 *
	 * @param string $method  HTTP method.
	 * @param string $route   Route below the site root, e.g. /x-companion/v1/manifest.
	 * @param array  $options as: admin|agent|anon, body: array, upload: path, raw: bool.
	 * @return array { status, json, body, headers }
	 */
	function x_call( string $method, string $route, array $options = array() ): array {
		static $runtime = null;

		if ( null === $runtime ) {
			$runtime = x_live_runtime();
		}

		$base      = rtrim( (string) $runtime['url'], '/' );
		$candidate = $base . '/wp-json' . $route;
		$fallback  = $base . '/?rest_route=' . rawurlencode( $route );
		$fallback  = str_replace( '%2F', '/', $fallback );

		$response = x_curl( $method, $candidate, $options, $runtime );

		$looks_missing = 404 === $response['status'] && ( ! is_array( $response['json'] ) || 'rest_no_route' !== ( $response['json']['code'] ?? '' ) );

		if ( $looks_missing || ( $response['status'] >= 300 && $response['status'] < 400 ) ) {
			$response = x_curl( $method, $fallback, $options, $runtime );
		}

		return $response;
	}

	/**
	 * The curl half of x_call().
	 *
	 * @param string $method  HTTP method.
	 * @param string $url     Absolute URL.
	 * @param array  $options Options, see x_call().
	 * @param array  $runtime Runtime descriptor.
	 * @return array
	 */
	function x_curl( string $method, string $url, array $options, array $runtime ): array {
		$handle = curl_init();

		$headers = array( 'Accept: application/json, text/html;q=0.8, */*;q=0.5' );
		$as      = (string) ( $options['as'] ?? 'admin' );

		if ( 'anon' !== $as && isset( $runtime[ $as ]['user'] ) ) {
			$headers[] = 'Authorization: Basic ' . base64_encode( $runtime[ $as ]['user'] . ':' . $runtime[ $as ]['app_password'] );
		}

		curl_setopt( $handle, CURLOPT_URL, $url );
		curl_setopt( $handle, CURLOPT_CUSTOMREQUEST, strtoupper( $method ) );
		curl_setopt( $handle, CURLOPT_RETURNTRANSFER, true );
		curl_setopt( $handle, CURLOPT_HEADER, true );
		curl_setopt( $handle, CURLOPT_FOLLOWLOCATION, false );
		curl_setopt( $handle, CURLOPT_TIMEOUT, 120 );

		if ( isset( $options['upload'] ) ) {
			curl_setopt(
				$handle,
				CURLOPT_POSTFIELDS,
				array( 'package' => new CURLFile( (string) $options['upload'], 'application/zip', basename( (string) $options['upload'] ) ) )
			);
		} elseif ( array_key_exists( 'body', $options ) ) {
			$headers[] = 'Content-Type: application/json';
			curl_setopt( $handle, CURLOPT_POSTFIELDS, (string) wp_json_encode( $options['body'] ) );
		}

		curl_setopt( $handle, CURLOPT_HTTPHEADER, $headers );

		$raw    = (string) curl_exec( $handle );
		$status = (int) curl_getinfo( $handle, CURLINFO_RESPONSE_CODE );
		$split  = (int) curl_getinfo( $handle, CURLINFO_HEADER_SIZE );
		$error  = curl_error( $handle );

		curl_close( $handle );

		if ( 0 === $status ) {
			fwrite( STDERR, "curl failed for {$url}: {$error}\n" );
			exit( 2 );
		}

		$head = substr( $raw, 0, $split );
		$body = substr( $raw, $split );

		$parsed = array();
		foreach ( explode( "\n", str_replace( "\r\n", "\n", $head ) ) as $line ) {
			if ( false !== strpos( $line, ':' ) ) {
				list( $key, $value ) = explode( ':', $line, 2 );
				$parsed[ strtolower( trim( $key ) ) ] = trim( $value );
			}
		}

		return array(
			'status'  => $status,
			'json'    => json_decode( $body, true ),
			'body'    => $body,
			'headers' => $parsed,
		);
	}

	/**
	 * Short renderer for failure messages.
	 *
	 * @param array $response x_call() result.
	 * @return string
	 */
	function x_show( array $response ): string {
		return 'HTTP ' . $response['status'] . ' ' . substr( $response['body'], 0, 400 );
	}
}

/**
 * Slugs currently in the library.
 *
 * The instance may be shared with another suite, so nothing here indexes the
 * listing positionally or assumes the library holds only our block.
 *
 * @return string[]
 */
function x_library_slugs(): array {
	$slugs = array();

	foreach ( (array) ( x_call( 'GET', '/x-companion/v1/blocks/library' )['json'] ?? array() ) as $entry ) {
		$slugs[] = (string) ( $entry['slug'] ?? '' );
	}

	sort( $slugs );

	return $slugs;
}

/**
 * One library entry by slug.
 *
 * @param string $slug Slug.
 * @return array|null
 */
function x_library_entry( string $slug ): ?array {
	foreach ( (array) ( x_call( 'GET', '/x-companion/v1/blocks/library' )['json'] ?? array() ) as $entry ) {
		if ( $slug === ( $entry['slug'] ?? '' ) ) {
			return $entry;
		}
	}

	return null;
}

/*
 * ---------------------------------------------------------------------------
 * Fixtures
 * ---------------------------------------------------------------------------
 */

$packages = dirname( __DIR__ ) . '/fixtures/packages';

foreach ( array( 'agent-testimonial', 'agent-testimonial-v2', 'agent-testimonial-flat', 'agent-static-card', 'agent-traversal', 'wrong-namespace', 'agent-no-main' ) as $needed ) {
	if ( ! file_exists( $packages . '/' . $needed . '.zip' ) ) {
		fwrite( STDERR, "Missing fixture zips; run: bash x-companion/fixtures/packages/build.sh\n" );
		exit( 2 );
	}
}

$runtime = x_live_runtime();

x_suite( 'block library (live: ' . ( $runtime['profile'] ?? '?' ) . '/' . ( $runtime['posture'] ?? '?' ) . ')' );

/*
 * Start from a clean library: a previous run may have left the block behind.
 */
$existing = x_call( 'GET', '/x-companion/v1/blocks/library' );

foreach ( (array) ( $existing['json'] ?? array() ) as $installed ) {
	if ( 'testimonial' === ( $installed['slug'] ?? '' ) ) {
		x_call( 'DELETE', '/x-companion/v1/blocks/library/testimonial' );
	}
}

$render_body = array( 'markup' => '<!-- wp:agent/testimonial {"quote":"q"} /-->' );

/*
 * ---------------------------------------------------------------------------
 * Install
 * ---------------------------------------------------------------------------
 */

$fingerprint_before = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );
$install            = x_call( 'POST', '/x-companion/v1/blocks/install', array( 'upload' => $packages . '/agent-testimonial.zip' ) );

x_test(
	'POST /blocks/install accepts a valid dynamic package',
	function () use ( $install ) {
		x_assert( 200 === $install['status'], 'expected 200, got ' . x_show( $install ) );
		x_assert_same(
			array(
				'slug'    => 'testimonial',
				'name'    => 'agent/testimonial',
				'version' => '1.0.0',
			),
			$install['json']['installed'] ?? null,
			'installed descriptor'
		);
		x_assert_same( false, $install['json']['replaced_previous'] ?? null, 'nothing was replaced on a first install' );
	}
);

x_test(
	'the install response carries the new epoch, and GET /fingerprint agrees',
	function () use ( $install, $fingerprint_before ) {
		$returned = (string) ( $install['json']['fingerprint'] ?? '' );

		x_assert( 64 === strlen( $returned ), 'fingerprint is 64 hex characters, got "' . $returned . '"' );
		x_assert( $returned !== $fingerprint_before, 'the fingerprint must move when the registry gains a block' );

		$live = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );
		x_assert_same( $returned, $live, 'the epoch handed back by install is the epoch the next request serves' );
	}
);

x_test(
	'the installed block renders through POST /render',
	function () use ( $render_body ) {
		$render = x_call( 'POST', '/x-companion/v1/render', array( 'body' => $render_body ) );

		x_assert( 200 === $render['status'], 'expected 200, got ' . x_show( $render ) );

		$html = (string) ( $render['json']['html'] ?? '' );
		x_assert( false !== strpos( $html, 'data-agent="testimonial-v1"' ), 'render.php from the package produced the markup: ' . substr( $html, 0, 200 ) );
		x_assert( false !== strpos( $html, '<blockquote class="agent-testimonial__quote">q</blockquote>' ), 'the quote attribute reached the template escaped: ' . substr( $html, 0, 200 ) );
	}
);

x_test(
	'the installed block appears in GET /manifest as a dynamic block',
	function () {
		$manifest = x_call( 'GET', '/x-companion/v1/manifest' );

		x_assert( 200 === $manifest['status'], 'expected 200, got ' . x_show( $manifest ) );

		$block = $manifest['json']['blocks']['agent/testimonial'] ?? null;

		x_assert( is_array( $block ), 'agent/testimonial is missing from the manifest' );
		x_assert_same( true, $block['is_dynamic'] ?? null, 'a block with a render entry is dynamic' );
		x_assert( isset( $block['attributes']['quote'] ), 'the declared attributes came through' );
		x_assert( isset( $block['attributes']['align'] ), 'supports-derived attributes were injected too' );
	}
);

x_test(
	'GET /blocks/library lists it with no rollback available yet',
	function () {
		$library = x_call( 'GET', '/x-companion/v1/blocks/library' );

		x_assert( 200 === $library['status'], 'expected 200, got ' . x_show( $library ) );

		$entry = x_library_entry( 'testimonial' );

		x_assert( is_array( $entry ), 'testimonial is missing from the library listing' );
		x_assert_same( 'agent/testimonial', $entry['name'] ?? null, 'name' );
		x_assert_same( '1.0.0', $entry['version'] ?? null, 'version' );
		x_assert_same( false, $entry['has_prev'] ?? null, 'has_prev' );
		x_assert( ! empty( $entry['installed_at'] ), 'installed_at is recorded' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * Policy
 * ---------------------------------------------------------------------------
 */

$library_before_policy = x_library_slugs();

$policy_cases = array(
	'a static package (no render entry)'      => array( 'agent-static-card.zip', 'render' ),
	'a package with a ../ zip entry'          => array( 'agent-traversal.zip', 'unsafe zip entries' ),
	'a package outside the namespace'         => array( 'wrong-namespace.zip', 'must match agent/' ),
	'a flat package (not a plugin directory)' => array( 'agent-testimonial-flat.zip', 'plugin directory' ),
	'a package without a plugin main file'    => array( 'agent-no-main.zip', 'plugin main file' ),
);

foreach ( $policy_cases as $label => $case ) {
	list( $zip, $needle ) = $case;

	x_test(
		'POST /blocks/install refuses ' . $label . ' with 422 block_policy',
		function () use ( $packages, $zip, $needle ) {
			$response = x_call( 'POST', '/x-companion/v1/blocks/install', array( 'upload' => $packages . '/' . $zip ) );

			x_assert( 422 === $response['status'], 'expected 422, got ' . x_show( $response ) );
			x_assert_same( 'block_policy', $response['json']['code'] ?? null, 'error code' );

			$reasons = (array) ( $response['json']['data']['reasons'] ?? array() );
			x_assert( ! empty( $reasons ), 'data.reasons must be a non-empty string[]' );

			$hit = false;
			foreach ( $reasons as $reason ) {
				$hit = $hit || false !== strpos( (string) $reason, $needle );
			}

			x_assert( $hit, 'no reason mentioned "' . $needle . '": ' . wp_json_encode( $reasons ) );
		}
	);
}

x_test(
	'a refused package leaves the library untouched',
	function () use ( $library_before_policy ) {
		x_assert_same( $library_before_policy, x_library_slugs(), 'no refused package reached the library' );
		x_assert( in_array( 'testimonial', $library_before_policy, true ), 'the package that passed policy is installed' );
		x_assert( ! in_array( 'static-card', $library_before_policy, true ), 'the static package was not installed' );
		x_assert( ! in_array( 'traversal', $library_before_policy, true ), 'the traversal package was not installed' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * Replace, roll back
 * ---------------------------------------------------------------------------
 */

$replace = x_call( 'POST', '/x-companion/v1/blocks/install', array( 'upload' => $packages . '/agent-testimonial-v2.zip' ) );

x_test(
	'a second install of the same slug moves the old version aside',
	function () use ( $replace ) {
		x_assert( 200 === $replace['status'], 'expected 200, got ' . x_show( $replace ) );
		x_assert_same( true, $replace['json']['replaced_previous'] ?? null, 'replaced_previous' );
		x_assert_same( '2.0.0', $replace['json']['installed']['version'] ?? null, 'the new version is live' );

		x_assert_same( true, x_library_entry( 'testimonial' )['has_prev'] ?? null, 'has_prev flips once a .prev exists' );
	}
);

x_test(
	'the replacement is what renders now',
	function () use ( $render_body ) {
		$html = (string) ( x_call( 'POST', '/x-companion/v1/render', array( 'body' => $render_body ) )['json']['html'] ?? '' );

		x_assert( false !== strpos( $html, 'data-agent="testimonial-v2"' ), 'expected v2 markup, got ' . substr( $html, 0, 200 ) );
	}
);

x_test(
	'rollback restores the previous render output',
	function () use ( $render_body ) {
		$rollback = x_call( 'POST', '/x-companion/v1/blocks/library/testimonial/rollback' );

		x_assert( 200 === $rollback['status'], 'expected 200, got ' . x_show( $rollback ) );
		x_assert( 64 === strlen( (string) ( $rollback['json']['fingerprint'] ?? '' ) ), 'rollback returns an epoch' );

		$html = (string) ( x_call( 'POST', '/x-companion/v1/render', array( 'body' => $render_body ) )['json']['html'] ?? '' );
		x_assert( false !== strpos( $html, 'data-agent="testimonial-v1"' ), 'expected v1 markup back, got ' . substr( $html, 0, 200 ) );

		$entry = x_library_entry( 'testimonial' );
		x_assert_same( '1.0.0', $entry['version'] ?? null, 'the listing reports the restored version' );
		x_assert_same( false, $entry['has_prev'] ?? null, 'rollback is single level, so nothing is left to roll back to' );
	}
);

x_test(
	'a second rollback is 409 no_previous',
	function () {
		$response = x_call( 'POST', '/x-companion/v1/blocks/library/testimonial/rollback' );

		x_assert( 409 === $response['status'], 'expected 409, got ' . x_show( $response ) );
		x_assert_same( 'no_previous', $response['json']['code'] ?? null, 'error code' );
	}
);

x_test(
	'an unknown slug is 404 not_found on rollback and delete',
	function () {
		foreach ( array( array( 'POST', '/x-companion/v1/blocks/library/nosuchblock/rollback' ), array( 'DELETE', '/x-companion/v1/blocks/library/nosuchblock' ) ) as $call ) {
			$response = x_call( $call[0], $call[1] );

			x_assert( 404 === $response['status'], $call[0] . ' ' . $call[1] . ': expected 404, got ' . x_show( $response ) );
			x_assert_same( 'not_found', $response['json']['code'] ?? null, $call[0] . ' error code' );
		}
	}
);

x_test(
	'the installed package is an active WordPress plugin, visible to core',
	function () {
		$entry = x_library_entry( 'testimonial' );

		x_assert( is_array( $entry ), 'testimonial is in the library listing' );
		x_assert_same( true, $entry['active'] ?? null, 'the library reports the package plugin as active' );

		$plugins = x_call( 'GET', '/wp/v2/plugins' );
		$found   = null;
		foreach ( (array) ( $plugins['json'] ?? array() ) as $plugin ) {
			if ( 'agent-block-testimonial/agent-block-testimonial' === ( $plugin['plugin'] ?? '' ) ) {
				$found = $plugin;
			}
		}

		x_assert( is_array( $found ), 'the package appears in /wp/v2/plugins like any plugin: ' . x_show( $plugins ) );
		x_assert_same( 'active', $found['status'] ?? null, 'and WordPress reports it active' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * Delete
 * ---------------------------------------------------------------------------
 */

$post = x_call(
	'POST',
	'/wp/v2/posts',
	array(
		'body' => array(
			'title'   => 'x-companion in-use probe',
			'status'  => 'publish',
			'content' => '<!-- wp:agent/testimonial {"quote":"still in use"} /-->',
		),
	)
);

$post_id = (int) ( $post['json']['id'] ?? 0 );

x_test(
	'DELETE is refused 409 in_use while published content carries the block',
	function () use ( $post_id ) {
		x_assert( $post_id > 0, 'could not create the probe post: the rest of this case is meaningless without it' );

		$response = x_call( 'DELETE', '/x-companion/v1/blocks/library/testimonial' );

		x_assert( 409 === $response['status'], 'expected 409, got ' . x_show( $response ) );
		x_assert_same( 'in_use', $response['json']['code'] ?? null, 'error code' );

		$posts = (array) ( $response['json']['data']['posts'] ?? array() );
		x_assert( in_array( $post_id, array_map( 'intval', $posts ), true ), 'data.posts must name the offending post, got ' . wp_json_encode( $posts ) );
	}
);

x_test(
	'DELETE succeeds once nothing published uses the block',
	function () use ( $post_id ) {
		if ( $post_id > 0 ) {
			x_call( 'DELETE', '/wp/v2/posts/' . $post_id, array( 'body' => array( 'force' => true ) ) );
		}

		$before   = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );
		$response = x_call( 'DELETE', '/x-companion/v1/blocks/library/testimonial' );

		x_assert( 200 === $response['status'], 'expected 200, got ' . x_show( $response ) );

		$returned = (string) ( $response['json']['fingerprint'] ?? '' );
		x_assert( $returned !== $before, 'removing a block moves the epoch' );

		x_assert_same( null, x_library_entry( 'testimonial' ), 'the block is gone from the library listing' );

		$manifest = x_call( 'GET', '/x-companion/v1/manifest' );
		x_assert( ! isset( $manifest['json']['blocks']['agent/testimonial'] ), 'the block is gone from the manifest' );
	}
);

exit( x_summary() );
