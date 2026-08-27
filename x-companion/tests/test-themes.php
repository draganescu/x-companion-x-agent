<?php
/**
 * The theme install route, against a live WordPress.
 *
 *   node tools/playground/boot.mjs --profile core-only --posture toolchain --plugin ./x-companion
 *   php x-companion/tests/test-themes.php --runtime tools/.runtime/core-only-toolchain.json
 *
 * POST /themes/install is the one surface the theme-factory spec knowingly
 * adds. This suite proves the contract over the wire: policy 422s with named
 * reasons, install + activation moving the fingerprint, replaced_previous on a
 * second install, and the auth/tier wall. It SWITCHES the instance's active
 * theme, so run-all.sh runs it last on its instance.
 *
 * The zip fixtures are built here from inline structural content: the route
 * validates STRUCTURE (one root dir, style.css header, parsing theme.json,
 * templates present) — design never enters this suite.
 *
 * @package x-companion
 */

require_once __DIR__ . '/bootstrap-lite.php';
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

x_suite( 'themes/install (live)' );

/**
 * Build a theme zip fixture.
 *
 * @param string $slug   Root dir / slug.
 * @param array  $files  Relative path => contents (merged over the defaults).
 * @param array  $remove Relative paths to drop from the defaults.
 * @return string Zip path.
 */
function x_theme_zip( string $slug, array $files = array(), array $remove = array() ): string {
	$defaults = array(
		'style.css'                      => "/*\nTheme Name: Salon Regale Theme\nDescription: A bespoke ground.\nVersion: 1.0.0\nText Domain: {$slug}\n*/\n",
		'theme.json'                     => (string) wp_json_encode(
			array(
				'version'  => 3,
				'settings' => array(
					'layout' => array(
						'contentSize' => '680px',
						'wideSize'    => '1080px',
					),
				),
			)
		),
		'templates/index.html'           => "<!-- wp:template-part {\"slug\":\"header\",\"tagName\":\"header\"} /-->\n<!-- wp:post-content {\"layout\":{\"type\":\"constrained\"}} /-->\n",
		'templates/page.html'            => "<!-- wp:post-title /-->\n<!-- wp:post-content {\"layout\":{\"type\":\"constrained\"}} /-->\n",
		'templates/page-no-title.html'   => "<!-- wp:post-content {\"layout\":{\"type\":\"constrained\"}} /-->\n",
		'templates/canvas.html'          => "<!-- wp:post-content {\"layout\":{\"type\":\"constrained\"}} /-->\n",
		'parts/header.html'              => "<!-- wp:site-title /-->\n",
		'parts/footer.html'              => "<!-- wp:site-title /-->\n",
	);

	foreach ( $remove as $path ) {
		unset( $defaults[ $path ] );
	}

	$contents = array_merge( $defaults, $files );

	$zip_path = tempnam( sys_get_temp_dir(), 'x-theme-' ) . '.zip';
	$zip      = new ZipArchive();
	$zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE );

	foreach ( $contents as $rel => $body ) {
		$zip->addFromString( $slug . '/' . $rel, (string) $body );
	}

	$zip->close();

	return $zip_path;
}

$fingerprint_before = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );

x_test(
	'a valid theme package installs, activates, and moves the epoch',
	function () use ( $fingerprint_before ) {
		$zip      = x_theme_zip( 'salon-regale' );
		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip ) );

		x_assert( 200 === $response['status'], 'expected 200, got ' . x_show( $response ) );
		x_assert_same( 'salon-regale', $response['json']['installed']['slug'] ?? null, 'slug' );
		x_assert_same( 'Salon Regale Theme', $response['json']['installed']['name'] ?? null, 'name' );
		x_assert_same( '1.0.0', $response['json']['installed']['version'] ?? null, 'version' );
		x_assert_same( false, $response['json']['replaced_previous'] ?? null, 'first install replaces nothing' );

		$returned = (string) ( $response['json']['fingerprint'] ?? '' );
		x_assert( 64 === strlen( $returned ), 'fingerprint is 64 hex characters, got "' . $returned . '"' );
		x_assert( $returned !== $fingerprint_before, 'activating a new theme moves the epoch' );

		// The route's own fingerprint is best-effort (a theme's init-time
		// registrations only exist from the next request; see the route). What
		// the contract guarantees: the steady-state epoch has MOVED and is
		// STABLE — that is the one wp_theme_install adopts via its manifest
		// refresh.
		$live  = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );
		$again = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );
		x_assert( $live !== $fingerprint_before, 'the steady-state epoch moved' );
		x_assert_same( $live, $again, 'the steady-state epoch is stable' );

		$themes = x_call( 'GET', '/wp/v2/themes' );
		$active = null;

		foreach ( (array) ( $themes['json'] ?? array() ) as $theme ) {
			if ( ( $theme['status'] ?? '' ) === 'active' ) {
				$active = $theme;
			}
		}

		x_assert_same( 'salon-regale', $active['stylesheet'] ?? null, 'the theme is the ACTIVE theme' );

		$manifest = x_call( 'GET', '/x-companion/v1/manifest' );
		x_assert_same( 'salon-regale', $manifest['json']['theme']['slug'] ?? null, 'the manifest serves the bespoke slug' );
		x_assert_same( 'Salon Regale Theme', $manifest['json']['theme']['name'] ?? null, 'the manifest serves the theme NAME (M2)' );
		x_assert_same( '680px', $manifest['json']['theme_tokens']['layout']['contentSize'] ?? null, 'the manifest serves the bespoke measure (M2)' );
	}
);

x_test(
	'a second install of the same slug replaces the previous copy',
	function () {
		$zip      = x_theme_zip( 'salon-regale', array( 'style.css' => "/*\nTheme Name: Salon Regale Theme\nVersion: 1.0.1\n*/\n" ) );
		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip ) );

		x_assert( 200 === $response['status'], 'expected 200, got ' . x_show( $response ) );
		x_assert_same( true, $response['json']['replaced_previous'] ?? null, 'replaced_previous' );
		x_assert_same( '1.0.1', $response['json']['installed']['version'] ?? null, 'the new bytes are the ones serving' );
	}
);

x_test(
	'a package without templates/index.html is refused, naming the file',
	function () {
		$zip      = x_theme_zip( 'poisoned-theme', array(), array( 'templates/index.html' ) );
		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip ) );

		x_assert( 422 === $response['status'], 'expected 422, got ' . x_show( $response ) );
		x_assert_same( 'invalid_theme_package', $response['json']['code'] ?? null, 'code' );

		$reasons = implode( ' ', (array) ( $response['json']['data']['reasons'] ?? array() ) );
		x_assert( false !== strpos( $reasons, 'templates/index.html' ), 'the reason names the missing file: ' . $reasons );
	}
);

x_test(
	'a package with a broken theme.json is refused',
	function () {
		$zip      = x_theme_zip( 'broken-json', array( 'theme.json' => '{nope' ) );
		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip ) );

		x_assert( 422 === $response['status'], 'expected 422, got ' . x_show( $response ) );

		$reasons = implode( ' ', (array) ( $response['json']['data']['reasons'] ?? array() ) );
		x_assert( false !== strpos( $reasons, 'theme.json' ), 'the reason names theme.json: ' . $reasons );
	}
);

x_test(
	'a flat package (no wrapper directory) is refused',
	function () {
		$zip_path = tempnam( sys_get_temp_dir(), 'x-theme-flat-' ) . '.zip';
		$zip      = new ZipArchive();
		$zip->open( $zip_path, ZipArchive::CREATE | ZipArchive::OVERWRITE );
		$zip->addFromString( 'style.css', "/*\nTheme Name: Flat\n*/\n" );
		$zip->addFromString( 'templates/index.html', '<!-- wp:post-content /-->' );
		$zip->close();

		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip_path ) );

		x_assert( 422 === $response['status'], 'expected 422, got ' . x_show( $response ) );

		$reasons = implode( ' ', (array) ( $response['json']['data']['reasons'] ?? array() ) );
		x_assert( false !== strpos( $reasons, 'one top-level directory' ), 'the reason names the wrapper rule: ' . $reasons );
	}
);

x_test(
	'anonymous callers get 401, never a theme',
	function () {
		$zip      = x_theme_zip( 'salon-regale' );
		$response = x_call( 'POST', '/x-companion/v1/themes/install', array( 'upload' => $zip, 'as' => 'anon' ) );

		x_assert( 401 === $response['status'], 'expected 401, got ' . x_show( $response ) );
	}
);

exit( x_summary() );
