<?php
/**
 * POST /validate semantics.
 *
 * Runs two ways:
 *   php x-companion/tests/test-validator.php          (offline, no WordPress)
 *   loaded inside a real WP / Playground run          (ABSPATH already defined)
 *
 * Either way the assertions below are driven by fixtures/registry-snapshot.json
 * rather than the live registry, so the expected diagnostics stay exact.
 *
 * @package x-companion
 */

// Offline: bootstrap-lite stubs the WordPress APIs the validator touches and
// loads the plugin classes. Under a real WordPress every stub is skipped and
// only the assertion runner is contributed.
require_once __DIR__ . '/bootstrap-lite.php';

/**
 * The sentinel a tree fixture uses for "the epoch this instance is at".
 */
const X_EPOCH_SENTINEL = '__CURRENT_FINGERPRINT__';

/**
 * Reduce a Diagnostics document to the fields the fixtures pin.
 *
 * `message` is deliberately free text and is only checked for being non-empty.
 *
 * @param array $document  Diagnostics document.
 * @param array $expected  Expected diagnostics, used to decide whether to
 *                         compare fix_hint for a given entry.
 * @return array
 */
function x_project_diagnostics( array $document, array $expected ): array {
	$out = array();

	foreach ( $document['diagnostics'] as $index => $diagnostic ) {
		$entry = array(
			'code'     => $diagnostic['code'] ?? null,
			'severity' => $diagnostic['severity'] ?? null,
			'path'     => $diagnostic['path'] ?? null,
		);

		if ( array_key_exists( 'fix_hint', (array) ( $expected[ $index ] ?? array() ) ) ) {
			$entry['fix_hint'] = $diagnostic['fix_hint'] ?? null;
		}

		$out[] = $entry;
	}

	return $out;
}

x_suite( 'validator' );

$blocks      = x_fixture_blocks();
$fingerprint = X_Companion_Manifest::compute_fingerprint(
	X_Companion_Manifest::fingerprint_inputs(
		x_fixture( 'registry-snapshot.json' ),
		array(
			'slug'    => 'twentytwentyfive',
			'version' => '1.3',
		),
		array(
			array(
				'slug'    => 'x-companion',
				'version' => '1.0.0',
			),
		)
	)
);

x_test(
	'the snapshot fixture produced a usable blocks map',
	function () use ( $blocks ) {
		x_assert( count( $blocks ) >= 12, 'expected at least 12 blocks, got ' . count( $blocks ) );
		x_assert( isset( $blocks['core/column']['parent'] ) && array( 'core/columns' ) === $blocks['core/column']['parent'], 'core/column must declare parent core/columns' );
		x_assert( isset( $blocks['core/list-item']['parent'] ) && array( 'core/list' ) === $blocks['core/list-item']['parent'], 'core/list-item must declare parent core/list' );
		x_assert( isset( $blocks['core/button']['parent'] ) && array( 'core/buttons' ) === $blocks['core/button']['parent'], 'core/button must declare parent core/buttons' );
		x_assert( isset( $blocks['core/post-template']['ancestor'] ) && array( 'core/query' ) === $blocks['core/post-template']['ancestor'], 'core/post-template must declare ancestor core/query' );
		x_assert( true === $blocks['core/image']['is_dynamic'], 'core/image is dynamic (render.php for the lightbox)' );
		x_assert( false === $blocks['core/paragraph']['is_dynamic'], 'core/paragraph is static' );
	}
);

x_test(
	'the W_STATIC_NEEDS_HARNESS fix_hint is the exact contract string',
	function () {
		x_assert_same(
			'canonical markup must come from harness compile, do not hand-serialize',
			X_Companion_Validator::FIX_HINT_STATIC,
			'fix_hint drifted from CONTRACT.md section 5'
		);
	}
);

x_test(
	'the global attribute whitelist is exactly the contract list',
	function () {
		x_assert_same(
			array(
				'className',
				'style',
				'lock',
				'metadata',
				'align',
				'anchor',
				'backgroundColor',
				'textColor',
				'gradient',
				'fontSize',
				'fontFamily',
				'borderColor',
				'layout',
				'templateLock',
			),
			X_Companion_Validator::GLOBAL_ATTRIBUTES,
			'whitelist drifted from CONTRACT.md section 5'
		);
	}
);

/*
 * Fixture-driven: every tree in fixtures/trees/ against fixtures/expected/.
 */

$tree_files = glob( x_fixture_path( 'trees/*.json' ) );
sort( $tree_files );

x_test(
	'every diagnostic code in the contract has a fixture',
	function () use ( $tree_files ) {
		x_assert( count( $tree_files ) >= 12, 'expected at least 12 tree fixtures, found ' . count( $tree_files ) );
		x_assert( in_array( x_fixture_path( 'trees/valid-core.json' ), $tree_files, true ), 'valid-core.json is required by the harness milestone too' );
	}
);

$covered = array();

foreach ( $tree_files as $tree_file ) {
	$name = basename( $tree_file, '.json' );

	x_test(
		'fixture ' . $name,
		function () use ( $name, $blocks, $fingerprint, &$covered ) {
			$tree     = x_fixture( 'trees/' . $name . '.json' );
			$expected = x_fixture( 'expected/' . $name . '.json' );

			if ( ( $tree['epoch'] ?? null ) === X_EPOCH_SENTINEL ) {
				$tree['epoch'] = $fingerprint;
			}

			$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );

			x_assert_same( $expected['valid'], $document['valid'], $name . ': valid' );
			x_assert_same( $expected['epoch_ok'], $document['epoch_ok'], $name . ': epoch_ok' );
			x_assert_same( $fingerprint, $document['server_fingerprint'], $name . ': server_fingerprint is echoed back' );
			x_assert_same(
				$expected['diagnostics'],
				x_project_diagnostics( $document, $expected['diagnostics'] ),
				$name . ': diagnostics'
			);

			foreach ( $document['diagnostics'] as $diagnostic ) {
				$covered[ $diagnostic['code'] ] = true;
				x_assert( ! empty( $diagnostic['message'] ), $name . ': every diagnostic carries a message' );
			}

			// valid is true iff there are zero errors.
			$errors = 0;
			foreach ( $document['diagnostics'] as $diagnostic ) {
				if ( 'error' === $diagnostic['severity'] ) {
					++$errors;
				}
			}
			x_assert_same( 0 === $errors, $document['valid'], $name . ': valid iff zero errors' );
		}
	);
}

x_test(
	'the fixture set covers every code in the Diagnostics schema',
	function () use ( &$covered ) {
		$all = array(
			'E_TREE_SCHEMA',
			'E_UNKNOWN_BLOCK',
			'E_ATTR_TYPE',
			'E_ATTR_ENUM',
			'E_NEST_PARENT',
			'E_NEST_ANCESTOR',
			'E_EPOCH_MISMATCH',
			'W_ATTR_UNKNOWN',
			'W_STATIC_NEEDS_HARNESS',
			'W_HINT_ALLOWED_BLOCKS',
			'W_HINT_TEMPLATE_LOCK',
		);

		$missing = array_values( array_diff( $all, array_keys( $covered ) ) );
		x_assert_same( array(), $missing, 'codes with no fixture coverage' );
	}
);

/*
 * Targeted semantics that fixtures alone would not pin down.
 */

x_test(
	'E_TREE_SCHEMA stops all further checks',
	function () use ( $blocks, $fingerprint ) {
		$tree = array(
			'version' => 1,
			'epoch'   => 'stale',
			'blocks'  => array(
				array(
					'name'       => 'core/paragraph',
					'innerHTML'  => '<p>x</p>',
					'attributes' => array( 'level' => 'not-a-number' ),
				),
				array( 'name' => 'acme/nope' ),
			),
		);

		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );
		$codes    = array_column( $document['diagnostics'], 'code' );

		x_assert_same( array( 'E_TREE_SCHEMA' ), array_values( array_unique( $codes ) ), 'only schema errors survive' );
		x_assert_same( false, $document['valid'], 'schema failure is never valid' );
		x_assert_same( false, $document['epoch_ok'], 'epoch_ok is still reported' );
	}
);

x_test(
	'a non-object body is E_TREE_SCHEMA at /',
	function () use ( $blocks, $fingerprint ) {
		foreach ( array( null, 'a string', array( 1, 2, 3 ) ) as $body ) {
			$document = X_Companion_Validator::validate( $body, $blocks, $fingerprint );
			x_assert_same(
				array(
					array(
						'code'     => 'E_TREE_SCHEMA',
						'severity' => 'error',
						'path'     => '/',
					),
				),
				x_project_diagnostics( $document, array( array(), array() ) ),
				'non-object body'
			);
		}
	}
);

x_test(
	'E_EPOCH_MISMATCH does not stop the other checks',
	function () use ( $blocks ) {
		$tree = array(
			'version' => 1,
			'epoch'   => 'stale-epoch',
			'blocks'  => array(
				array( 'name' => 'core/column' ),
			),
		);

		$document = X_Companion_Validator::validate( $tree, $blocks, 'current-epoch' );
		$codes    = array_column( $document['diagnostics'], 'code' );

		x_assert( in_array( 'E_EPOCH_MISMATCH', $codes, true ), 'epoch error present' );
		x_assert( in_array( 'E_NEST_PARENT', $codes, true ), 'nesting still checked' );
		x_assert( in_array( 'W_STATIC_NEEDS_HARNESS', $codes, true ), 'static warning still emitted' );
		x_assert_same( false, $document['epoch_ok'], 'epoch_ok false' );
		x_assert_same( false, $document['valid'], 'valid false' );
	}
);

x_test(
	'attribute type may be declared as an array of types',
	function () {
		x_assert( X_Companion_Validator::type_matches( 'all', array( 'string', 'boolean' ) ), 'string matches string|boolean' );
		x_assert( X_Companion_Validator::type_matches( false, array( 'string', 'boolean' ) ), 'false matches string|boolean' );
		x_assert( ! X_Companion_Validator::type_matches( 3, array( 'string', 'boolean' ) ), 'integer does not match string|boolean' );
		x_assert( ! X_Companion_Validator::type_matches( true, 'number' ), 'boolean is not a number' );
		x_assert( X_Companion_Validator::type_matches( 2, 'number' ), 'integer is a number' );
		x_assert( X_Companion_Validator::type_matches( 2.5, 'number' ), 'float is a number' );
		x_assert( ! X_Companion_Validator::type_matches( 2.5, 'integer' ), 'a fractional float is not an integer' );
		x_assert( X_Companion_Validator::type_matches( null, 'null' ), 'null matches null' );
		x_assert( X_Companion_Validator::type_matches( array( 1, 2 ), 'array' ), 'a list is an array' );
		x_assert( ! X_Companion_Validator::type_matches( array( 'a' => 1 ), 'array' ), 'a map is not an array' );
		x_assert( X_Companion_Validator::type_matches( array( 'a' => 1 ), 'object' ), 'a map is an object' );
		x_assert( X_Companion_Validator::type_matches( 'anything', 'rich-text' ), 'unknown types carry no shape information and are not checked' );
	}
);

x_test(
	'no source-based HTML attribute semantics are applied',
	function () use ( $blocks, $fingerprint ) {
		// core/button.url is source:attribute; a plain string must pass cleanly.
		$tree     = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array(
				array(
					'name'        => 'core/buttons',
					'innerBlocks' => array(
						array(
							'name'       => 'core/button',
							'attributes' => array(
								'url'  => 'not a url at all',
								'text' => '<em>rich</em> text',
							),
						),
					),
				),
			),
		);
		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );
		$codes    = array_column( $document['diagnostics'], 'code' );

		x_assert_same( array( 'W_STATIC_NEEDS_HARNESS', 'W_STATIC_NEEDS_HARNESS' ), $codes, 'only the static warnings' );
		x_assert_same( true, $document['valid'], 'valid' );
	}
);

x_test(
	'RFC 6901 escaping is applied to attribute keys',
	function () use ( $blocks, $fingerprint ) {
		$tree     = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array(
				array(
					'name'       => 'core/paragraph',
					'attributes' => array( 'a/b~c' => 1 ),
				),
			),
		);
		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );

		x_assert_same( '/blocks/0/attributes/a~1b~0c', $document['diagnostics'][0]['path'], 'pointer token escaped' );
	}
);

x_test(
	'a block with parent[] at the tree root is E_NEST_PARENT',
	function () use ( $blocks, $fingerprint ) {
		$tree     = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array( array( 'name' => 'core/list-item' ) ),
		);
		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );

		x_assert_same( 'E_NEST_PARENT', $document['diagnostics'][0]['code'], 'root placement is a parent violation' );
		x_assert_same( '/blocks/0', $document['diagnostics'][0]['path'], 'reported at the node pointer' );
	}
);

x_test(
	'W_STATIC_NEEDS_HARNESS is emitted once per distinct block name',
	function () use ( $blocks, $fingerprint ) {
		$tree = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array(
				array( 'name' => 'core/paragraph' ),
				array( 'name' => 'core/paragraph' ),
				array( 'name' => 'core/paragraph' ),
			),
		);

		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );
		x_assert_same( 1, count( $document['diagnostics'] ), 'exactly one warning for three paragraphs' );
		x_assert_same( '/blocks/0', $document['diagnostics'][0]['path'], 'reported at the first node of that name' );
	}
);

x_test(
	'validator state does not leak between runs',
	function () use ( $blocks, $fingerprint ) {
		$tree = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array( array( 'name' => 'core/paragraph' ) ),
		);

		$first  = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );
		$second = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );

		x_assert_same( $first, $second, 'two identical runs produce identical documents' );
	}
);

x_test(
	'a body decoded with objects preserved behaves identically',
	function () use ( $blocks, $fingerprint ) {
		$json = (string) file_get_contents( x_fixture_path( 'trees/valid-core.json' ) );
		$json = str_replace( X_EPOCH_SENTINEL, $fingerprint, $json );

		$as_arrays  = X_Companion_Validator::validate( json_decode( $json, true ), $blocks, $fingerprint );
		$as_objects = X_Companion_Validator::validate( json_decode( $json ), $blocks, $fingerprint );

		x_assert_same( $as_arrays, $as_objects, 'json_decode assoc and object modes agree' );
	}
);

x_test(
	'empty JSON objects are not mistaken for empty arrays',
	function () use ( $blocks, $fingerprint ) {
		// This is what POST /validate feeds the validator: json_decode without
		// assoc, so {} is stdClass and [] is a PHP list.
		$cases = array(
			'{"version":1,"epoch":"E","blocks":{}}'                                  => '/blocks',
			'{"version":1,"epoch":"E","blocks":[{"name":"core/group","innerBlocks":{}}]}' => '/blocks/0/innerBlocks',
		);

		foreach ( $cases as $json => $pointer ) {
			$tree     = json_decode( str_replace( '"E"', json_encode( $fingerprint ), $json ) );
			$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );

			x_assert_same( 'E_TREE_SCHEMA', $document['diagnostics'][0]['code'] ?? null, $json . ': code' );
			x_assert_same( $pointer, $document['diagnostics'][0]['path'] ?? null, $json . ': path' );
		}

		// ...and an empty array where an array belongs is fine.
		$ok = X_Companion_Validator::validate(
			json_decode( '{"version":1,"epoch":' . json_encode( $fingerprint ) . ',"blocks":[]}' ),
			$blocks,
			$fingerprint
		);
		x_assert_same( array(), $ok['diagnostics'], 'an empty tree is a valid tree' );
		x_assert_same( true, $ok['valid'], 'an empty tree is valid' );
	}
);

/*
 * ---------------------------------------------------------------------------
 * interfaces v2 diagnostics: styles + bindings
 * ---------------------------------------------------------------------------
 */

x_test(
	'W_STYLE_UNKNOWN flags an unregistered is-style-* only when the block has server-side styles',
	function () use ( $blocks, $fingerprint ) {
		$with_styles = $blocks;
		$with_styles['core/group']['styles'] = array(
			array(
				'name'   => 'section-1',
				'label'  => 'Section 1',
				'source' => 'theme',
			),
		);

		$tree = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array(
				array(
					'name'       => 'core/group',
					'attributes' => array( 'className' => 'is-style-section-99 extra-class' ),
				),
				array(
					'name'       => 'core/paragraph',
					'attributes' => array( 'className' => 'is-style-rounded' ),
				),
			),
		);

		$document = X_Companion_Validator::validate( $tree, $with_styles, $fingerprint );
		$style_diags = array_values(
			array_filter(
				$document['diagnostics'],
				static function ( $d ) {
					return 'W_STYLE_UNKNOWN' === $d['code'];
				}
			)
		);

		x_assert_same( 1, count( $style_diags ), 'exactly one style warning' );
		x_assert_same( '/blocks/0/attributes/className', $style_diags[0]['path'], 'points at the group className' );
		x_assert_same( true, $document['valid'], 'a style warning does not invalidate the tree' );

		$ok = X_Companion_Validator::validate(
			array(
				'version' => 1,
				'epoch'   => $fingerprint,
				'blocks'  => array(
					array(
						'name'       => 'core/group',
						'attributes' => array( 'className' => 'is-style-section-1' ),
					),
				),
			),
			$with_styles,
			$fingerprint
		);
		x_assert_same( array(), array_filter( $ok['diagnostics'], static fn( $d ) => 'W_STYLE_UNKNOWN' === $d['code'] ), 'a registered style passes clean' );
	}
);

x_test(
	'E_BINDING_UNKNOWN and E_BINDING_UNBINDABLE, with the platform context',
	function () use ( $blocks, $fingerprint ) {
		$platform = array(
			'binding_sources' => array( 'core/post-meta', 'core/pattern-overrides' ),
			'bindable'        => array( 'core/paragraph' => array( 'content' ) ),
		);

		$tree = array(
			'version' => 1,
			'epoch'   => $fingerprint,
			'blocks'  => array(
				array(
					'name'       => 'core/paragraph',
					'attributes' => array(
						'metadata' => array(
							'bindings' => array(
								'content' => array(
									'source' => 'acme/nonexistent',
									'args'   => array( 'key' => 'x' ),
								),
							),
						),
					),
				),
				array(
					'name'       => 'core/paragraph',
					'attributes' => array(
						'metadata' => array(
							'bindings' => array(
								'placeholder' => array(
									'source' => 'core/post-meta',
									'args'   => array( 'key' => 'x' ),
								),
							),
						),
					),
				),
				array(
					'name'       => 'core/paragraph',
					'attributes' => array(
						'metadata' => array(
							'bindings' => array(
								'content' => array(
									'source' => 'core/post-meta',
									'args'   => array( 'key' => 'pickup_day' ),
								),
							),
						),
					),
				),
			),
		);

		$document = X_Companion_Validator::validate( $tree, $blocks, $fingerprint, $platform );
		$codes    = array_column( $document['diagnostics'], 'code', 'path' );

		x_assert_same( 'E_BINDING_UNKNOWN', $codes['/blocks/0/attributes/metadata/bindings/content'] ?? null, 'unknown source is an error' );
		x_assert_same( 'E_BINDING_UNBINDABLE', $codes['/blocks/1/attributes/metadata/bindings/placeholder'] ?? null, 'unbindable attribute is an error' );
		x_assert( ! isset( $codes['/blocks/2/attributes/metadata/bindings/content'] ), 'a registered source on a bindable attribute passes' );
		x_assert_same( false, $document['valid'], 'binding errors invalidate the tree' );

		// Without platform context (offline / v1) binding checks are skipped.
		$skipped = X_Companion_Validator::validate( $tree, $blocks, $fingerprint );
		x_assert_same(
			array(),
			array_filter( $skipped['diagnostics'], static fn( $d ) => in_array( $d['code'], array( 'E_BINDING_UNKNOWN', 'E_BINDING_UNBINDABLE' ), true ) ),
			'no binding diagnostics without a platform context'
		);
	}
);

x_test(
	'compile_css accepts clean css, itemizes markup rejections, never drops silently',
	function () {
		$out = X_Companion_Theme_Tokens::compile_css(
			array(
				'css' => array(
					'global' => ':root { --hc-rhythm: 1.5rem; }',
					'blocks' => array(
						'core/button' => '.wp-block-button__link { letter-spacing: 0.02em; }',
						'core/quote'  => '<script>alert(1)</script>',
					),
				),
			)
		);

		x_assert_same( ':root { --hc-rhythm: 1.5rem; }', $out['styles']['css'] ?? null, 'global css accepted' );
		x_assert_same( '.wp-block-button__link { letter-spacing: 0.02em; }', $out['styles']['blocks']['core/button']['css'] ?? null, 'block css accepted' );
		x_assert_same( 1, count( $out['rejected'] ), 'one rejection' );
		x_assert_same( 'core/quote', $out['rejected'][0]['target'], 'rejection names the target' );
		x_assert( ! isset( $out['styles']['blocks']['core/quote'] ), 'rejected css is not written' );

		$none = X_Companion_Theme_Tokens::compile_css( array( 'palette' => array() ) );
		x_assert_same( array(), $none['styles'], 'no css section, no styles fragment' );
	}
);

if ( ! X_COMPANION_LITE ) {
	x_test(
		'live: validate_request runs against the real registry',
		function () {
			$fingerprint = X_Companion_Manifest::fingerprint();
			$document    = X_Companion_Validator::validate_request(
				array(
					'version' => 1,
					'epoch'   => $fingerprint,
					'blocks'  => array( array( 'name' => 'core/paragraph', 'attributes' => array( 'content' => 'hi' ) ) ),
				)
			);

			x_assert_same( true, $document['epoch_ok'], 'live epoch matches' );
			x_assert_same( true, $document['valid'], 'a core paragraph is valid on a live instance' );
		}
	);
}

exit( x_summary() );
