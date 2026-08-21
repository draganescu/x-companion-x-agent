<?php
/**
 * Manifest compiler + fingerprint.
 *
 * Runs two ways:
 *   php x-companion/tests/test-manifest.php           (offline, no WordPress)
 *   loaded inside a real WP / Playground run          (ABSPATH already defined)
 *
 * The canonicaliser and the fingerprint are pure functions of an injected
 * registry snapshot, so the bulk of this suite runs against
 * fixtures/registry-snapshot.json. The live-only block at the end exercises
 * the real registry when one is available.
 *
 * @package x-companion
 */

// Offline: bootstrap-lite stubs the WordPress APIs the manifest touches and
// loads the plugin classes. Under a real WordPress every stub is skipped and
// only the assertion runner is contributed.
require_once __DIR__ . '/bootstrap-lite.php';

x_suite( 'manifest' );

$snapshot = x_fixture( 'registry-snapshot.json' );

$theme   = array(
	'slug'    => 'twentytwentyfive',
	'version' => '1.3',
);
$plugins = array(
	array(
		'slug'    => 'x-companion',
		'version' => '1.0.0',
	),
);

/*
 * ---------------------------------------------------------------------------
 * canonical_json
 * ---------------------------------------------------------------------------
 */

x_test(
	'canonical_json sorts object keys ascending at every depth',
	function () {
		x_assert_same(
			'{"a":{"c":3,"d":{"e":1,"f":2}},"b":1}',
			X_Companion_Manifest::canonical_json(
				array(
					'b' => 1,
					'a' => array(
						'd' => array(
							'f' => 2,
							'e' => 1,
						),
						'c' => 3,
					),
				)
			),
			'recursive ksort'
		);
	}
);

x_test(
	'canonical_json preserves array order',
	function () {
		x_assert_same(
			'{"list":[3,1,2]}',
			X_Companion_Manifest::canonical_json( array( 'list' => array( 3, 1, 2 ) ) ),
			'lists are ordered data, not objects'
		);
	}
);

x_test(
	'canonical_json does not escape slashes or unicode',
	function () {
		x_assert_same(
			'{"selector":"figure > a","url":"https://example.com/a.jpg","word":"café"}',
			X_Companion_Manifest::canonical_json(
				array(
					'url'      => 'https://example.com/a.jpg',
					'word'     => 'café',
					'selector' => 'figure > a',
				)
			),
			'JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE'
		);
	}
);

x_test(
	'canonical_json emits no insignificant whitespace',
	function () {
		$json = X_Companion_Manifest::canonical_json( array( 'a' => array( 1, 2 ) ) );
		x_assert_same( '{"a":[1,2]}', $json, 'compact' );
		x_assert( false === strpos( $json, ' ' ), 'no spaces' );
		x_assert( false === strpos( $json, "\n" ), 'no newlines' );
	}
);

x_test(
	'canonical_json keeps an empty object an object',
	function () {
		x_assert_same( '{"attributes":{}}', X_Companion_Manifest::canonical_json( array( 'attributes' => new stdClass() ) ), 'stdClass stays {}' );
		x_assert_same( '{"attributes":[]}', X_Companion_Manifest::canonical_json( array( 'attributes' => array() ) ), 'empty PHP array stays []' );
	}
);

x_test(
	'canonical_json is insensitive to key insertion order',
	function () {
		$a = array(
			'z' => 1,
			'a' => 2,
			'm' => array(
				'y' => 3,
				'b' => 4,
			),
		);
		$b = array(
			'm' => array(
				'b' => 4,
				'y' => 3,
			),
			'a' => 2,
			'z' => 1,
		);

		x_assert_same( X_Companion_Manifest::canonical_json( $a ), X_Companion_Manifest::canonical_json( $b ), 'same bytes' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * fingerprint_inputs
 * ---------------------------------------------------------------------------
 */

x_test(
	'fingerprint_inputs matches the pinned contract shape',
	function () use ( $snapshot, $theme, $plugins ) {
		$inputs = X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins );

		x_assert_same(
			array( 'interfaces_version', 'blocks', 'theme', 'plugins', 'global_styles' ),
			array_keys( $inputs ),
			'top-level keys, in contract order'
		);
		x_assert_same( '', $inputs['global_styles'], 'global_styles defaults to the empty stamp' );
		x_assert_same( '1', $inputs['interfaces_version'], 'interfaces_version' );
		x_assert_same( $theme, $inputs['theme'], 'theme' );
		x_assert_same( $plugins, $inputs['plugins'], 'plugins' );

		x_assert_same(
			array( 'name', 'api_version', 'attributes', 'parent', 'ancestor' ),
			array_keys( $inputs['blocks'][0] ),
			'per-block keys, in contract order'
		);
	}
);

x_test(
	'fingerprint_inputs sorts blocks ascending by name using strcmp',
	function () use ( $snapshot, $theme, $plugins ) {
		$inputs = X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins );
		$names  = array_column( $inputs['blocks'], 'name' );

		$sorted = $names;
		usort( $sorted, 'strcmp' );

		x_assert_same( $sorted, $names, 'byte-order sorted' );
		x_assert_same( 'core/button', $names[0], 'core/button sorts before core/buttons (strcmp, not natural)' );
		x_assert_same( 'core/buttons', $names[1], 'core/buttons second' );
	}
);

x_test(
	'fingerprint_inputs nulls unset parent/ancestor and sorts the set ones',
	function () use ( $snapshot, $theme, $plugins ) {
		$inputs = X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins );
		$by     = array_column( $inputs['blocks'], null, 'name' );

		x_assert_same( null, $by['core/group']['parent'], 'unset parent is null' );
		x_assert_same( null, $by['core/group']['ancestor'], 'unset ancestor is null' );
		x_assert_same( array( 'core/columns' ), $by['core/column']['parent'], 'set parent is a list' );
		x_assert_same( array( 'core/query' ), $by['core/post-template']['ancestor'], 'set ancestor is a list' );
	}
);

x_test(
	'fingerprint_inputs sorts plugins ascending by slug',
	function () use ( $snapshot, $theme ) {
		$inputs = X_Companion_Manifest::fingerprint_inputs(
			$snapshot,
			$theme,
			array(
				array(
					'slug'    => 'x-companion',
					'version' => '1.0.0',
				),
				array(
					'slug'    => 'kadence-blocks',
					'version' => '3.2.0',
				),
			)
		);

		x_assert_same( array( 'kadence-blocks', 'x-companion' ), array_column( $inputs['plugins'], 'slug' ), 'sorted' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * fingerprint
 * ---------------------------------------------------------------------------
 */

/**
 * Fingerprint the fixture snapshot with optional overrides.
 *
 * @param array $snapshot Registry snapshot.
 * @param array $theme    Theme.
 * @param array $plugins  Plugins.
 * @return string
 */
function x_fp( array $snapshot, array $theme, array $plugins ): string {
	return X_Companion_Manifest::compute_fingerprint(
		X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins )
	);
}

x_test(
	'the fingerprint is 64 lowercase hex characters',
	function () use ( $snapshot, $theme, $plugins ) {
		$fp = x_fp( $snapshot, $theme, $plugins );
		x_assert( 1 === preg_match( '/^[0-9a-f]{64}$/', $fp ), 'shape: ' . $fp );
	}
);

x_test(
	'a different global-styles stamp moves the fingerprint (token writes move the epoch)',
	function () use ( $snapshot, $theme, $plugins ) {
		$a = X_Companion_Manifest::compute_fingerprint(
			X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins, '' )
		);
		$b = X_Companion_Manifest::compute_fingerprint(
			X_Companion_Manifest::fingerprint_inputs( $snapshot, $theme, $plugins, str_repeat( 'a', 64 ) )
		);
		x_assert( $a !== $b, 'global_styles participates in the fingerprint' );
	}
);

x_test(
	'the fingerprint is stable across identical inputs',
	function () use ( $snapshot, $theme, $plugins ) {
		x_assert_same( x_fp( $snapshot, $theme, $plugins ), x_fp( $snapshot, $theme, $plugins ), 'two consecutive computations' );
	}
);

x_test(
	'the fingerprint ignores registry iteration order',
	function () use ( $snapshot, $theme, $plugins ) {
		$shuffled = array_reverse( $snapshot, true );
		x_assert_same( x_fp( $snapshot, $theme, $plugins ), x_fp( $shuffled, $theme, $plugins ), 'reversed registry' );
	}
);

x_test(
	'the fingerprint moves when a block attribute schema changes',
	function () use ( $snapshot, $theme, $plugins ) {
		$changed = $snapshot;
		$changed['core/heading']['attributes']['level']['default'] = 3;

		x_assert( x_fp( $snapshot, $theme, $plugins ) !== x_fp( $changed, $theme, $plugins ), 'attribute change is in scope' );
	}
);

x_test(
	'the fingerprint moves when a block is added or removed',
	function () use ( $snapshot, $theme, $plugins ) {
		$added                     = $snapshot;
		$added['agent/testimonial'] = array(
			'api_version' => 3,
			'attributes'  => array( 'quote' => array( 'type' => 'string' ) ),
			'is_dynamic'  => true,
		);

		$removed = $snapshot;
		unset( $removed['core/spacer'] );

		$base = x_fp( $snapshot, $theme, $plugins );
		x_assert( $base !== x_fp( $added, $theme, $plugins ), 'installed agent block moves the epoch' );
		x_assert( $base !== x_fp( $removed, $theme, $plugins ), 'removed block moves the epoch' );
	}
);

x_test(
	'the fingerprint moves when the theme or a plugin version changes',
	function () use ( $snapshot, $theme, $plugins ) {
		$base = x_fp( $snapshot, $theme, $plugins );

		x_assert(
			$base !== x_fp( $snapshot, array( 'slug' => 'twentytwentyfour', 'version' => '1.3' ), $plugins ),
			'theme slug'
		);
		x_assert(
			$base !== x_fp( $snapshot, array( 'slug' => 'twentytwentyfive', 'version' => '1.4' ), $plugins ),
			'theme version'
		);
		x_assert(
			$base !== x_fp( $snapshot, $theme, array_merge( $plugins, array( array( 'slug' => 'kadence-blocks', 'version' => '3.2.0' ) ) ) ),
			'activating a suite (the Kadence toggle)'
		);
	}
);

x_test(
	'the fingerprint ignores manifest-only metadata',
	function () use ( $snapshot, $theme, $plugins ) {
		$noisy = $snapshot;
		$noisy['core/group']['title']            = 'Renamed in a translation';
		$noisy['core/group']['variations_count'] = 99;
		$noisy['core/group']['supports']['anchor'] = false;

		x_assert_same(
			x_fp( $snapshot, $theme, $plugins ),
			x_fp( $noisy, $theme, $plugins ),
			'title/supports/variations are not fingerprint inputs per contract section 4'
		);
	}
);

/*
 * ---------------------------------------------------------------------------
 * blocks map
 * ---------------------------------------------------------------------------
 */

x_test(
	'build_blocks emits every key the Manifest schema requires',
	function () use ( $snapshot ) {
		$blocks = X_Companion_Manifest::build_blocks( $snapshot );

		x_assert_same( count( $snapshot ), count( $blocks ), 'one entry per registered block' );

		foreach ( $blocks as $name => $entry ) {
			foreach ( array( 'title', 'category', 'api_version', 'attributes', 'is_dynamic' ) as $required ) {
				x_assert( array_key_exists( $required, $entry ), $name . ' is missing required key ' . $required );
			}
			x_assert( ! array_key_exists( '_type', $entry ), $name . ' must not leak the WP_Block_Type object' );
			x_assert( is_bool( $entry['is_dynamic'] ), $name . ' is_dynamic must be boolean' );
			x_assert( is_int( $entry['api_version'] ), $name . ' api_version must be an integer' );
		}
	}
);

x_test(
	'an attribute-less block still serialises attributes as an object',
	function () use ( $snapshot ) {
		$blocks = X_Companion_Manifest::build_blocks( $snapshot );

		x_assert_same( '{}', X_Companion_Manifest::canonical_json( $blocks['core/buttons']['attributes'] ), 'core/buttons has no own attributes' );
	}
);

x_test(
	'agent_hints are omitted when they carry nothing',
	function () use ( $snapshot ) {
		$blocks = X_Companion_Manifest::build_blocks( $snapshot );

		x_assert( ! isset( $blocks['core/paragraph']['agent_hints'] ), 'no hints on core/paragraph' );
		x_assert( isset( $blocks['core/cover']['agent_hints'] ), 'snapshot hints on core/cover survive' );
		x_assert_same(
			array( 'core/heading', 'core/paragraph', 'core/buttons' ),
			$blocks['core/cover']['agent_hints']['allowed_blocks'],
			'allowed_blocks'
		);
		x_assert_same( 'all', $blocks['core/query']['agent_hints']['template_lock'], 'template_lock' );
	}
);

x_test(
	'the x_companion_agent_hints filter merges into the manifest',
	function () use ( $snapshot ) {
		add_filter(
			'x_companion_agent_hints',
			function ( $hints, $block_name, $type ) {
				if ( 'core/group' !== $block_name ) {
					return $hints;
				}

				$hints['allowed_blocks']     = array( 'core/heading', 'core/paragraph' );
				$hints['template_lock']      = 'insert';
				$hints['usage_notes']        = 'Section wrapper.';
				$hints['example_attributes'] = array( 'tagName' => 'section' );

				return $hints;
			},
			10,
			3
		);

		$blocks = X_Companion_Manifest::build_blocks( $snapshot );
		remove_all_filters( 'x_companion_agent_hints' );

		x_assert_same( array( 'core/heading', 'core/paragraph' ), $blocks['core/group']['agent_hints']['allowed_blocks'], 'allowed_blocks merged' );
		x_assert_same( 'insert', $blocks['core/group']['agent_hints']['template_lock'], 'template_lock merged' );
		x_assert_same( 'Section wrapper.', $blocks['core/group']['agent_hints']['usage_notes'], 'usage_notes merged' );
		x_assert_same( array( 'tagName' => 'section' ), $blocks['core/group']['agent_hints']['example_attributes'], 'example_attributes merged' );
		x_assert( ! isset( $blocks['core/paragraph']['agent_hints'] ), 'other blocks untouched' );
	}
);

x_test(
	'the agent_hints filter cannot inject arbitrary keys or wrong types',
	function () use ( $snapshot ) {
		add_filter(
			'x_companion_agent_hints',
			function ( $hints ) {
				$hints['allowed_blocks'] = 'not-an-array';
				$hints['injected']       = 'nope';

				return $hints;
			}
		);

		$blocks = X_Companion_Manifest::build_blocks( $snapshot );
		remove_all_filters( 'x_companion_agent_hints' );

		x_assert( ! isset( $blocks['core/paragraph']['agent_hints']['injected'] ), 'unknown hint keys are dropped' );
		x_assert(
			! isset( $blocks['core/paragraph']['agent_hints'] ) || null === $blocks['core/paragraph']['agent_hints']['allowed_blocks'],
			'a non-array allowed_blocks is rejected'
		);
	}
);

/*
 * ---------------------------------------------------------------------------
 * whole manifest
 * ---------------------------------------------------------------------------
 */

x_test(
	'build() produces every key the Manifest schema requires',
	function () use ( $snapshot, $theme, $plugins ) {
		$manifest = X_Companion_Manifest::build(
			$snapshot,
			array(
				'fingerprint'        => x_fp( $snapshot, $theme, $plugins ),
				'generated_at'       => '2026-08-21T00:00:00+00:00',
				'wp_version'         => '6.5',
				'site_url'           => 'https://x-companion.test',
				'posture'            => 'toolchain',
				'interfaces_version' => '1',
				'patterns'           => array(
					array(
						'name'        => 'core/quote',
						'title'       => 'Quote',
						'categories'  => array( 'text' ),
						'source'      => 'core',
						'has_content' => true,
					),
				),
				'theme_tokens'       => X_Companion_Manifest::theme_tokens(),
				'suites'             => X_Companion_Manifest::suites(
					array(
						array(
							'slug'    => 'kadence-blocks',
							'version' => '3.2.0',
						),
						array(
							'slug'    => 'akismet',
							'version' => '5.3',
						),
						array(
							'slug'    => 'woocommerce',
							'version' => '11.0.1',
						),
					)
				),
			)
		);

		x_assert_same(
			array(
				'fingerprint',
				'generated_at',
				'wp_version',
				'site_url',
				'posture',
				'interfaces_version',
				'blocks',
				'patterns',
				'theme_tokens',
				'suites',
				'counts',
			),
			array_keys( $manifest ),
			'top-level keys'
		);

		x_assert_same( count( $snapshot ), $manifest['counts']['blocks'], 'counts.blocks' );
		x_assert_same( 4, $manifest['counts']['dynamic_blocks'], 'counts.dynamic_blocks (image, query, post-template, post-title)' );
		x_assert_same( count( $snapshot ) - 4, $manifest['counts']['static_blocks'], 'counts.static_blocks' );
		x_assert_same( 1, $manifest['counts']['patterns'], 'counts.patterns' );

		x_assert_same(
			array(
				array(
					'slug'    => 'kadence-blocks',
					'version' => '3.2.0',
				),
				array(
					'slug'    => 'woocommerce',
					'version' => '11.0.1',
				),
			),
			$manifest['suites'],
			'only known suites are listed (WooCommerce included)'
		);

		x_assert_same(
			array( 'color', 'spacing', 'typography', 'layout' ),
			array_keys( $manifest['theme_tokens'] ),
			'theme_tokens groups'
		);
		x_assert( isset( $manifest['theme_tokens']['color']['palette'] ), 'theme_tokens.color.palette present' );
		x_assert( isset( $manifest['theme_tokens']['spacing']['spacingSizes'] ), 'theme_tokens.spacing.spacingSizes present' );
		x_assert_same( '645px', $manifest['theme_tokens']['layout']['contentSize'], 'theme_tokens.layout.contentSize' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * caching
 * ---------------------------------------------------------------------------
 */

x_test(
	'the manifest transient is keyed by the fingerprint and rebuilt when it moves',
	function () use ( $snapshot ) {
		$registry = WP_Block_Type_Registry::get_instance();
		if ( ! method_exists( $registry, 'seed' ) ) {
			// Live WordPress: the registry is real and cannot be reseeded.
			x_assert( true, 'skipped under a live registry' );

			return;
		}

		$GLOBALS['x_lite_options']['active_plugins'] = array( 'x-companion/x-companion.php' );

		$registry->seed( $snapshot );
		X_Companion_Manifest::bust_cache();

		$first = X_Companion_Manifest::get_manifest();
		$key   = get_option( 'x_companion_manifest_cache_key' );

		x_assert( is_string( $key ) && str_starts_with( $key, 'x_companion_manifest_' ), 'cache key tracked: ' . var_export( $key, true ) );
		x_assert( false !== get_transient( $key ), 'transient written' );
		x_assert_same( X_Companion_Manifest::fingerprint(), $first['fingerprint'], 'manifest carries the current epoch' );

		// A second request with an unchanged registry must serve the transient.
		X_Companion_Manifest::bust_cache();
		$GLOBALS['x_lite_transients'][ $key ] = array_merge( $first, array( 'generated_at' => 'SERVED-FROM-CACHE' ) );
		$registry->seed( $snapshot );

		$second = X_Companion_Manifest::get_manifest();
		x_assert_same( 'SERVED-FROM-CACHE', $second['generated_at'], 'unchanged registry serves the cached body' );
		x_assert_same( $first['fingerprint'], $second['fingerprint'], 'fingerprint identical across two consecutive requests' );

		// Installing a block moves the fingerprint, so the key moves too.
		$grown                      = $snapshot;
		$grown['agent/testimonial'] = array(
			'title'       => 'Testimonial',
			'category'    => 'text',
			'api_version' => 3,
			'attributes'  => array( 'quote' => array( 'type' => 'string' ) ),
			'is_dynamic'  => true,
		);

		X_Companion_Manifest::bust_cache();
		$registry->seed( $grown );

		$third = X_Companion_Manifest::get_manifest();
		x_assert( $third['fingerprint'] !== $first['fingerprint'], 'a new block moves the epoch' );
		x_assert_same( 'SERVED-FROM-CACHE' !== $third['generated_at'], true, 'the heavy body was rebuilt' );
		x_assert( isset( $third['blocks']['agent/testimonial'] ), 'installed agent blocks appear automatically' );

		X_Companion_Manifest::bust_cache();
		$registry->seed( $snapshot );
	}
);

x_test(
	'GET /fingerprint does not build the heavy manifest body',
	function () use ( $snapshot ) {
		$registry = WP_Block_Type_Registry::get_instance();
		if ( ! method_exists( $registry, 'seed' ) ) {
			x_assert( true, 'skipped under a live registry' );

			return;
		}

		$registry->seed( $snapshot );
		X_Companion_Manifest::bust_cache();
		$GLOBALS['x_lite_transients'] = array();

		$fingerprint = X_Companion_Manifest::fingerprint();

		x_assert( 1 === preg_match( '/^[0-9a-f]{64}$/', $fingerprint ), 'fingerprint computed' );
		x_assert_same( array(), $GLOBALS['x_lite_transients'], 'no manifest transient was written' );
		x_assert_same( false, get_option( 'x_companion_manifest_cache_key' ), 'no manifest cache key was written' );

		X_Companion_Manifest::bust_cache();
	}
);

/*
 * ---------------------------------------------------------------------------
 * Live WordPress only
 * ---------------------------------------------------------------------------
 */

if ( ! X_COMPANION_LITE ) {
	x_test(
		'live: the manifest is built from the real registry',
		function () {
			$manifest = X_Companion_Manifest::get_manifest( true );

			x_assert( 1 === preg_match( '/^[0-9a-f]{64}$/', $manifest['fingerprint'] ), 'fingerprint shape' );
			x_assert( isset( $manifest['blocks']['core/paragraph'] ), 'core/paragraph is registered' );
			x_assert( $manifest['counts']['blocks'] > 20, 'a real instance registers more than 20 blocks' );
			x_assert_same( X_Companion_Manifest::fingerprint(), $manifest['fingerprint'], 'GET /fingerprint agrees with GET /manifest' );
			x_assert( in_array( $manifest['posture'], array( 'toolchain', 'production' ), true ), 'posture' );
			x_assert( '' !== $manifest['theme_tokens']['layout']['contentSize'], 'theme.json contentSize resolved' );
			x_assert( ! empty( $manifest['theme_tokens']['color']['palette'] ), 'theme.json palette resolved' );
		}
	);

	x_test(
		'live: two consecutive manifest requests are identical',
		function () {
			$first  = X_Companion_Manifest::get_manifest( true );
			$second = X_Companion_Manifest::get_manifest();

			x_assert_same( $first['fingerprint'], $second['fingerprint'], 'fingerprint stable' );
			x_assert_same( $first['blocks'], $second['blocks'], 'blocks stable' );
		}
	);

	x_test(
		'live: active plugins are discovered with versions',
		function () {
			$plugins = X_Companion_Manifest::active_plugins();
			$slugs   = array_column( $plugins, 'slug' );

			x_assert( in_array( 'x-companion', $slugs, true ), 'x-companion is active' );
		}
	);
}

exit( x_summary() );
