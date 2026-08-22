<?php
/**
 * Pure-PHP test harness. No WordPress, no Composer, no Docker.
 *
 * The fingerprint canonicaliser and the Tree IR validator are pure functions
 * of a registry snapshot, so they are unit-testable with the system `php`.
 * This file supplies the handful of WordPress APIs the plugin classes touch
 * at load time, plus a minimal assertion runner.
 *
 * It is safe to load under a real WordPress too: every stub is
 * function_exists()/class_exists()/defined() guarded, so in that context it
 * contributes only the assertion runner and the fixture loaders. That is what
 * lets tests/test-manifest.php and tests/test-validator.php be the same file
 * offline and inside Playground.
 *
 * @package x-companion
 */

/*
 * ---------------------------------------------------------------------------
 * WordPress stubs
 * ---------------------------------------------------------------------------
 */

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', dirname( __DIR__ ) . '/' );
	define( 'X_COMPANION_LITE', true );
}

if ( ! defined( 'X_COMPANION_LITE' ) ) {
	define( 'X_COMPANION_LITE', false );
}

if ( ! defined( 'MINUTE_IN_SECONDS' ) ) {
	define( 'MINUTE_IN_SECONDS', 60 );
}
if ( ! defined( 'HOUR_IN_SECONDS' ) ) {
	define( 'HOUR_IN_SECONDS', 60 * MINUTE_IN_SECONDS );
}
if ( ! defined( 'DAY_IN_SECONDS' ) ) {
	define( 'DAY_IN_SECONDS', 24 * HOUR_IN_SECONDS );
}

if ( ! defined( 'X_COMPANION_DIR' ) ) {
	define( 'X_COMPANION_DIR', dirname( __DIR__ ) . '/' );
}
if ( ! defined( 'X_COMPANION_INTERFACES_VERSION' ) ) {
	define( 'X_COMPANION_INTERFACES_VERSION', '1' );
}
if ( ! defined( 'X_COMPANION_POSTURE' ) ) {
	define( 'X_COMPANION_POSTURE', 'toolchain' );
}
if ( ! defined( 'X_COMPANION_ALLOW_STATIC_BLOCKS' ) ) {
	define( 'X_COMPANION_ALLOW_STATIC_BLOCKS', false );
}

$GLOBALS['x_lite_filters']    = array();
$GLOBALS['x_lite_options']    = array();
$GLOBALS['x_lite_transients'] = array();
$GLOBALS['x_lite_theme']      = array(
	'slug'    => 'twentytwentyfive',
	'version' => '1.3',
);

if ( ! function_exists( 'x_companion_posture' ) ) {
	/**
	 * Posture resolver.
	 *
	 * @return string
	 */
	function x_companion_posture(): string {
		return ( 'toolchain' === X_COMPANION_POSTURE ) ? 'toolchain' : 'production';
	}
}

if ( ! function_exists( 'x_companion_extend_enabled' ) ) {
	/**
	 * Extend tier availability.
	 *
	 * @return bool
	 */
	function x_companion_extend_enabled(): bool {
		return 'toolchain' === x_companion_posture();
	}
}

if ( ! function_exists( 'add_filter' ) ) {
	/**
	 * Minimal filter registry.
	 *
	 * @param string   $tag           Hook name.
	 * @param callable $callback      Callback.
	 * @param int      $priority      Priority.
	 * @param int      $accepted_args Accepted args.
	 * @return bool
	 */
	function add_filter( $tag, $callback, $priority = 10, $accepted_args = 1 ) {
		$GLOBALS['x_lite_filters'][ $tag ][ $priority ][] = array( $callback, $accepted_args );
		ksort( $GLOBALS['x_lite_filters'][ $tag ] );

		return true;
	}
}

if ( ! function_exists( 'add_action' ) ) {
	/**
	 * Actions are filters.
	 *
	 * @param string   $tag           Hook name.
	 * @param callable $callback      Callback.
	 * @param int      $priority      Priority.
	 * @param int      $accepted_args Accepted args.
	 * @return bool
	 */
	function add_action( $tag, $callback, $priority = 10, $accepted_args = 1 ) {
		return add_filter( $tag, $callback, $priority, $accepted_args );
	}
}

if ( ! function_exists( 'apply_filters' ) ) {
	/**
	 * Apply registered filters.
	 *
	 * @param string $tag   Hook name.
	 * @param mixed  $value Value.
	 * @param mixed  ...$args Extra args.
	 * @return mixed
	 */
	function apply_filters( $tag, $value, ...$args ) {
		if ( empty( $GLOBALS['x_lite_filters'][ $tag ] ) ) {
			return $value;
		}

		foreach ( $GLOBALS['x_lite_filters'][ $tag ] as $callbacks ) {
			foreach ( $callbacks as $entry ) {
				list( $callback, $accepted ) = $entry;
				$params                      = array_merge( array( $value ), $args );
				$params                      = array_slice( $params, 0, max( 1, (int) $accepted ) );
				$value                       = call_user_func_array( $callback, $params );
			}
		}

		return $value;
	}
}

if ( ! function_exists( 'remove_all_filters' ) ) {
	/**
	 * Drop every callback on a hook.
	 *
	 * @param string $tag Hook name.
	 * @return bool
	 */
	function remove_all_filters( $tag ) {
		unset( $GLOBALS['x_lite_filters'][ $tag ] );

		return true;
	}
}

if ( ! function_exists( 'wp_json_encode' ) ) {
	/**
	 * json_encode with WordPress's signature.
	 *
	 * @param mixed $data  Data.
	 * @param int   $flags Flags.
	 * @param int   $depth Depth.
	 * @return string|false
	 */
	function wp_json_encode( $data, $flags = 0, $depth = 512 ) {
		return json_encode( $data, $flags, $depth ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode
	}
}

if ( ! function_exists( 'get_option' ) ) {
	/**
	 * Option read.
	 *
	 * @param string $name    Option name.
	 * @param mixed  $default Default.
	 * @return mixed
	 */
	function get_option( $name, $default = false ) {
		return array_key_exists( $name, $GLOBALS['x_lite_options'] ) ? $GLOBALS['x_lite_options'][ $name ] : $default;
	}
}

if ( ! function_exists( 'update_option' ) ) {
	/**
	 * Option write.
	 *
	 * @param string $name     Option name.
	 * @param mixed  $value    Value.
	 * @param mixed  $autoload Ignored.
	 * @return bool
	 */
	function update_option( $name, $value, $autoload = null ) {
		$GLOBALS['x_lite_options'][ $name ] = $value;

		return true;
	}
}

if ( ! function_exists( 'delete_option' ) ) {
	/**
	 * Option delete.
	 *
	 * @param string $name Option name.
	 * @return bool
	 */
	function delete_option( $name ) {
		unset( $GLOBALS['x_lite_options'][ $name ] );

		return true;
	}
}

if ( ! function_exists( 'get_site_option' ) ) {
	/**
	 * Network option read.
	 *
	 * @param string $name    Option name.
	 * @param mixed  $default Default.
	 * @return mixed
	 */
	function get_site_option( $name, $default = false ) {
		return get_option( $name, $default );
	}
}

if ( ! function_exists( 'get_transient' ) ) {
	/**
	 * Transient read.
	 *
	 * @param string $name Transient name.
	 * @return mixed
	 */
	function get_transient( $name ) {
		return array_key_exists( $name, $GLOBALS['x_lite_transients'] ) ? $GLOBALS['x_lite_transients'][ $name ] : false;
	}
}

if ( ! function_exists( 'set_transient' ) ) {
	/**
	 * Transient write.
	 *
	 * @param string $name       Transient name.
	 * @param mixed  $value      Value.
	 * @param int    $expiration Ignored.
	 * @return bool
	 */
	function set_transient( $name, $value, $expiration = 0 ) {
		$GLOBALS['x_lite_transients'][ $name ] = $value;

		return true;
	}
}

if ( ! function_exists( 'delete_transient' ) ) {
	/**
	 * Transient delete.
	 *
	 * @param string $name Transient name.
	 * @return bool
	 */
	function delete_transient( $name ) {
		unset( $GLOBALS['x_lite_transients'][ $name ] );

		return true;
	}
}

if ( ! function_exists( 'is_multisite' ) ) {
	/**
	 * Single site.
	 *
	 * @return bool
	 */
	function is_multisite() {
		return false;
	}
}

if ( ! function_exists( '__' ) ) {
	/**
	 * Passthrough translation.
	 *
	 * @param string $text   Text.
	 * @param string $domain Ignored.
	 * @return string
	 */
	function __( $text, $domain = 'default' ) { // phpcs:ignore Universal.NamingConventions.NoReservedKeywordParameterNames.textFound
		return $text;
	}
}

if ( ! function_exists( 'wp_get_global_settings' ) ) {
	/**
	 * Stub global settings, shaped like Twenty Twenty-Five's.
	 *
	 * @param array $path    Ignored.
	 * @param array $context Ignored.
	 * @return array
	 */
	function wp_get_global_settings( $path = array(), $context = array() ) {
		return array(
			'color'      => array(
				'palette' => array(
					'theme' => array(
						array(
							'slug'  => 'base',
							'name'  => 'Base',
							'color' => '#f9f9f9',
						),
						array(
							'slug'  => 'contrast',
							'name'  => 'Contrast',
							'color' => '#111111',
						),
					),
				),
			),
			'spacing'    => array(
				'spacingSizes' => array(
					'theme' => array(
						array(
							'slug' => '20',
							'size' => '10px',
							'name' => '1',
						),
						array(
							'slug' => '30',
							'size' => '20px',
							'name' => '2',
						),
					),
				),
				'spacingScale' => array( 'steps' => 0 ),
			),
			'typography' => array(
				'fontSizes'    => array( 'theme' => array( array( 'slug' => 'small', 'size' => '0.875rem', 'name' => 'Small' ) ) ),
				'fontFamilies' => array( 'theme' => array( array( 'slug' => 'body', 'name' => 'Body', 'fontFamily' => 'Manrope, sans-serif' ) ) ),
			),
			'layout'     => array(
				'contentSize' => '645px',
				'wideSize'    => '1340px',
			),
		);
	}
}

if ( ! function_exists( 'get_bloginfo' ) ) {
	/**
	 * Site info stub.
	 *
	 * @param string $show Requested field.
	 * @return string
	 */
	function get_bloginfo( $show = '' ) {
		return ( 'version' === $show ) ? '6.5' : 'X Companion Test Site';
	}
}

if ( ! function_exists( 'get_site_url' ) ) {
	/**
	 * Site URL stub.
	 *
	 * @return string
	 */
	function get_site_url() {
		return 'https://x-companion.test';
	}
}

if ( ! class_exists( 'WP_Theme' ) ) {
	/**
	 * Minimal WP_Theme stand-in.
	 */
	class WP_Theme {

		/**
		 * Stylesheet directory name.
		 *
		 * @return string
		 */
		public function get_stylesheet() {
			return $GLOBALS['x_lite_theme']['slug'] ?? 'twentytwentyfive';
		}

		/**
		 * Header accessor.
		 *
		 * @param string $header Header name.
		 * @return string
		 */
		public function get( $header ) {
			if ( 'Version' === $header ) {
				return $GLOBALS['x_lite_theme']['version'] ?? '1.3';
			}

			return '';
		}
	}
}

if ( ! function_exists( 'wp_get_theme' ) ) {
	/**
	 * Active theme stub.
	 *
	 * @return WP_Theme
	 */
	function wp_get_theme() {
		return new WP_Theme();
	}
}

if ( ! class_exists( 'WP_Block_Type' ) ) {
	/**
	 * Minimal WP_Block_Type stand-in, enough for the agent_hints filter's third argument.
	 */
	class WP_Block_Type {

		/**
		 * Block name.
		 *
		 * @var string
		 */
		public $name = '';

		/**
		 * Block title.
		 *
		 * @var string
		 */
		public $title = '';

		/**
		 * Block category.
		 *
		 * @var string|null
		 */
		public $category = null;

		/**
		 * Block API version.
		 *
		 * @var int
		 */
		public $api_version = 1;

		/**
		 * Attributes.
		 *
		 * @var array
		 */
		public $attributes = array();

		/**
		 * Supports.
		 *
		 * @var array
		 */
		public $supports = array();

		/**
		 * Parent block names.
		 *
		 * @var array|null
		 */
		public $parent = null;

		/**
		 * Ancestor block names.
		 *
		 * @var array|null
		 */
		public $ancestor = null;

		/**
		 * Provided context.
		 *
		 * @var array
		 */
		public $provides_context = array();

		/**
		 * Consumed context.
		 *
		 * @var array
		 */
		public $uses_context = array();

		/**
		 * Variations.
		 *
		 * @var array
		 */
		public $variations = array();

		/**
		 * Render callback.
		 *
		 * @var callable|null
		 */
		public $render_callback = null;

		/**
		 * Construct from a snapshot entry.
		 *
		 * @param string $name    Block name.
		 * @param array  $payload Snapshot entry.
		 */
		public function __construct( $name = '', array $payload = array() ) {
			$this->name = (string) $name;
			foreach ( $payload as $key => $value ) {
				if ( property_exists( $this, $key ) ) {
					$this->$key = $value;
				}
			}
			if ( ! empty( $payload['is_dynamic'] ) ) {
				$this->render_callback = '__return_empty_string';
			}
		}

		/**
		 * Attributes accessor.
		 *
		 * @return array
		 */
		public function get_attributes() {
			return is_array( $this->attributes ) ? $this->attributes : array();
		}

		/**
		 * Dynamic block test.
		 *
		 * @return bool
		 */
		public function is_dynamic() {
			return is_callable( $this->render_callback );
		}
	}
}

if ( ! class_exists( 'WP_Block_Type_Registry' ) ) {
	/**
	 * Minimal registry stand-in, seeded from a snapshot fixture.
	 */
	class WP_Block_Type_Registry {

		/**
		 * Singleton.
		 *
		 * @var WP_Block_Type_Registry|null
		 */
		private static $instance = null;

		/**
		 * Registered types.
		 *
		 * @var array<string,WP_Block_Type>
		 */
		private $types = array();

		/**
		 * Singleton accessor.
		 *
		 * @return WP_Block_Type_Registry
		 */
		public static function get_instance() {
			if ( null === self::$instance ) {
				self::$instance = new self();
			}

			return self::$instance;
		}

		/**
		 * Seed from a snapshot fixture.
		 *
		 * @param array $snapshot name => snapshot entry.
		 * @return void
		 */
		public function seed( array $snapshot ) {
			$this->types = array();
			foreach ( $snapshot as $name => $payload ) {
				$this->types[ (string) $name ] = new WP_Block_Type( (string) $name, (array) $payload );
			}
		}

		/**
		 * Registered types.
		 *
		 * @return array<string,WP_Block_Type>
		 */
		public function get_all_registered() {
			return $this->types;
		}
	}
}

/*
 * ---------------------------------------------------------------------------
 * Plugin classes under test
 * ---------------------------------------------------------------------------
 */

foreach ( array( 'class-manifest.php', 'class-validator.php', 'class-platform.php', 'class-theme-tokens.php' ) as $x_lite_include ) {
	$x_lite_path = dirname( __DIR__ ) . '/includes/' . $x_lite_include;
	if ( file_exists( $x_lite_path ) ) {
		require_once $x_lite_path;
	}
}

/*
 * ---------------------------------------------------------------------------
 * Assertion runner
 * ---------------------------------------------------------------------------
 */

if ( ! function_exists( 'x_test_state' ) ) {
	/**
	 * Shared mutable test state.
	 *
	 * @return array
	 */
	function &x_test_state(): array {
		static $state = array(
			'suite'    => '',
			'passed'   => 0,
			'failed'   => 0,
			'current'  => '',
			'failures' => array(),
		);

		return $state;
	}

	/**
	 * Name the suite.
	 *
	 * @param string $name Suite name.
	 * @return void
	 */
	function x_suite( string $name ): void {
		$state          = &x_test_state();
		$state['suite'] = $name;
		echo "\n== {$name} ==\n";
	}

	/**
	 * Run one test case.
	 *
	 * @param string   $name Case name.
	 * @param callable $body Body.
	 * @return void
	 */
	function x_test( string $name, callable $body ): void {
		$state            = &x_test_state();
		$state['current'] = $name;
		$before           = $state['failed'];

		try {
			$body();
		} catch ( Throwable $e ) {
			x_fail( 'threw ' . get_class( $e ) . ': ' . $e->getMessage() );
		}

		$ok = ( $state['failed'] === $before );
		echo ( $ok ? '  PASS  ' : '  FAIL  ' ) . $name . "\n";
	}

	/**
	 * Record a failure.
	 *
	 * @param string $message Message.
	 * @return void
	 */
	function x_fail( string $message ): void {
		$state = &x_test_state();
		++$state['failed'];
		$state['failures'][] = $state['current'] . ': ' . $message;
		echo '        -> ' . $message . "\n";
	}

	/**
	 * Record a pass.
	 *
	 * @return void
	 */
	function x_pass(): void {
		$state = &x_test_state();
		++$state['passed'];
	}

	/**
	 * Assert truthiness.
	 *
	 * @param bool   $condition Condition.
	 * @param string $message   Message.
	 * @return void
	 */
	function x_assert( bool $condition, string $message ): void {
		if ( $condition ) {
			x_pass();

			return;
		}
		x_fail( $message );
	}

	/**
	 * Assert deep equality, compared as canonical JSON.
	 *
	 * @param mixed  $expected Expected.
	 * @param mixed  $actual   Actual.
	 * @param string $message  Message.
	 * @return void
	 */
	function x_assert_same( $expected, $actual, string $message ): void {
		$e = json_encode( $expected, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode
		$a = json_encode( $actual, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PARTIAL_OUTPUT_ON_ERROR ); // phpcs:ignore WordPress.WP.AlternativeFunctions.json_encode_json_encode

		if ( $e === $a ) {
			x_pass();

			return;
		}

		x_fail( $message . "\n           expected: " . $e . "\n           actual:   " . $a );
	}

	/**
	 * Print the summary and return the process exit code.
	 *
	 * @return int
	 */
	function x_summary(): int {
		$state = &x_test_state();
		$total = $state['passed'] + $state['failed'];

		echo "\n----------------------------------------\n";
		if ( 0 === $state['failed'] ) {
			echo "PASS  {$state['suite']}: {$state['passed']}/{$total} assertions passed\n";

			return 0;
		}

		echo "FAIL  {$state['suite']}: {$state['failed']} of {$total} assertions failed\n";
		foreach ( $state['failures'] as $failure ) {
			echo '  - ' . $failure . "\n";
		}

		return 1;
	}

	/**
	 * Absolute path to a fixture.
	 *
	 * @param string $relative Path below fixtures/.
	 * @return string
	 */
	function x_fixture_path( string $relative ): string {
		return dirname( __DIR__ ) . '/fixtures/' . ltrim( $relative, '/' );
	}

	/**
	 * Load and decode a fixture.
	 *
	 * @param string $relative Path below fixtures/.
	 * @return array
	 */
	function x_fixture( string $relative ): array {
		$path = x_fixture_path( $relative );

		if ( ! file_exists( $path ) ) {
			throw new RuntimeException( 'Missing fixture: ' . $path );
		}

		$decoded = json_decode( (string) file_get_contents( $path ), true ); // phpcs:ignore WordPress.WP.AlternativeFunctions.file_get_contents_file_get_contents

		if ( ! is_array( $decoded ) ) {
			throw new RuntimeException( 'Fixture is not valid JSON: ' . $path . ' (' . json_last_error_msg() . ')' );
		}

		return $decoded;
	}

	/**
	 * The offline registry snapshot, as the manifest's blocks map.
	 *
	 * @return array
	 */
	function x_fixture_blocks(): array {
		return X_Companion_Manifest::build_blocks( x_fixture( 'registry-snapshot.json' ) );
	}
}
