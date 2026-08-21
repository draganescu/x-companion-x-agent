<?php
/**
 * POST /theme/tokens and POST /snapshot/export, against a live WordPress.
 *
 *   node tools/playground/boot.mjs --profile core-only --posture toolchain --plugin ./x-companion
 *   php x-companion/tests/test-tokens.php --runtime tools/.runtime/core-only-toolchain.json
 *
 * Run it against core-plus-suite as well: the Kadence adapter assertions below
 * switch themselves on when `manifest.suites` reports the suite, and assert the
 * "no suite adapter ran" case when it does not.
 *
 * `wp_get_global_settings()` is observed through `GET /manifest`, whose
 * `theme_tokens` block is literally that function's output narrowed to the four
 * contract groups (see X_Companion_Manifest::theme_tokens()). Asserting over the
 * wire keeps the test on the same side of the boundary as the agent.
 *
 * @package x-companion
 */

require_once __DIR__ . '/bootstrap-lite.php';

/*
 * ---------------------------------------------------------------------------
 * A REST client, sized for a test file
 * ---------------------------------------------------------------------------
 *
 * Duplicated verbatim in test-install.php and guarded, so either file can be run
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
	 * @param string $route   Route below the site root.
	 * @param array  $options as: admin|agent|anon, body: array, upload: path.
	 * @return array { status, json, body, headers }
	 */
	function x_call( string $method, string $route, array $options = array() ): array {
		static $runtime = null;

		if ( null === $runtime ) {
			$runtime = x_live_runtime();
		}

		$base      = rtrim( (string) $runtime['url'], '/' );
		$candidate = $base . '/wp-json' . $route;
		$fallback  = str_replace( '%2F', '/', $base . '/?rest_route=' . rawurlencode( $route ) );

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

		$headers = array( 'Accept: application/json, */*;q=0.5' );
		$as      = (string) ( $options['as'] ?? 'admin' );

		if ( 'anon' !== $as && isset( $runtime[ $as ]['user'] ) ) {
			$headers[] = 'Authorization: Basic ' . base64_encode( $runtime[ $as ]['user'] . ':' . $runtime[ $as ]['app_password'] );
		}

		curl_setopt( $handle, CURLOPT_URL, $url );
		curl_setopt( $handle, CURLOPT_CUSTOMREQUEST, strtoupper( $method ) );
		curl_setopt( $handle, CURLOPT_RETURNTRANSFER, true );
		curl_setopt( $handle, CURLOPT_HEADER, true );
		curl_setopt( $handle, CURLOPT_FOLLOWLOCATION, false );
		curl_setopt( $handle, CURLOPT_TIMEOUT, 180 );

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
 * The change-note grammar the Kadence adapter documents and this file pins.
 *
 *     {adapter}:{target}:{applied|noop|skipped}:{colon-free detail}
 */
const X_NOTE_FORMAT = '/^(?P<adapter>[a-z0-9-]+):(?P<target>[a-z0-9_.-]+):(?P<status>applied|noop|skipped):(?P<detail>[^:]*)$/';

/**
 * Slugs of a preset list, whatever origin wrapper it arrives in.
 *
 * @param mixed  $presets Preset value from manifest.theme_tokens.
 * @param string $origin  Origin key to read.
 * @return string[]
 */
function x_preset_slugs( $presets, string $origin = 'custom' ): array {
	if ( ! is_array( $presets ) ) {
		return array();
	}

	$list = array_is_list( $presets ) ? $presets : ( $presets[ $origin ] ?? array() );
	$out  = array();

	foreach ( (array) $list as $preset ) {
		if ( isset( $preset['slug'] ) ) {
			$out[] = (string) $preset['slug'];
		}
	}

	return $out;
}

/**
 * One preset out of a preset list, by slug.
 *
 * @param mixed  $presets Preset value.
 * @param string $slug    Slug.
 * @param string $origin  Origin key.
 * @return array|null
 */
function x_preset( $presets, string $slug, string $origin = 'custom' ): ?array {
	if ( ! is_array( $presets ) ) {
		return null;
	}

	$list = array_is_list( $presets ) ? $presets : ( $presets[ $origin ] ?? array() );

	foreach ( (array) $list as $preset ) {
		if ( is_array( $preset ) && ( $preset['slug'] ?? null ) === $slug ) {
			return $preset;
		}
	}

	return null;
}

$runtime = x_live_runtime();
$tokens  = json_decode( (string) file_get_contents( x_fixture_path( 'design-tokens.sample.json' ) ), true );

if ( ! is_array( $tokens ) ) {
	fwrite( STDERR, "fixtures/design-tokens.sample.json is unreadable.\n" );
	exit( 2 );
}

x_suite( 'theme tokens + snapshot (live: ' . ( $runtime['profile'] ?? '?' ) . '/' . ( $runtime['posture'] ?? '?' ) . ')' );

$suites = array();
foreach ( (array) ( x_call( 'GET', '/x-companion/v1/manifest' )['json']['suites'] ?? array() ) as $suite ) {
	$suites[] = (string) ( $suite['slug'] ?? '' );
}

$kadence = in_array( 'kadence-blocks', $suites, true );

$apply = x_call( 'POST', '/x-companion/v1/theme/tokens', array( 'body' => $tokens ) );

/*
 * ---------------------------------------------------------------------------
 * The write
 * ---------------------------------------------------------------------------
 */

x_test(
	'POST /theme/tokens returns the contract shape',
	function () use ( $apply ) {
		x_assert( 200 === $apply['status'], 'expected 200, got ' . x_show( $apply ) );
		x_assert_same( true, $apply['json']['theme_json_written'] ?? null, 'theme_json_written' );
		x_assert( is_array( $apply['json']['adapters_applied'] ?? null ), 'adapters_applied must be an array' );
		x_assert( 64 === strlen( (string) ( $apply['json']['fingerprint'] ?? '' ) ), 'fingerprint is 64 hex characters' );
	}
);

$manifest = x_call( 'GET', '/x-companion/v1/manifest' );
$live     = (array) ( $manifest['json']['theme_tokens'] ?? array() );

x_test(
	'wp_get_global_settings() reflects the palette, slug for slug',
	function () use ( $live, $tokens ) {
		$expected = array();
		foreach ( $tokens['palette'] as $entry ) {
			$expected[] = $entry['slug'];
		}

		x_assert_same( $expected, x_preset_slugs( $live['color']['palette'] ?? null ), 'user-origin palette slugs' );

		$cobalt = x_preset( $live['color']['palette'] ?? null, 'cobalt' );
		x_assert_same( '#1f3fd6', $cobalt['color'] ?? null, 'the computed colour is the token colour, not a theme default' );
		x_assert_same( 'Cobalt', $cobalt['name'] ?? null, 'the preset name survives' );
	}
);

x_test(
	'wp_get_global_settings() reflects the spacing steps',
	function () use ( $live, $tokens ) {
		$expected = array();
		foreach ( $tokens['spacing']['steps'] as $step ) {
			$expected[] = $step['slug'];
		}

		x_assert_same( $expected, x_preset_slugs( $live['spacing']['spacingSizes'] ?? null ), 'user-origin spacingSizes slugs' );
		x_assert_same( '4.5rem', x_preset( $live['spacing']['spacingSizes'] ?? null, '60' )['size'] ?? null, 'step 60 size' );
	}
);

x_test(
	'wp_get_global_settings() reflects typography and layout',
	function () use ( $live, $tokens ) {
		$sizes = array();
		foreach ( $tokens['typography']['sizes'] as $size ) {
			$sizes[] = $size['slug'];
		}

		$families = array();
		foreach ( $tokens['typography']['families'] as $family ) {
			$families[] = $family['slug'];
		}

		x_assert_same( $sizes, x_preset_slugs( $live['typography']['fontSizes'] ?? null ), 'fontSizes slugs' );
		x_assert_same( $families, x_preset_slugs( $live['typography']['fontFamilies'] ?? null ), 'fontFamilies slugs' );
		x_assert_same(
			$tokens['typography']['families'][1]['fontFamily'],
			x_preset( $live['typography']['fontFamilies'] ?? null, 'display' )['fontFamily'] ?? null,
			'a font stack with escaped quotes survives the slash dance through wp_update_post()'
		);
		x_assert_same( $tokens['layout']['contentSize'], $live['layout']['contentSize'] ?? null, 'layout.contentSize' );
		x_assert_same( $tokens['layout']['wideSize'], $live['layout']['wideSize'] ?? null, 'layout.wideSize' );
	}
);

x_test(
	'unrelated global-styles settings are preserved by the merge',
	function () use ( $live ) {
		// The theme origin is still there next to the user origin: writing the
		// user origin must not flatten what the theme declared.
		$palette = $live['color']['palette'] ?? array();

		x_assert( is_array( $palette ) && isset( $palette['custom'] ), 'the custom origin exists' );
		x_assert( isset( $palette['theme'] ) || isset( $palette['default'] ), 'other origins were not dropped' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * Suite adapters
 * ---------------------------------------------------------------------------
 */

$notes = array_map( 'strval', (array) ( $apply['json']['adapter_notes'] ?? array() ) );

x_test(
	'every adapter note obeys the documented format',
	function () use ( $notes ) {
		foreach ( $notes as $note ) {
			x_assert( 1 === preg_match( X_NOTE_FORMAT, $note ), 'note does not match {adapter}:{target}:{status}:{detail}: "' . $note . '"' );
		}

		if ( empty( $notes ) ) {
			x_assert( true, 'no adapters ran, so there is nothing to check the format of' );
		}
	}
);

if ( $kadence ) {
	x_test(
		'the Kadence adapter ran and applied the palette',
		function () use ( $apply, $notes, $tokens ) {
			x_assert(
				in_array( 'kadence', (array) ( $apply['json']['adapters_applied'] ?? array() ), true ),
				'adapters_applied should contain "kadence", got ' . wp_json_encode( $apply['json']['adapters_applied'] ?? null )
			);

			$expected = 'kadence:kadence_blocks_colors:applied:palette_colors=' . count( $tokens['palette'] );

			x_assert(
				in_array( $expected, $notes, true ),
				'expected the note "' . $expected . '", got ' . wp_json_encode( $notes )
			);
		}
	);

	x_test(
		'the Kadence palette option really holds the token colours',
		function () use ( $tokens ) {
			$settings = x_call( 'GET', '/wp/v2/settings' );

			x_assert( 200 === $settings['status'], 'expected 200 from /wp/v2/settings, got ' . x_show( $settings ) );

			$raw = $settings['json']['kadence_blocks_colors'] ?? null;

			x_assert( is_string( $raw ) && '' !== $raw, 'kadence_blocks_colors is a non-empty JSON string' );

			$decoded = json_decode( (string) $raw, true );

			x_assert( is_array( $decoded ) && isset( $decoded['palette'] ), 'the option decodes to a map with a palette' );

			$slugs = array();
			foreach ( (array) $decoded['palette'] as $entry ) {
				$slugs[] = $entry['slug'] ?? '';
			}

			$expected = array();
			foreach ( $tokens['palette'] as $entry ) {
				$expected[] = $entry['slug'];
			}

			x_assert_same( $expected, $slugs, 'Kadence palette slugs' );
			x_assert_same( '#d8e04b', ( (array) $decoded['palette'] )[6]['color'] ?? null, 'the accent hex arrived verbatim' );
			x_assert( array_key_exists( 'override', $decoded ), 'keys Kadence owns are preserved/seeded, not dropped' );
		}
	);

	x_test(
		'a target the adapter does not understand is a structured, logged no-op',
		function () use ( $notes ) {
			$noop = null;

			foreach ( $notes as $note ) {
				if ( preg_match( X_NOTE_FORMAT, $note, $parts ) && 'noop' === $parts['status'] ) {
					$noop = $parts;
				}
			}

			x_assert( is_array( $noop ), 'Kadence 3.7.x has no spacing scale option, so exactly one no-op note is expected: ' . wp_json_encode( $notes ) );

			if ( is_array( $noop ) ) {
				x_assert_same( 'kadence', $noop['adapter'], 'note adapter field' );
				x_assert_same( 'kadence_blocks_global', $noop['target'], 'note target field' );
				x_assert_same( 'no_spacing_target_in_option_shape', $noop['detail'], 'note detail field' );
			}
		}
	);
} else {
	x_test(
		'no suite adapter claims an instance with no suite installed',
		function () use ( $apply, $notes ) {
			x_assert_same( array(), $apply['json']['adapters_applied'] ?? null, 'adapters_applied' );
			x_assert_same( array(), $notes, 'adapter_notes' );
		}
	);
}

/*
 * ---------------------------------------------------------------------------
 * POST /snapshot/export
 * ---------------------------------------------------------------------------
 */

$export = x_call( 'POST', '/x-companion/v1/snapshot/export' );
$path   = rtrim( sys_get_temp_dir(), '/' ) . '/x-companion-snapshot-test-' . getmypid() . '.zip';

file_put_contents( $path, $export['body'] );

x_test(
	'POST /snapshot/export streams a zip',
	function () use ( $export, $path ) {
		x_assert( 200 === $export['status'], 'expected 200, got HTTP ' . $export['status'] );
		x_assert_same( 'application/zip', $export['headers']['content-type'] ?? null, 'Content-Type' );
		x_assert( filesize( $path ) > 1024, 'the body is a real archive, got ' . filesize( $path ) . ' bytes' );
	}
);

x_test(
	'the snapshot contains exactly the five contract entries',
	function () use ( $path ) {
		$zip = new ZipArchive();

		x_assert( true === $zip->open( $path ), 'the response body opens as a zip' );

		$top = array();
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$name    = (string) $zip->getNameIndex( $i );
			$segment = strtok( $name, '/' );
			$top[]   = ( false !== strpos( $name, '/' ) ) ? $segment . '/' : $segment;
		}

		$top = array_values( array_unique( $top ) );
		sort( $top );

		x_assert_same(
			array( 'agent-blocks/', 'content.xml', 'manifest.json', 'patterns.json', 'theme/' ),
			$top,
			'top-level entries'
		);

		$zip->close();
	}
);

x_test(
	'snapshot manifest.json carries the live fingerprint',
	function () use ( $path ) {
		$zip = new ZipArchive();
		$zip->open( $path );

		$manifest = json_decode( (string) $zip->getFromName( 'manifest.json' ), true );
		$patterns = json_decode( (string) $zip->getFromName( 'patterns.json' ), true );
		$content  = (string) $zip->getFromName( 'content.xml' );

		$zip->close();

		$fingerprint = (string) ( x_call( 'GET', '/x-companion/v1/fingerprint' )['json']['fingerprint'] ?? '' );

		x_assert( is_array( $manifest ), 'manifest.json decodes' );
		x_assert_same( $fingerprint, $manifest['fingerprint'] ?? null, 'manifest.json fingerprint == GET /fingerprint' );
		x_assert( is_array( $patterns ) && ! empty( $patterns ), 'patterns.json is the GET /patterns payload' );
		x_assert( false !== strpos( $content, '<!-- generator="WordPress' ) || false !== strpos( $content, '<rss' ), 'content.xml is a WXR document' );
		x_assert( false !== strpos( $content, '<wp:status><![CDATA[publish]]></wp:status>' ), 'content.xml carries published items' );

		foreach ( array( 'draft', 'trash', 'auto-draft' ) as $unwanted ) {
			x_assert( false === strpos( $content, '<wp:status><![CDATA[' . $unwanted . ']]></wp:status>' ), 'content.xml must not carry ' . $unwanted . ' items' );
		}

		foreach ( array( 'wp_global_styles', 'attachment', 'nav_menu_item' ) as $unwanted ) {
			x_assert( false === strpos( $content, '<wp:post_type><![CDATA[' . $unwanted . ']]></wp:post_type>' ), 'content.xml is posts and pages only, found ' . $unwanted );
		}
	}
);

unlink( $path );

exit( x_summary() );
